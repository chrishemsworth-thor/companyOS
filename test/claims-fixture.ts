import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/index";
import type { Env } from "../src/env";
import { sha256Hex } from "../src/gateway/middleware/auth";
import { createUser } from "../src/auth/users";
import { ensureClaimCategories } from "../src/modules/claims/categories";
import type { EventEnvelope } from "../src/schemas/envelope";

/**
 * Shared fixture for the three PRD-006a claim suites.
 *
 * Not a `*.test.ts` file, so vitest does not collect it (`vitest.config.ts`
 * includes `test/**\/*.test.ts` only).
 *
 * Isolated storage is on, so D1 writes made inside an `it` are rolled back before
 * the next one. Everything here is therefore called from `beforeAll`, which does
 * persist for a file — and each test file gets its own database, which is why the
 * ids below can be identical across files without colliding.
 *
 * The cast of characters is chosen to prove the capability story rather than to
 * be convenient:
 *
 *  - **filer** holds the `employee` role — `self` + `meta` and nothing else. If a
 *    claim can be filed, submitted and read by this login, PRD-006 works for the
 *    person it was written for.
 *  - **manager** also holds `employee`, and is the filer's reporting line. So the
 *    approver in these tests has no `finance`, `people` or `files` capability at
 *    all: whatever they can see, they can see because it is their decision.
 *  - **finance** exists to prove the reimbursement gate and the see-everything
 *    read rule.
 *  - **colleague** exists to prove an employee cannot read somebody else's claim.
 *  - **observer** holds `readonly`, which is the awkward one: a full business
 *    observer that holds `finance:read` *and* `self:write`. It must be able to
 *    read every claim and file its own, and must NOT be able to touch anybody
 *    else's.
 */

export const WORKSPACE = "claims-co";
export const TENANT_ID = "biz_claims";
export const API_KEY = "test_api_key_claims";

export const OTHER_WORKSPACE = "claims-other-co";
export const OTHER_TENANT_ID = "biz_claims_other";
export const OTHER_API_KEY = "test_api_key_claims_other";

export const ORIGIN = "http://localhost:5173";

/** Employee ids, fixed so tests can name them directly. */
export const EMP = {
  filer: "emp_clm_filer",
  manager: "emp_clm_manager",
  colleague: "emp_clm_colleague",
  observer: "emp_clm_observer",
} as const;

export const PROJECT_ID = "prj_clm_alpha";
export const OTHER_PROJECT_ID = "prj_clm_beta";

export type UserKey =
  | "admin"
  | "finance"
  | "manager"
  | "filer"
  | "colleague"
  | "observer"
  | "otherAdmin";

/** Filled in by `seedClaimsFixture`. */
export const user = {} as Record<UserKey, string>;

/** Category ids by code, filled in by `seedClaimsFixture`. */
export const category = {} as Record<string, string>;

export const PASSWORD: Record<UserKey, string> = {
  admin: "admin-password",
  finance: "finance-password",
  manager: "manager-password",
  filer: "filer-password",
  colleague: "colleague-password",
  observer: "observer-password",
  otherAdmin: "other-admin-password",
};

export const EMAIL: Record<UserKey, string> = {
  admin: "admin@claims.test",
  finance: "finance@claims.test",
  manager: "manager@claims.test",
  filer: "filer@claims.test",
  colleague: "colleague@claims.test",
  observer: "observer@claims.test",
  otherAdmin: "admin@claims-other.test",
};

/**
 * Events emitted by requests made through `fetchWorker`, newest last.
 *
 * Populated by the sink below. Call `clearWorkerEvents()` at the top of a test
 * that wants to assert on what one request emitted.
 */
export const workerEvents: EventEnvelope[] = [];

export function clearWorkerEvents(): void {
  workerEvents.length = 0;
}

/**
 * The env `fetchWorker` hands the Worker: the real bindings, but with the EVENTS
 * queue replaced by a recording sink.
 *
 * **This is required, not a convenience.** The test env has a real queue binding,
 * and the runtime delivers those messages to the consumer *after* the request that
 * sent them — which means after the `it` that made it. The consumer touches D1,
 * and touching D1 outside a test breaks the isolated-storage teardown with
 * "Failed to pop isolated storage stack frame". A suite that ends on a
 * claim approval is the case that trips it, because approval emits two events.
 *
 * Swapping in a sink also makes the emissions inspectable, which is the same
 * reason `capturingEnv()` exists for direct service calls.
 */
const sinkEnv: Env = {
  ...(env as unknown as Env),
  EVENTS: {
    async send(message: unknown) {
      workerEvents.push(message as EventEnvelope);
      return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
    },
    async sendBatch(messages: Iterable<MessageSendRequest<unknown>>) {
      for (const m of messages) workerEvents.push(m.body as EventEnvelope);
      return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
    },
  } as unknown as Queue,
};

export async function fetchWorker(path: string, init?: RequestInit): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`https://gateway.test${path}`, init), sinkEnv, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

