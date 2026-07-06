import { ulid } from "ulid";
import type {
  Account,
  EntrySourceType,
  JournalEntry,
  JournalLine,
} from "./types";

/**
 * Double-entry ledger service. All writes go through postEntry (or a larger
 * D1 batch built with buildEntryStatements), which enforces the invariants
 * the schema can't express on its own:
 *   - every entry has at least two lines
 *   - lines are signed cents (> 0 debit, < 0 credit) and sum to exactly 0
 *   - every referenced account exists for the tenant
 * The tables themselves are append-only (SQL triggers); corrections are
 * reversal entries pointing at reverses_entry_id.
 */

/** Seeded per tenant on first use; codes are stable, ids are per-tenant ULIDs. */
export const SYSTEM_ACCOUNTS = [
  { code: "1000", name: "Cash", type: "asset" },
  { code: "1100", name: "Accounts Receivable", type: "asset" },
  { code: "2000", name: "Accounts Payable", type: "liability" },
  { code: "3000", name: "Owner's Equity", type: "equity" },
  { code: "4000", name: "Revenue", type: "revenue" },
  { code: "5000", name: "General Expenses", type: "expense" },
] as const;

export type SystemAccountCode = (typeof SYSTEM_ACCOUNTS)[number]["code"];

export class LedgerError extends Error {
  constructor(
    readonly code: "unbalanced" | "too_few_lines" | "unknown_account",
    message: string,
  ) {
    super(message);
    this.name = "LedgerError";
  }
}

export interface EntryInput {
  entry_date: string; // ISO date
  memo?: string;
  currency: string;
  source_type: EntrySourceType;
  source_id?: string;
  reverses_entry_id?: string;
  lines: { account_id: string; amount_cents: number }[];
}

/** Idempotent: INSERT OR IGNORE keyed on UNIQUE (tenant_id, code). */
export async function ensureSystemAccounts(db: D1Database, tenantId: string): Promise<void> {
  await db.batch(
    SYSTEM_ACCOUNTS.map((a) =>
      db
        .prepare(
          `INSERT OR IGNORE INTO accounts (account_id, tenant_id, code, name, type, is_system)
           VALUES (?, ?, ?, ?, ?, 1)`,
        )
        .bind(`acct_${ulid()}`, tenantId, a.code, a.name, a.type),
    ),
  );
}

interface AccountRow {
  account_id: string;
  code: string;
  name: string;
  type: Account["type"];
  is_system: number;
}

function toAccount(row: AccountRow): Account {
  return { ...row, is_system: row.is_system === 1 };
}

export async function listAccounts(db: D1Database, tenantId: string): Promise<Account[]> {
  const { results } = await db
    .prepare(
      `SELECT account_id, code, name, type, is_system FROM accounts
       WHERE tenant_id = ? AND archived_at IS NULL ORDER BY code`,
    )
    .bind(tenantId)
    .all<AccountRow>();
  return results.map(toAccount);
}

export async function getAccountByCode(
  db: D1Database,
  tenantId: string,
  code: SystemAccountCode,
): Promise<Account> {
  const row = await db
    .prepare(
      "SELECT account_id, code, name, type, is_system FROM accounts WHERE tenant_id = ? AND code = ?",
    )
    .bind(tenantId, code)
    .first<AccountRow>();
  if (!row) throw new LedgerError("unknown_account", `system account ${code} not seeded`);
  return toAccount(row);
}

/** Balance = signed sum of all lines touching the account. */
export async function accountBalance(
  db: D1Database,
  tenantId: string,
  accountId: string,
): Promise<{ balance_cents: number } | null> {
  const account = await db
    .prepare("SELECT account_id FROM accounts WHERE tenant_id = ? AND account_id = ?")
    .bind(tenantId, accountId)
    .first();
  if (!account) return null;
  const row = await db
    .prepare(
      `SELECT COALESCE(SUM(amount_cents), 0) AS balance_cents
       FROM journal_lines WHERE tenant_id = ? AND account_id = ?`,
    )
    .bind(tenantId, accountId)
    .first<{ balance_cents: number }>();
  return { balance_cents: row?.balance_cents ?? 0 };
}

