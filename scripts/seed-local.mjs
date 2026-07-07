#!/usr/bin/env node
// Seeds a tenant into the local D1 database for `wrangler dev` testing.
// Only the SHA-256 hash of the API key is ever stored (matches
// src/gateway/middleware/auth.ts), so this script is the only place the
// plaintext key is shown — copy it now.
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";

function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : fallback;
}

const tenantId = arg("--tenant-id", "biz_abc123");
const tenantName = arg("--name", "Test SME");
const apiKey = arg("--api-key", `local_${randomBytes(16).toString("hex")}`);

const apiKeyHash = createHash("sha256").update(apiKey).digest("hex");

const sql =
  "INSERT OR REPLACE INTO tenants (tenant_id, name, api_key_hash) VALUES " +
  `('${tenantId}', '${tenantName.replace(/'/g, "''")}', '${apiKeyHash}');`;

execFileSync("npx", ["wrangler", "d1", "execute", "companyos-db", "--local", "--command", sql], {
  stdio: "inherit",
});

console.log("\nSeeded local tenant:");
console.log(`  tenant_id: ${tenantId}`);
console.log(`  api_key:   ${apiKey}  (plaintext — only shown here, only the hash is stored)`);
console.log("\nPopulate it with sample data across every module:");
console.log(`  npm run seed:sample -- --api-key ${apiKey}`);
console.log("\n...or try the vertical slice by hand:");
console.log(`curl -X POST http://localhost:8787/v1/invoices \\
  -H "Authorization: Bearer ${apiKey}" \\
  -H "Content-Type: application/json" \\
  -d '{"customer_id":"cust_456","currency":"MYR","due_date":"2026-06-26","lines":[{"description":"Consulting","quantity":1,"unit_cents":450000}]}'`);
