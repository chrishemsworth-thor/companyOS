#!/usr/bin/env node
// Seeds a tenant into the local D1 database for `wrangler dev` testing.
// Only the SHA-256 hash of the API key is ever stored (matches
// src/gateway/middleware/auth.ts), so this script is the only place the
// plaintext key is shown — copy it now.
import { createHash, randomBytes, pbkdf2Sync } from "node:crypto";
import { execFileSync } from "node:child_process";

function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : fallback;
}

const tenantId = arg("--tenant-id", "biz_abc123");
const tenantName = arg("--name", "Test SME");
// Human-friendly workspace slug used at the operator-console login (migration
// 0012). Login now takes workspace + email + password.
const tenantSlug = arg("--slug", "test-sme");
const apiKey = arg("--api-key", `local_${randomBytes(16).toString("hex")}`);
// First human operator, so the UI login screen is usable out of the box.
const adminEmail = arg("--admin-email", "admin@example.com");
const adminPassword = arg("--admin-password", "companyos-admin");

const apiKeyHash = createHash("sha256").update(apiKey).digest("hex");

// PBKDF2 params must match src/auth/password.ts (100k iters, SHA-256, 32-byte key).
const PWD_ITER = 100_000;
const pwdSalt = randomBytes(16);
const pwdHash = pbkdf2Sync(adminPassword, pwdSalt, PWD_ITER, 32, "sha256").toString("hex");
// Deterministic id from (tenant, email) so re-seeding replaces the same row
// (resetting the password) instead of colliding on the unique email index.
const adminUserId =
  "usr_" + createHash("sha256").update(`${tenantId}:${adminEmail}`).digest("hex").slice(0, 24);

const esc = (s) => s.replace(/'/g, "''");
const sql = [
  "INSERT OR REPLACE INTO tenants (tenant_id, name, slug, api_key_hash) VALUES " +
    `('${tenantId}', '${esc(tenantName)}', '${esc(tenantSlug)}', '${apiKeyHash}');`,
  "INSERT OR REPLACE INTO users (user_id, tenant_id, email, display_name, role, pwd_hash, pwd_salt, pwd_iter) VALUES " +
    `('${adminUserId}', '${tenantId}', '${esc(adminEmail)}', 'Seed Admin', 'admin', '${pwdHash}', '${pwdSalt.toString("hex")}', ${PWD_ITER});`,
].join("\n");

execFileSync("npx", ["wrangler", "d1", "execute", "companyos-db", "--local", "--command", sql], {
  stdio: "inherit",
});

console.log("\nSeeded local tenant:");
console.log(`  tenant_id: ${tenantId}`);
console.log(`  slug:      ${tenantSlug}  (the workspace you log in with)`);
console.log(`  api_key:   ${apiKey}  (plaintext — only shown here, only the hash is stored)`);
console.log("\nOperator console login (http://localhost:5173):");
console.log(`  workspace: ${tenantSlug}`);
console.log(`  email:     ${adminEmail}`);
console.log(`  password:  ${adminPassword}`);
console.log(
  "\nCreate additional companies at runtime via the internal provisioning API:\n" +
    "  POST /admin/tenants  (Authorization: Bearer <PLATFORM_ADMIN_SECRET>)",
);
console.log("\nTry the vertical slice:");
console.log(`curl -X POST http://localhost:8787/v1/invoices \\
  -H "Authorization: Bearer ${apiKey}" \\
  -H "Content-Type: application/json" \\
  -d '{"customer_id":"cust_456","currency":"MYR","due_date":"2026-06-26","lines":[{"description":"Consulting","quantity":1,"unit_cents":450000}]}'`);