export interface Session {
  cookie: string;
  csrf: string;
}

export async function login(key: UserKey, workspace = WORKSPACE): Promise<Session> {
  const res = await fetchWorker("/v1/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: ORIGIN },
    body: JSON.stringify({ workspace, email: EMAIL[key], password: PASSWORD[key] }),
  });
  const cookie = (res.headers.get("Set-Cookie") ?? "").split(";")[0] ?? "";
  const body = (await res.json()) as { csrf_token: string };
  return { cookie, csrf: body.csrf_token };
}

export function sessionHeaders(s: Session): Record<string, string> {
  return {
    Cookie: s.cookie,
    "X-CSRF-Token": s.csrf,
    "Content-Type": "application/json",
    Origin: ORIGIN,
  };
}

/** Multipart headers for a session — no Content-Type, so fetch sets the boundary. */
export function uploadHeaders(s: Session): Record<string, string> {
  return { Cookie: s.cookie, "X-CSRF-Token": s.csrf, Origin: ORIGIN };
}

export const bearer = {
  Authorization: `Bearer ${API_KEY}`,
  "Content-Type": "application/json",
};

export const otherBearer = {
  Authorization: `Bearer ${OTHER_API_KEY}`,
  "Content-Type": "application/json",
};

/**
 * An env whose event bus records instead of dispatching, the pattern S3 and S4
 * established: the test env has a real EVENTS binding, so a sent envelope never
 * reaches the consumer and never lands in `events_log`. Capturing it is both
 * simpler and stricter — the exact payload can be run through the registry.
 */
export function capturingEnv(): { env: Env; sent: EventEnvelope[] } {
  const sent: EventEnvelope[] = [];
  const bus = {
    async send(message: unknown) {
      sent.push(message as EventEnvelope);
      return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
    },
    async sendBatch(messages: Iterable<MessageSendRequest<unknown>>) {
      for (const m of messages) sent.push(m.body as EventEnvelope);
      return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
    },
  };
  return { env: { ...(env as unknown as Env), EVENTS: bus as unknown as Queue }, sent };
}

/** A minimal but genuinely decodable JPEG, so a content-type check is not a lie. */
export const JPEG_BYTES = new Uint8Array([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01,
  0x00, 0x01, 0x00, 0x00, 0xff, 0xdb, 0x00, 0x43, 0x00, 0x08, 0x06, 0x06, 0x07, 0x06, 0x05, 0x08,
  0xff, 0xd9,
]);

/**
 * Upload a receipt through `POST /v1/claims/receipts` and return its file id.
 *
 * Deliberately the claims route rather than `POST /v1/files`: the `employee` tier
 * holds no `files:write`, and using the files route here would test a path the
 * real filer cannot take.
 */
export async function uploadReceipt(
  session: Session,
  filename = "receipt.jpg",
  contentType = "image/jpeg",
  bytes: Uint8Array = JPEG_BYTES,
): Promise<string> {
  const form = new FormData();
  form.set("file", new File([bytes], filename, { type: contentType }));
  const res = await fetchWorker("/v1/claims/receipts", {
    method: "POST",
    headers: uploadHeaders(session),
    body: form,
  });
  if (res.status !== 201) {
    throw new Error(`receipt upload failed (${res.status}): ${await res.text()}`);
  }
  return ((await res.json()) as { file_id: string }).file_id;
}

/**
 * Seed both tenants, the users, the reporting line, two projects and the default
 * claim categories. Call once per test file from `beforeAll`.
 */
