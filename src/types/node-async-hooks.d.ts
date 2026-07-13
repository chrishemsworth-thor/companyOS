// Minimal ambient types for the subset of node:async_hooks we use. The runtime
// implementation is provided by the `nodejs_als` compatibility flag (see
// wrangler.jsonc); this avoids pulling all of @types/node (and its global
// namespace) into a Workers project that otherwise uses @cloudflare/workers-types.
declare module "node:async_hooks" {
  export class AsyncLocalStorage<T> {
    getStore(): T | undefined;
    run<R>(store: T, callback: () => R): R;
  }
}
