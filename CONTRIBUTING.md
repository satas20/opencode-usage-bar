# Contributing to opencode-usage-bar

Thanks for your interest! This is a small, focused plugin — the whole thing is
one file (`src/index.tsx`), so most contributions are quick to make and quick
to review.

## Prerequisites

- [Bun](https://bun.sh) (opencode's runtime; also used for the build)
- [opencode](https://opencode.ai) >= 2.0 to test the TUI integration

## Setup

```sh
git clone https://github.com/satas20/opencode-usage-bar.git
cd opencode-usage-bar
bun install
```

## Development loop

You don't need a build step during development — opencode transpiles `.tsx`
plugins on the fly. Point your `cli.json` at your working copy (the root
`tui.tsx` forwards to `src/index.tsx`):

```jsonc
// ~/.config/opencode/cli.json
{
  "$schema": "https://opencode.ai/v2/cli.json",
  "plugins": ["/absolute/path/to/opencode-usage-bar"]
}
```

Then restart opencode after each change (plugins are loaded once at startup).
The plugin's own config lives in `~/.config/opencode/usage-bar.toml` — enable
the providers you have credentials for.

Before opening a PR, make sure both gates pass:

```sh
bun run typecheck   # tsc --noEmit
bun run build       # bundles dist/index.js + emits dist/index.d.ts
```

## Project layout

| Path | Purpose |
|---|---|
| `tui.tsx` | Local entrypoint for checkouts (forwards to `src/index.tsx`) |
| `src/index.tsx` | The entire plugin: types, providers, config, TUI render |
| `build.ts` | `Bun.build` bundling (Solid transform, externals) |
| `dist/` | Build output, published to npm (gitignored) |

Inside `src/index.tsx`, top to bottom: helpers → opencode auth store fallback
→ providers → config (TOML defaults, parsing, loading) → the `tui` plugin
function (polling + rendering).

## Adding a provider

The most valuable contribution! Each provider is a small object implementing:

```ts
type Provider = {
  id: ProviderId          // add your id to the ProviderId union
  short: string           // 3-letter prefix, e.g. "cld", "oai"
  statusUrl?: string      // optional: a Statuspage-style status.json endpoint
  fetchUsage(cfg: ProviderConfig): Promise<UsageWindow[] | null>
}
```

Checklist:

1. Add the id to the `ProviderId` union.
2. Implement the provider object; return `UsageWindow[]` (each window has a
   `category` of `"5h" | "7d" | "model" | "month"`, a `percent` 0–100, and
   `resetsAt` epoch ms) or `null` when credentials are missing/expired or the
   fetch fails. Add `hasCredentials()` when a signed-out provider must clear
   its cached windows instead of keeping the last known values.
3. Add it to the `providers` array.
4. Add a section to `DEFAULT_TOML`, an entry in `defaultConfig()`, and any
   provider-specific keys to `parseConfig()`.
5. Document it in the README's config example and providers table.

Ground rules for providers:

- **Read-only credentials.** Never write, refresh, or rewrite another tool's
  auth files. If a token is expired, return `null` — the provider simply hides.
- **Tokens go only to their own vendor's API host**, over HTTPS. No third-party
  hosts, no telemetry, nothing else.
- **Fail silently.** Any error → `null`. The bar must never break the TUI.
- **Be gentle with endpoints.** These are undocumented/internal APIs that
  throttle aggressive polling; the shared poll loop (2 min + backoff) already
  handles cadence — don't add extra requests per poll.

## Pull requests

- Keep PRs small and focused (one fix/feature per PR).
- Commit style: `feat: ...`, `fix: ...`, `docs: ...`, `chore: ...`.
- Describe how you tested (which providers/plans you ran it against, or that
  you verified the fallback paths).
- CI runs `typecheck` + `build` on every PR; both must pass.

## Reporting bugs

Open an issue at
[github.com/satas20/opencode-usage-bar/issues](https://github.com/satas20/opencode-usage-bar/issues)
with your opencode version, plugin version, `usage-bar.toml` (it contains no
secrets), and what the bar showed vs. what you expected.
