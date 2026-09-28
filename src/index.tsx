/**
 * usage-bar — AI subscription usage gauge for the opencode TUI.
 *
 * Renders a compact usage strip in the `app` slot — a full-width row at the
 * bottom of the interface, below the session footer:
 *
 *   ▓▓▓▓░░ 65% · 0h 11m                                  (one window)
 *   cld ▓▓▓▓░ 65% · 0h 11m  7d ▓░░░░ 19% · 1d 11h   oai ▓░░░░ 12% · 3h 4m
 *   ! cld ▓▓▓▓░ 65% · 0h 11m                             (anthropic incident)
 *
 * Providers:
 *   anthropic — Claude Pro/Max via the OAuth token in ~/.claude/.credentials.json
 *   openai    — ChatGPT Plus/Pro via the Codex CLI login in ~/.codex/auth.json
 *
 * When a provider's public status page reports an incident, a colored `!`
 * marker appears next to its prefix (red = major/critical, amber = minor,
 * cyan = maintenance). The usage bar itself is unaffected. Disable with
 * `show_status = false` under `[ui]`.
 *
 * Configured via ~/.config/opencode/usage-bar.toml (auto-created with
 * commented defaults on first run; read once at startup). Tokens/keys are
 * only ever sent to their own provider's API host.
 *
 * Loaded via cli.json (opencode v2), e.g.:
 *   { "plugins": ["@satas/opencode-usage-bar"] }        // published npm package
 *   { "plugins": ["/abs/path/to/opencode-usage-bar"] }  // local checkout (no build)
 */
import { Plugin, usePlugin } from "@opencode/plugin/tui"
import { createMemo, createSignal, For, Show } from "solid-js"
import { readFile, writeFile, mkdir } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { Buffer } from "node:buffer"

const POLL_MS = 120_000
const FETCH_TIMEOUT_MS = 10_000
const CONFIG_FILE = "usage-bar.toml"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Which quota window a value belongs to; toggled per provider in config. */
type WindowCategory = "5h" | "7d" | "model"

/** Provider health from the vendor's public status page (Statuspage schema). */
type StatusIndicator = "none" | "minor" | "major" | "critical" | "maintenance"

type UsageWindow = {
  category: WindowCategory
  /** short display label, e.g. "5h", "7d", "Fable" */
  label: string
  /** 0–100 percent of the window used */
  percent: number
  /** epoch ms when the window resets */
  resetsAt: number
}

type ProviderId = "anthropic" | "openai"

type ProviderConfig = {
  enabled: boolean
  show: Record<WindowCategory, boolean>
  /** anthropic: path to .credentials.json */
  credentialsPath?: string
  /** openai: path to Codex auth.json */
  codexAuthPath?: string
}

type UsageBarConfig = {
  showBars: boolean
  showStatus: boolean
  barWidth?: number
  providers: Record<ProviderId, ProviderConfig>
}

type Provider = {
  id: ProviderId
  /** short prefix shown when multiple providers are visible */
  short: string
  /** vendor status page JSON endpoint (Statuspage `status.json`); optional */
  statusUrl?: string
  fetchUsage(cfg: ProviderConfig): Promise<UsageWindow[] | null>
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function expandTilde(p: string) {
  return p === "~" ? homedir() : p.startsWith("~/") ? join(homedir(), p.slice(2)) : p
}

/** opencode's global config directory (XDG-aware, matching opencode itself). */
function configDir() {
  return process.env.XDG_CONFIG_HOME
    ? join(process.env.XDG_CONFIG_HOME, "opencode")
    : join(homedir(), ".config", "opencode")
}

/** opencode's global data directory (XDG-aware, matching opencode itself). */
function stateDir() {
  return process.env.XDG_DATA_HOME
    ? join(process.env.XDG_DATA_HOME, "opencode")
    : join(homedir(), ".local", "share", "opencode")
}

function fmtDuration(ms: number) {
  const totalMinutes = Math.max(0, Math.ceil(ms / 60_000))
  const days = Math.floor(totalMinutes / 1440)
  const hours = Math.floor((totalMinutes % 1440) / 60)
  const minutes = totalMinutes % 60
  if (days > 0) return `${days}d ${hours}h`
  return `${hours}h ${minutes}m`
}

/** Decode a JWT's `exp` claim (unix seconds) without verifying. 0 on failure. */
function jwtExp(token: string): number {
  try {
    const payload = token.split(".")[1]
    if (!payload) return 0
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      exp?: number
    }
    return typeof claims.exp === "number" ? claims.exp : 0
  } catch {
    return 0
  }
}

