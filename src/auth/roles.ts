/**
 * Role vocabulary — a dependency-free leaf so it can be imported anywhere
 * (services, the department registry, and the operator UI's parity test)
 * without dragging in credential/crypto code. `src/auth/users.ts` re-exports
 * these for existing callers.
 */
export const ROLES = ["admin", "operator", "finance", "support", "readonly"] as const;
export type Role = (typeof ROLES)[number];
