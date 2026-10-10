// Local entrypoint for running straight from a checkout (no build step):
// opencode V2 resolves a directory plugin by looking for a root `tui.*` file,
// so this forwards to the single-file source. See CONTRIBUTING.md.
export { default } from "./src/index"
