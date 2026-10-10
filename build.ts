import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin"

const result = await Bun.build({
  entrypoints: ["src/index.tsx"],
  outdir: "dist",
  target: "bun",
  format: "esm",
  sourcemap: "none",
  external: [
    "solid-js",
    "solid-js/*",
    "@opencode/plugin",
    "@opencode/plugin/*",
    "@opentui/solid",
    "@opentui/solid/*",
    "@opentui/core",
    "@opentui/core/*",
    "@opentui/keymap",
    "@opentui/keymap/*",
  ],
  plugins: [createSolidTransformPlugin()],
})

if (!result.success) {
  for (const log of result.logs) {
    console.error(log)
  }
  process.exit(1)
}