export async function seedClaimsFixture(): Promise<void> {
  for (const [tenantId, name, slug, key] of [
    [TENANT_ID, "Claims Tenant", WORKSPACE, API_KEY],
    [OTHER_TENANT_ID, "Other Claims Tenant", OTHER_WORKSPACE, OTHER_API_KEY],
  ] as const) {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO tenants (tenant_id, name, slug, api_key_hash) VALUES (?, ?, ?, ?)",
    )
      .bind(tenantId, name, slug, await sha256Hex(key))
      .run();
  }

  const seeded: ReadonlyArray<[UserKey, Parameters<typeof createUser>[1]["role"], string]> = [
    ["admin", "admin", TENANT_ID],
    ["finance", "finance", TENANT_ID],
    // Both of these hold the narrowest tier on purpose — see the file comment.
    ["manager", "employee", TENANT_ID],
    ["filer", "employee", TENANT_ID],
    ["colleague", "employee", TENANT_ID],
    // A full business observer: holds `finance:read` (so it sees every claim) AND
    // `self:write` (so it can file its own). The pair is why read and write
    // authority are separate questions in routes/claims.ts.
    ["observer", "readonly", TENANT_ID],
    ["otherAdmin", "admin", OTHER_TENANT_ID],
  ];
  for (const [key, role, tenantId] of seeded) {
    const created = await createUser(env.DB, {
      tenant_id: tenantId,
      email: EMAIL[key],
      password: PASSWORD[key],
      display_name: key,
      role,
    });
    user[key] = created.user_id;
  }

  // Employees. The manager is inserted first, because the FK on
  // (tenant_id, manager_employee_id) needs the parent to exist.
  //
  // `department_id` differs between the filer and the colleague so the
  // "department falls back to the employee's own" assertion has something to
  // distinguish.
  await env.DB.prepare(
    `INSERT OR IGNORE INTO employees (employee_id, tenant_id, name, department_id, user_id)
     VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(EMP.manager, TENANT_ID, "Line Manager", "management", user.manager)
    .run();
  await env.DB.prepare(
    `INSERT OR IGNORE INTO employees
       (employee_id, tenant_id, name, department_id, user_id, manager_employee_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(EMP.filer, TENANT_ID, "Aisha Rahman", "operations", user.filer, EMP.manager)
    .run();
  await env.DB.prepare(
    `INSERT OR IGNORE INTO employees
       (employee_id, tenant_id, name, department_id, user_id, manager_employee_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(EMP.colleague, TENANT_ID, "Colleague", "finance", user.colleague, EMP.manager)
    .run();
  // The observer is staff too. PRD-008's matrix is explicit that "an observer who
  // is also staff can still file their own leave request", and the same has to be
  // true of a claim — so it needs an employee record to file against.
  await env.DB.prepare(
    `INSERT OR IGNORE INTO employees
       (employee_id, tenant_id, name, department_id, user_id, manager_employee_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(EMP.observer, TENANT_ID, "Observer", "management", user.observer, EMP.manager)
    .run();

  for (const [projectId, name] of [
    [PROJECT_ID, "Project Alpha"],
    [OTHER_PROJECT_ID, "Project Beta"],
  ] as const) {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO projects (project_id, tenant_id, name) VALUES (?, ?, ?)",
    )
      .bind(projectId, TENANT_ID, name)
      .run();
  }

  // Seeds the six default categories and the 5xxx expense accounts they map to,
  // plus the system chart (which is where 2100 comes from).
  await ensureClaimCategories(env.DB, TENANT_ID);
  await ensureClaimCategories(env.DB, OTHER_TENANT_ID);

  const { results } = await env.DB.prepare(
    "SELECT code, category_id FROM claim_categories WHERE tenant_id = ?",
  )
    .bind(TENANT_ID)
    .all<{ code: string; category_id: string }>();
  for (const row of results ?? []) category[row.code] = row.category_id;
}

/** The tenant's account id for a code — the ledger assertions all need this. */
export async function accountId(code: string, tenantId = TENANT_ID): Promise<string> {
  const row = await env.DB.prepare(
    "SELECT account_id FROM accounts WHERE tenant_id = ? AND code = ?",
  )
    .bind(tenantId, code)
    .first<{ account_id: string }>();
  if (!row) throw new Error(`account ${code} not seeded for ${tenantId}`);
  return row.account_id;
}

/** Signed balance of an account: > 0 net debit, < 0 net credit. */
export async function balanceOf(code: string, tenantId = TENANT_ID): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COALESCE(SUM(jl.amount_cents), 0) AS cents
       FROM journal_lines jl
       JOIN accounts a ON a.tenant_id = jl.tenant_id AND a.account_id = jl.account_id
      WHERE jl.tenant_id = ? AND a.code = ?`,
  )
    .bind(tenantId, code)
    .first<{ cents: number }>();
  return row?.cents ?? 0;
}

/** Every journal entry posted for a claim, with its lines. */
export async function entriesForClaim(claimId: string, tenantId = TENANT_ID) {
  const { results: entries } = await env.DB.prepare(
    `SELECT entry_id, entry_date, memo, currency, source_type, source_id
       FROM journal_entries WHERE tenant_id = ? AND source_id = ? ORDER BY entry_id`,
  )
    .bind(tenantId, claimId)
    .all<{
      entry_id: string;
      entry_date: string;
      memo: string | null;
      currency: string;
      source_type: string;
      source_id: string;
    }>();

  const withLines = [];
  for (const entry of entries ?? []) {
    const { results: lines } = await env.DB.prepare(
      `SELECT jl.line_no, jl.amount_cents, jl.employee_id, jl.project_id, jl.department_code,
              a.code AS account_code
         FROM journal_lines jl
         JOIN accounts a ON a.tenant_id = jl.tenant_id AND a.account_id = jl.account_id
        WHERE jl.tenant_id = ? AND jl.entry_id = ?
        ORDER BY jl.line_no`,
    )
      .bind(tenantId, entry.entry_id)
      .all<{
        line_no: number;
        amount_cents: number;
        employee_id: string | null;
        project_id: string | null;
        department_code: string | null;
        account_code: string;
      }>();
    withLines.push({ ...entry, lines: lines ?? [] });
  }
  return withLines;
}

export async function countJournalEntries(tenantId = TENANT_ID): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM journal_entries WHERE tenant_id = ?",
  )
    .bind(tenantId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}
