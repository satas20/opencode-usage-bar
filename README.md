# opencode-usage-bar

[npm](https://www.npmjs.com/package/@satas/opencode-usage-bar) · [source](https://github.com/satas20/opencode-usage-bar)

An AI subscription usage gauge for the [opencode](https://opencode.ai) TUI.

Shows how much of your coding-plan quota you've used and how long until it
resets, in a full-width row just below the session footer. Supports
**Claude Pro/Max** and **ChatGPT Plus/Pro (Codex)** — each optional, each
with per-window toggles.

```
┌─ opencode session ────────────────────────────────────┐
│ ...                                                   │
│ > _                                                   │
│ Build · Claude Fable 5      ▓▓▓▓░░░░░░ 4/5 · todo bar │
│ esc interrupt        119.8K (12%) · $4.04  ctrl+p     │
│ ▓▓▓▓░░ 65% · 0h 11m                                   │
└───────────────────────────────────────────────────────┘
```

With multiple windows/providers enabled:

```
cld ▓▓▓▓░ 65% · 0h 11m  7d ▓░░░░ 19% · 1d 11h   oai ▓░░░░ 12% · 3h 4m
```

When a provider's public status page reports an active incident, a colored
`!` marker appears next to its prefix:

```
! cld ▓▓▓▓░ 65% · 0h 11m          (Anthropic incident — usage bar unchanged)
```

- Bar color escalates with usage: **green** < 50%, **amber** 50–85%,
  **red** > 85%.
- **Provider status** — a `!` marker (red = major/critical, amber = minor,
  cyan = maintenance) shows next to a provider during an active incident, read
  from the vendor's own status page. Disable with `show_status = false`.
- The countdown ticks live; usage refreshes every 2 minutes (with backoff on
  failures — these endpoints throttle aggressive polling).
- Last known values are cached, so the bar appears instantly on restart.
- Providers hide silently when credentials are missing/expired or a fetch
  fails; the whole row hides when nothing is available.
- Provider prefixes (`cld`/`oai`) appear only when two or more providers
  are visible; window labels (`5h`/`7d`/…) appear only when a provider shows
  two or more windows.

## Install

### Recommended (npm)

```sh
opencode plugin add @satas/opencode-usage-bar
```

This installs the package via Bun, detects the TUI entrypoint, and adds it to
your global `cli.json` automatically.

Or add it manually:

```jsonc
// ~/.config/opencode/cli.json
{
  "$schema": "https://opencode.ai/v2/cli.json",
  "plugins": ["@satas/opencode-usage-bar"]
}
```

### Local checkout (no build needed)

opencode transpiles `.tsx` plugins on the fly, so you can point `cli.json`
straight at a checkout — its root `tui.tsx` forwards to `src/index.tsx`:

```jsonc
// ~/.config/opencode/cli.json
{
  "$schema": "https://opencode.ai/v2/cli.json",
  "plugins": ["/absolute/path/to/opencode-usage-bar"]
}
```

## Configuration

On first run the plugin creates `~/.config/opencode/usage-bar.toml` with
commented defaults (Claude enabled, 5-hour window only — matching the
screenshot above). Edit it and restart opencode; the config is read once at
startup.

```toml
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
```

## Providers & data sources

| Provider | Credentials (first match wins) | Usage endpoint | Status endpoint | Windows |
|---|---|---|---|---|
| `anthropic` | Claude Code's `~/.claude/.credentials.json` → opencode's auth store | `api.anthropic.com/api/oauth/usage` | `status.anthropic.com` | 5h session, 7d all-models, 7d per-model |
| `openai` | Codex CLI's `~/.codex/auth.json` → opencode's auth store | `chatgpt.com/backend-api/wham/usage` | `status.openai.com` | 5h session, 7d weekly |

If you log in through opencode itself (`opencode auth login`), everything works
with zero extra setup — the plugin falls back to opencode's own auth store
(`<data dir>/auth.json`, e.g. `~/.local/share/opencode/auth.json`). All
credential access is **read-only**; expired tokens simply hide the provider
until the owning CLI refreshes them.

**Security note:** each credential is read from disk/env and sent **only** to
its own provider's API host, over HTTPS, to fetch usage numbers. The status
check hits each vendor's public status page with no credentials at all.
Nothing else is read, stored, or transmitted. Both usage endpoints are
undocumented/internal (the same ones the vendors' own tooling uses) and may
change without notice.

## Develop

```sh
bun install      # dev deps (solid-js, @opencode/plugin, @opentui/solid, tsc)
bun run build    # emit dist/index.js + dist/index.d.ts (for npm publish)
bun run typecheck
```

Publishing: `npm publish` (the `prepublishOnly` script runs the build
automatically).

## Roadmap

- GLM coding plan (z.ai) provider.
- Anthropic/OpenAI OAuth token auto-refresh (both credential files include a
  refresh token; for now the respective CLIs keep them fresh).

## Requirements

- opencode >= 2.0 (TUI plugin API, `@opencode/plugin/tui`)
- Bun runtime (used by opencode; `Bun.TOML` parses the config)

## Contributing

Contributions welcome — especially new providers (see the checklist in
[CONTRIBUTING.md](CONTRIBUTING.md)). The whole plugin is a single file, and
opencode transpiles `.tsx` on the fly, so you can hack on it with no build
step.

## License

MIT
