/**
 * `import.meta.glob` is a Vite transform, and the frozen eval fixtures are
 * loaded with it so adding a scenario means adding a file — not a file plus a
 * line in an index that somebody will forget.
 *
 * Declared here rather than by pulling in `vite/client`, whose types also
 * introduce a DOM lib that would conflict with `@cloudflare/workers-types`.
 */
interface ImportMeta {
  glob<T = unknown>(
    pattern: string,
    options?: { eager?: boolean; import?: string },
  ): Record<string, T>;
}