/**
 * Validate an entry and build its INSERT statements without executing them,
 * so callers (e.g. invoice/payment posting) can atomically batch the entry
 * together with their own writes.
 */
export function buildEntryStatements(
  db: D1Database,
  tenantId: string,
  input: EntryInput,
): { entry_id: string; statements: D1PreparedStatement[] } {
  if (input.lines.length < 2) {
    throw new LedgerError("too_few_lines", "a journal entry needs at least two lines");
  }
  const sum = input.lines.reduce((acc, l) => acc + l.amount_cents, 0);
  if (sum !== 0) {
    throw new LedgerError("unbalanced", `lines sum to ${sum}, must be exactly 0`);
  }

  const entryId = `je_${ulid()}`;
  const statements = [
    db
      .prepare(
        `INSERT INTO journal_entries
           (entry_id, tenant_id, entry_date, memo, currency, source_type, source_id, reverses_entry_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        entryId,
        tenantId,
        input.entry_date,
        input.memo ?? null,
        input.currency,
        input.source_type,
        input.source_id ?? null,
        input.reverses_entry_id ?? null,
      ),
    ...input.lines.map((line, i) =>
      db
        .prepare(
          `INSERT INTO journal_lines (entry_id, tenant_id, line_no, account_id, amount_cents)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .bind(entryId, tenantId, i + 1, line.account_id, line.amount_cents),
    ),
  ];
  return { entry_id: entryId, statements };
}

async function assertAccountsExist(
  db: D1Database,
  tenantId: string,
  accountIds: string[],
): Promise<void> {
  const unique = [...new Set(accountIds)];
  const placeholders = unique.map(() => "?").join(", ");
  const { results } = await db
    .prepare(
      `SELECT account_id FROM accounts WHERE tenant_id = ? AND account_id IN (${placeholders})`,
    )
    .bind(tenantId, ...unique)
    .all<{ account_id: string }>();
  const found = new Set(results.map((r) => r.account_id));
  const missing = unique.filter((id) => !found.has(id));
  if (missing.length > 0) {
    throw new LedgerError("unknown_account", `unknown account(s): ${missing.join(", ")}`);
  }
}

/** Validate and atomically post a balanced entry. Throws LedgerError on violation. */
export async function postEntry(
  db: D1Database,
  tenantId: string,
  input: EntryInput,
): Promise<{ entry_id: string }> {
  const { entry_id, statements } = buildEntryStatements(db, tenantId, input);
  await assertAccountsExist(
    db,
    tenantId,
    input.lines.map((l) => l.account_id),
  );
  await db.batch(statements);
  return { entry_id };
}

export async function getEntry(
  db: D1Database,
  tenantId: string,
  entryId: string,
): Promise<JournalEntry | null> {
  const header = await db
    .prepare(
      `SELECT entry_id, entry_date, memo, currency, source_type, source_id, reverses_entry_id
       FROM journal_entries WHERE tenant_id = ? AND entry_id = ?`,
    )
    .bind(tenantId, entryId)
    .first<Omit<JournalEntry, "lines">>();
  if (!header) return null;
  const { results } = await db
    .prepare(
      `SELECT line_no, account_id, amount_cents FROM journal_lines
       WHERE tenant_id = ? AND entry_id = ? ORDER BY line_no`,
    )
    .bind(tenantId, entryId)
    .all<JournalLine>();
  return { ...header, lines: results };
}

/**
 * Post a reversal of an existing entry: same lines, negated amounts.
 * The corrected state is re-posted separately by the caller if needed.
 */
export async function reverseEntry(
  db: D1Database,
  tenantId: string,
  entryId: string,
  memo?: string,
): Promise<{ entry_id: string } | null> {
  const original = await getEntry(db, tenantId, entryId);
  if (!original) return null;
  return postEntry(db, tenantId, {
    entry_date: new Date().toISOString().slice(0, 10),
    memo: memo ?? `reversal of ${entryId}`,
    currency: original.currency,
    source_type: "reversal",
    reverses_entry_id: entryId,
    lines: original.lines.map((l) => ({
      account_id: l.account_id,
      amount_cents: -l.amount_cents,
    })),
  });
}
