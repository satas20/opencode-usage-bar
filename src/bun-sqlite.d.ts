/**
 * Minimal ambient types for the Bun built-in the plugin uses to read
 * opencode's v2 credential store. The opencode TUI always runs under Bun, so
 * pulling in the full `@types/bun` package just for this surface is not worth
 * it. Only what `opencodeConsoleCredential()` calls is declared here.
 */
declare module "bun:sqlite" {
  export class Database {
    constructor(path: string, options?: { readonly?: boolean; create?: boolean })
    query<Row = unknown>(sql: string): {
      get(...params: unknown[]): Row | null
    }
    close(): void
  }
}