async function fetchJson(url: string, headers: Record<string, string>): Promise<unknown | null> {
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

/** Fetch a vendor's overall status from its public Statuspage JSON endpoint.
 *  Returns the `indicator` ("none" when healthy), or `null` when the fetch
 *  itself failed — so a network blip never clears a known incident. */
async function fetchStatus(url: string): Promise<StatusIndicator | null> {
  const data = (await fetchJson(url, {})) as {
    status?: { indicator?: string }
  } | null
  if (!data?.status) return null
  const indicator = data.status.indicator
  return indicator === "minor" ||
    indicator === "major" ||
    indicator === "critical" ||
    indicator === "maintenance"
    ? indicator
    : "none"
}

// ---------------------------------------------------------------------------
// opencode auth store (fallback credential source)
// ---------------------------------------------------------------------------

type OpencodeAuthEntry = {
  type?: string
  access?: string
  expires?: number // epoch ms; 0 = no expiry
  accountId?: string
}

/** opencode's own auth store (`opencode auth login`); XDG-aware default. */
let opencodeAuthFile = join(stateDir(), "auth.json")

/** Read a provider's entry from opencode's own auth store
 *  (`opencode auth login`). Returns null when missing/unreadable. */
async function opencodeAuth(...ids: string[]): Promise<OpencodeAuthEntry | null> {
  try {
    const auth = JSON.parse(await readFile(opencodeAuthFile, "utf8")) as Record<
      string,
      OpencodeAuthEntry
    >
    for (const id of ids) {
      const entry = auth[id]
      if (entry) return entry
    }
    return null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

/** Claude Pro/Max — Anthropic's OAuth usage endpoint (same one Claude Code's
 *  `/usage` uses). Token from ~/.claude/.credentials.json, falling back to
 *  opencode's own auth store; sent only to api.anthropic.com. */
const anthropicProvider: Provider = {
  id: "anthropic",
  short: "cld",
  statusUrl: "https://status.anthropic.com/api/v2/status.json",
  async fetchUsage(cfg) {
    let token: string | undefined
    try {
      const path = expandTilde(cfg.credentialsPath ?? join(homedir(), ".claude", ".credentials.json"))
      const creds = JSON.parse(await readFile(path, "utf8")) as {
        claudeAiOauth?: { accessToken?: string; expiresAt?: number }
      }
      const oauth = creds.claudeAiOauth
      if (oauth?.accessToken && !(oauth.expiresAt && Date.now() >= oauth.expiresAt))
        token = oauth.accessToken
    } catch {
      // fall through to opencode auth
    }
    if (!token) {
      const entry = await opencodeAuth("anthropic")
      if (entry?.access && !(entry.expires && Date.now() >= entry.expires)) token = entry.access
    }
    if (!token) return null

    const data = (await fetchJson("https://api.anthropic.com/api/oauth/usage", {
      authorization: `Bearer ${token}`,
      "anthropic-beta": "oauth-2025-04-20",
    })) as {
      limits?: Array<{
        kind?: string
        percent?: number
        resets_at?: string
        scope?: { model?: { display_name?: string | null } | null } | null
      }>
    } | null
    if (!data || !Array.isArray(data.limits)) return null

    const windows: UsageWindow[] = []
    for (const limit of data.limits) {
      if (!limit || typeof limit.percent !== "number" || !Number.isFinite(limit.percent)) continue
      if (!limit.kind || !limit.resets_at) continue
      const resetsAt = Date.parse(limit.resets_at)
      if (Number.isNaN(resetsAt)) continue
      const category: WindowCategory =
        limit.kind === "session" ? "5h" : limit.kind === "weekly_all" ? "7d" : "model"
      const label =
        category === "model" ? (limit.scope?.model?.display_name ?? "model") : category
      windows.push({ category, label, percent: limit.percent, resetsAt })
    }
    // Session window first, then the rest in API order.
    windows.sort((a, b) => Number(b.category === "5h") - Number(a.category === "5h"))
    return windows.length > 0 ? windows : null
  },
}

/** ChatGPT Plus/Pro (Codex) — reads the Codex CLI login and asks the wham
 *  usage endpoint. Read-only: never refreshes/rewrites auth.json; when the
 *  token is expired we simply hide (Codex CLI refreshes the file itself). */
const openaiProvider: Provider = {
  id: "openai",
  short: "oai",
  statusUrl: "https://status.openai.com/api/v2/status.json",
  async fetchUsage(cfg) {
    let accessToken: string | undefined
    let accountId: string | undefined
    try {
      const path = expandTilde(cfg.codexAuthPath ?? join(homedir(), ".codex", "auth.json"))
      const auth = JSON.parse(await readFile(path, "utf8")) as {
        tokens?: { access_token?: string; id_token?: string; account_id?: string }
      }
      const tokens = auth.tokens
      // Check the expiry of the token we actually send (the access token);
      // the id_token expires much earlier and would cause false negatives.
      const exp = tokens?.access_token ? jwtExp(tokens.access_token) : 0
      if (tokens?.access_token && !(exp > 0 && exp * 1000 <= Date.now() + 60_000)) {
        accessToken = tokens.access_token
        accountId = tokens.account_id
      }
    } catch {
      // fall through to opencode auth
    }
    if (!accessToken) {
      const entry = await opencodeAuth("openai")
      if (entry?.access && !(entry.expires && Date.now() >= entry.expires)) {
        accessToken = entry.access
        accountId = entry.accountId
      }
    }
    if (!accessToken) return null

    const headers: Record<string, string> = {
      authorization: `Bearer ${accessToken}`,
      "user-agent": "codex-cli",
    }
    if (accountId) headers["chatgpt-account-id"] = accountId

    const data = (await fetchJson("https://chatgpt.com/backend-api/wham/usage", headers)) as {
      rate_limit?: {
        primary_window?: WhamWindow | null
        secondary_window?: WhamWindow | null
      }
    } | null
    if (!data?.rate_limit) return null

    // Classify by window duration when present (some accounts return the
    // weekly window as primary_window), falling back to position.
    const windows: UsageWindow[] = []
    const primary = parseWhamWindow(data.rate_limit.primary_window, "5h")
    if (primary) windows.push(primary)
    const secondary = parseWhamWindow(data.rate_limit.secondary_window, "7d")
    if (secondary) windows.push(secondary)
    windows.sort((a, b) => Number(b.category === "5h") - Number(a.category === "5h"))
    return windows.length > 0 ? windows : null
  },
}

type WhamWindow = {
  used_percent?: number
  limit_window_seconds?: number
  reset_at?: number
  reset_after_seconds?: number
}

function parseWhamWindow(
  w: WhamWindow | null | undefined,
  fallback: WindowCategory,
): UsageWindow | null {
  if (!w || typeof w.used_percent !== "number" || !Number.isFinite(w.used_percent)) return null
  let resetsAt: number | undefined
  if (typeof w.reset_at === "number") resetsAt = w.reset_at * 1000
  else if (typeof w.reset_after_seconds === "number")
    resetsAt = Date.now() + w.reset_after_seconds * 1000
  if (!resetsAt || !Number.isFinite(resetsAt)) return null
  const category: WindowCategory =
    typeof w.limit_window_seconds === "number" && w.limit_window_seconds > 0
      ? w.limit_window_seconds <= 21_600 // ≤ 6h → session window
        ? "5h"
        : "7d"
      : fallback
  return { category, label: category, percent: w.used_percent, resetsAt }
}

const providers: Provider[] = [anthropicProvider, openaiProvider]

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DEFAULT_TOML = `# opencode-usage-bar configuration
# Read once at startup — restart opencode after editing.

[ui]
show_bars = true      # render ▓▓░░ mini-bars (false = text only)
show_status = true    # show a ! marker next to a provider during incidents
# bar_width = 6       # override bar width (default: 6 for a single window, 5 otherwise)

[anthropic]
enabled = true        # Claude Pro/Max via ~/.claude/.credentials.json
show_5h = true        # rolling 5-hour session window
show_7d = false       # weekly cap across all models
show_model = false    # per-model weekly windows (e.g. Fable)
# credentials_path = "~/.claude/.credentials.json"

[openai]
enabled = false       # ChatGPT Plus/Pro via the Codex CLI login
show_5h = true
show_7d = false
# codex_auth_path = "~/.codex/auth.json"
`

function defaultConfig(): UsageBarConfig {
  const show = (over: Partial<Record<WindowCategory, boolean>> = {}) => ({
    "5h": true,
    "7d": false,
    model: false,
    ...over,
  })
  return {
    showBars: true,
    showStatus: true,
    providers: {
      anthropic: { enabled: true, show: show() },
      openai: { enabled: false, show: show() },
    },
  }
}

type TomlTable = Record<string, unknown>

function asTable(v: unknown): TomlTable {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as TomlTable) : {}
}

function bool(v: unknown, fallback: boolean) {
  return typeof v === "boolean" ? v : fallback
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined
}

function parseConfig(raw: string): UsageBarConfig {
  const toml = (globalThis as Record<string, any>).Bun?.TOML
  if (!toml?.parse) return defaultConfig()
  const root = asTable(toml.parse(raw))
  const cfg = defaultConfig()

  const ui = asTable(root["ui"])
  cfg.showBars = bool(ui["show_bars"], cfg.showBars)
  cfg.showStatus = bool(ui["show_status"], cfg.showStatus)
  const rawWidth = ui["bar_width"]
  if (typeof rawWidth === "number" && Number.isFinite(rawWidth) && rawWidth >= 1)
    cfg.barWidth = Math.min(40, Math.floor(rawWidth))

  for (const id of ["anthropic", "openai"] as ProviderId[]) {
    const t = asTable(root[id])
    const p = cfg.providers[id]
    p.enabled = bool(t["enabled"], p.enabled)
    p.show["5h"] = bool(t["show_5h"], p.show["5h"])
    p.show["7d"] = bool(t["show_7d"], p.show["7d"])
    p.show.model = bool(t["show_model"], p.show.model)
    p.credentialsPath = str(t["credentials_path"])
    p.codexAuthPath = str(t["codex_auth_path"])
  }
  return cfg
}

/** Load `<config dir>/usage-bar.toml`, creating it with commented defaults on
 *  first run. Any failure falls back to defaults without touching an existing
 *  file. */
async function loadConfig(dir: string): Promise<UsageBarConfig> {
  const file = join(dir, CONFIG_FILE)

  try {
    const raw = await readFile(file, "utf8")
    try {
      return parseConfig(raw)
    } catch {
      return defaultConfig() // malformed TOML — keep the file, use defaults
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      try {
        await mkdir(dir, { recursive: true })
        await writeFile(file, DEFAULT_TOML, { flag: "wx" })
      } catch {
        // ignore — config stays default in memory
      }
    }
    return defaultConfig()
  }
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export default Plugin.define({
  id: "opencode-usage-bar",
  async setup(context) {
    opencodeAuthFile = join(stateDir(), "auth.json")
    const config = await loadConfig(configDir())

    const enabled = providers.filter((p) => config.providers[p.id].enabled)
    if (enabled.length === 0) return // nothing to poll or render

    // Durable, plugin-scoped storage (survives restarts, synced across TUIs).
    const [cached, setCached] = context.storage.store<Record<string, UsageWindow[]>>("windows", {
      initial: {},
    })

    const seed: Record<string, UsageWindow[]> = {}
    for (const p of enabled) {
      const windows = cached[p.id]
      if (windows?.length) seed[p.id] = windows.map((w) => ({ ...w }))
    }
    const [byProvider, setByProvider] = createSignal<Record<string, UsageWindow[]>>(seed)
    // Status is deliberately not cached across restarts: incidents are
    // short-lived, and the first poll lands seconds after startup anyway.
    const [byStatus, setByStatus] = createSignal<Record<string, StatusIndicator>>({})
    const [now, setNow] = createSignal(Date.now())

    let disposed = false
    const timers = new Set<ReturnType<typeof setTimeout>>()
    const later = (fn: () => void, ms: number) => {
      const timer = setTimeout(() => {
        timers.delete(timer)
        fn()
      }, ms)
      timers.add(timer)
    }

    const ticker = setInterval(() => setNow(Date.now()), 1_000)

    for (const p of enabled) {
      const cfg = config.providers[p.id]
      const poll = async () => {
        if (disposed) return
        // Fetch usage and status concurrently; status pages are CDN-backed and
        // never throttle, so we poll them on the same cadence as usage.
        const statusP = config.showStatus && p.statusUrl ? fetchStatus(p.statusUrl) : null
        const [all, status] = await Promise.all([p.fetchUsage(cfg), statusP])
        if (disposed) return
        if (all) {
          const windows = all.filter((w) => cfg.show[w.category] && w.resetsAt > Date.now())
          setByProvider((prev) => ({ ...prev, [p.id]: windows }))
          void setCached((draft) => {
            draft[p.id] = windows
          })
        }
        // `null` means the status fetch failed — keep the last known indicator.
        if (status !== null) setByStatus((prev) => ({ ...prev, [p.id]: status }))
        // Back off when the usage fetch failed (e.g. 429 — these endpoints throttle).
        later(poll, all ? POLL_MS : POLL_MS * 3)
      }
      void poll()
    }

    function UsageBar() {
      const theme = usePlugin().theme

      type Group = { short: string; status: StatusIndicator; windows: UsageWindow[] }
      const groups = createMemo<Group[]>(() => {
        const map = byProvider()
        const statusMap = byStatus()
        const out: Group[] = []
        for (const p of enabled) {
          // Drop windows that have reset since the last poll.
          const windows = (map[p.id] ?? []).filter((w) => w.resetsAt > now())
          if (windows.length > 0)
            out.push({ short: p.short, status: statusMap[p.id] ?? "none", windows })
        }
        return out
      })
      const totalWindows = createMemo(() => groups().reduce((sum, g) => sum + g.windows.length, 0))
      const barWidth = createMemo(() => config.barWidth ?? (totalWindows() === 1 ? 6 : 5))
      const multiProvider = createMemo(() => groups().length >= 2)

      const pctOf = (w: UsageWindow) => Math.min(100, Math.max(0, Math.round(w.percent)))
      const filledOf = (w: UsageWindow) =>
        Math.min(barWidth(), Math.max(0, Math.round((pctOf(w) / 100) * barWidth())))
      const colorOf = (w: UsageWindow) => {
        const pct = pctOf(w)
        if (pct > 85) return theme.text.feedback.error.base
        if (pct >= 50) return theme.text.feedback.warning.base
        return theme.text.feedback.success.base
      }
      // Status marker color: red for severe incidents, amber for minor,
      // cyan for scheduled maintenance.
      const statusColor = (s: StatusIndicator) => {
        if (s === "critical" || s === "major") return theme.text.feedback.error.base
        if (s === "minor") return theme.text.feedback.warning.base
        return theme.text.feedback.info.base
      }

      return (
        <Show when={groups().length > 0}>
          {/* The `app` slot imposes no intrinsic height; pin the row to one line. */}
          <box
            flexDirection="row"
            gap={3}
            alignItems="center"
            width="100%"
            height={1}
            paddingLeft={1}
          >
            <For each={groups()}>
              {(g) => (
                <box flexDirection="row" gap={2} alignItems="center" flexShrink={0}>
                  <Show when={config.showStatus && g.status !== "none"}>
                    <text fg={statusColor(g.status)}>!</text>
                  </Show>
                  <Show when={multiProvider()}>
                    <text fg={theme.text.muted}>{g.short}</text>
                  </Show>
                  <For each={g.windows}>
                    {(w) => (
                      <box flexDirection="row" gap={1} alignItems="center" flexShrink={0}>
                        <Show when={g.windows.length >= 2}>
                          <text fg={theme.text.muted}>{w.label}</text>
                        </Show>
                        <Show when={config.showBars}>
                          <box flexDirection="row">
                            <text fg={colorOf(w)}>{"▓".repeat(filledOf(w))}</text>
                            <text fg={theme.text.muted}>
                              {"░".repeat(barWidth() - filledOf(w))}
                            </text>
                          </box>
                        </Show>
                        <text fg={theme.text.base}>{pctOf(w)}%</text>
                        <text fg={theme.text.muted}>· {fmtDuration(w.resetsAt - now())}</text>
                      </box>
                    )}
                  </For>
                </box>
              )}
            </For>
          </box>
        </Show>
      )
    }

    // `app` renders as a full-width row at the bottom of the TUI, below the
    // session footer — the v2 equivalent of v1's `app_bottom` slot.
    context.ui.slot({
      append: "app",
      render: () => <UsageBar />,
    })

    return () => {
      disposed = true
      clearInterval(ticker)
      for (const timer of timers) clearTimeout(timer)
      timers.clear()
    }
  },
})
