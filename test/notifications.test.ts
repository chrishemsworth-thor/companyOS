import { describe, it, expect, beforeAll } from "vitest";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/index";
import { sha256Hex } from "../src/gateway/middleware/auth";
import { createUser } from "../src/auth/users";
import type { Notification } from "../src/modules/notifications/types";

/**
 * PRD-000c — the notifications HTTP surface.
 *
 * The *read* side of the primitive, and the two acceptance criteria that live
 * here: marking a notification read decrements the count and it does not come
 * back on refresh (criterion 3), and a user from tenant B never sees tenant A's
 * rows (criterion 4). Criteria 1 and 2 — creation, and creation on the free-plan
 * inline path — are in `test/notification-consumer.test.ts`.
 *
 * Everything is exercised through `worker.fetch` on a cookie session rather than
 * against the service, because "whose notifications are these" is the whole
 * behaviour under test and a session is the only thing that carries a user
 * identity.
 *
 * Isolated-storage note: D1 writes inside an `it` are rolled back before the
 * next one. Tenants and users are seeded in `beforeAll` (which persists);
 * notifications are seeded per test, since most of these tests mutate them.
 */

const WORKSPACE = "notifs-co";
const TENANT_ID = "biz_notifs";
const API_KEY = "test_api_key_notifs";

const OTHER_WORKSPACE = "notifs-other-co";
const OTHER_TENANT_ID = "biz_notifs_other";
const OTHER_API_KEY = "test_api_key_notifs_other";

const ORIGIN = "http://localhost:5173";

type UserKey = "alice" | "bob" | "otherAlice";
const user = {} as Record<UserKey, string>;

const PASSWORD = "notifications-password";

async function fetchWorker(path: string, init?: RequestInit): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`https://gateway.test${path}`, init), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

interface Session {
  cookie: string;
  csrf: string;
}

async function login(email: string, workspace = WORKSPACE): Promise<Session> {
  const res = await fetchWorker("/v1/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: ORIGIN },
    body: JSON.stringify({ workspace, email, password: PASSWORD }),
  });
  const cookie = (res.headers.get("Set-Cookie") ?? "").split(";")[0] ?? "";
  const body = (await res.json()) as { csrf_token: string };
  return { cookie, csrf: body.csrf_token };
}

function sessionHeaders(s: Session): Record<string, string> {
  return {
    Cookie: s.cookie,
    "X-CSRF-Token": s.csrf,
    "Content-Type": "application/json",
    Origin: ORIGIN,
  };
}

interface ListResponse {
  items: Notification[];
  next_cursor: string | null;
  unread_count: number;
}

async function list(s: Session, query = ""): Promise<ListResponse> {
  const res = await fetchWorker(`/v1/notifications${query}`, { headers: { Cookie: s.cookie } });
  expect(res.status).toBe(200);
  return (await res.json()) as ListResponse;
}

/**
 * Insert notifications with EXPLICIT ids.
 *
 * The service mints ULIDs, and two ULIDs generated in the same millisecond are
 * not ordered relative to one another — their low bits are random. Ordering is
 * load-bearing in these tests ("newest first", cursor paging), so the ids are
 * fixed here rather than left to chance. `ntf_0001` < `ntf_0002` lexically, which
 * is the same comparison the real ULIDs get.
 */
async function seed(
  rows: ReadonlyArray<{
    id: string;
    user_id: string;
    tenant_id?: string;
    type?: string;
    subject_type?: string;
    subject_id?: string;
    title?: string;
    read?: boolean;
  }>,
): Promise<void> {
  for (const row of rows) {
    await env.DB.prepare(
      `INSERT INTO notifications
         (notification_id, tenant_id, user_id, type, subject_type, subject_id, title, body,
          dedupe_key, read_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        row.id,
        row.tenant_id ?? TENANT_ID,
        row.user_id,
        row.type ?? "approval.requested",
        row.subject_type ?? "expense_claim",
        row.subject_id ?? `clm_${row.id}`,
        row.title ?? `Approval needed: ${row.id}`,
        null,
        `seed:${row.id}`,
        row.read ? new Date().toISOString() : null,
      )
      .run();
  }
}

beforeAll(async () => {
  for (const [tenantId, name, slug, key] of [
    [TENANT_ID, "Notifications Tenant", WORKSPACE, API_KEY],
    [OTHER_TENANT_ID, "Other Notifications Tenant", OTHER_WORKSPACE, OTHER_API_KEY],
  ] as const) {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO tenants (tenant_id, name, slug, api_key_hash) VALUES (?, ?, ?, ?)",
    )
      .bind(tenantId, name, slug, await sha256Hex(key))
      .run();
  }

  for (const [key, email, tenantId] of [
    ["alice", "alice@notifs.test", TENANT_ID],
    ["bob", "bob@notifs.test", TENANT_ID],
    ["otherAlice", "alice@notifs-other.test", OTHER_TENANT_ID],
  ] as const) {
    const created = await createUser(env.DB, {
      tenant_id: tenantId,
      email,
      password: PASSWORD,
      display_name: key,
      role: "operator",
    });
    user[key] = created.user_id;
  }
});

describe("GET /v1/notifications", () => {
  it("returns the caller's notifications, newest first, with an unread count", async () => {
    // PRD-007's badge criterion: three unread → the badge shows 3.
    await seed([
      { id: "ntf_0001", user_id: user.alice },
      { id: "ntf_0002", user_id: user.alice },
      { id: "ntf_0003", user_id: user.alice },
    ]);
    const alice = await login("alice@notifs.test");

    const body = await list(alice);

    expect(body.unread_count).toBe(3);
    // Newest first — the opposite of the approvals inbox, because this is a
    // record of what happened rather than a queue of work.
    expect(body.items.map((n) => n.notification_id)).toEqual(["ntf_0003", "ntf_0002", "ntf_0001"]);
  });

  it("counts every unread row, not just the ones on this page", async () => {
    // A badge that showed the page size would tell a user with 60 unread
    // notifications that they had 2.
    await seed(
      Array.from({ length: 5 }, (_, i) => ({
        id: `ntf_page_${i}`,
        user_id: user.alice,
      })),
    );
    const alice = await login("alice@notifs.test");

    const body = await list(alice, "?limit=2");

    expect(body.items).toHaveLength(2);
    expect(body.unread_count).toBe(5);
    expect(body.next_cursor).toBe("ntf_page_3");
  });

  it("pages backwards through the feed with the cursor", async () => {
    await seed([
      { id: "ntf_0001", user_id: user.alice },
      { id: "ntf_0002", user_id: user.alice },
      { id: "ntf_0003", user_id: user.alice },
    ]);
    const alice = await login("alice@notifs.test");

    const first = await list(alice, "?limit=2");
    expect(first.items.map((n) => n.notification_id)).toEqual(["ntf_0003", "ntf_0002"]);
    expect(first.next_cursor).toBe("ntf_0002");

    const second = await list(alice, `?limit=2&cursor=${first.next_cursor}`);
    expect(second.items.map((n) => n.notification_id)).toEqual(["ntf_0001"]);
    expect(second.next_cursor).toBeNull();
  });

  it("filters to unread with ?unread=true", async () => {
    await seed([
      { id: "ntf_0001", user_id: user.alice, read: true },
      { id: "ntf_0002", user_id: user.alice },
    ]);
    const alice = await login("alice@notifs.test");

    const body = await list(alice, "?unread=true");

    expect(body.items.map((n) => n.notification_id)).toEqual(["ntf_0002"]);
    expect(body.unread_count).toBe(1);
  });

  it("returns an empty feed rather than an error for a user with nothing", async () => {
    const bob = await login("bob@notifs.test");

    const body = await list(bob);

    expect(body.items).toEqual([]);
    expect(body.unread_count).toBe(0);
    expect(body.next_cursor).toBeNull();
  });

  it("never returns another user's notifications from the same tenant", async () => {
    await seed([
      { id: "ntf_0001", user_id: user.alice },
      { id: "ntf_0002", user_id: user.bob },
    ]);
    const alice = await login("alice@notifs.test");

    const body = await list(alice);

    expect(body.items.map((n) => n.notification_id)).toEqual(["ntf_0001"]);
    expect(body.unread_count).toBe(1);
  });

  it("rejects an invalid limit", async () => {
    const alice = await login("alice@notifs.test");
    const res = await fetchWorker("/v1/notifications?limit=9999", {
      headers: { Cookie: alice.cookie },
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /v1/notifications/:id/read", () => {
  it("marks read, decrements the count, and does not reappear on refresh", async () => {
    // PRD-000 criterion 3, in one test because the criterion is one behaviour:
    // the badge means something only if acting on an item clears it for good.
    await seed([
      { id: "ntf_0001", user_id: user.alice },
      { id: "ntf_0002", user_id: user.alice },
    ]);
    const alice = await login("alice@notifs.test");

    const res = await fetchWorker("/v1/notifications/ntf_0001/read", {
      method: "POST",
      headers: sessionHeaders(alice),
    });
    expect(res.status).toBe(200);
    const marked = (await res.json()) as Notification & { unread_count: number };
    expect(marked.read_at).not.toBeNull();
    expect(marked.unread_count).toBe(1);

    const after = await list(alice);
    expect(after.unread_count).toBe(1);
    expect(after.items.find((n) => n.notification_id === "ntf_0001")?.read_at).not.toBeNull();

    const unreadOnly = await list(alice, "?unread=true");
    expect(unreadOnly.items.map((n) => n.notification_id)).toEqual(["ntf_0002"]);
  });

  it("is idempotent and keeps the first-seen timestamp", async () => {
    // The console marks on click; a double-click is not an error, and "when did
    // they first see it" is the interesting value once approval SLAs land.
    await seed([{ id: "ntf_0001", user_id: user.alice }]);
    const alice = await login("alice@notifs.test");

    const first = (await (
      await fetchWorker("/v1/notifications/ntf_0001/read", {
        method: "POST",
        headers: sessionHeaders(alice),
      })
    ).json()) as Notification;

    const second = await fetchWorker("/v1/notifications/ntf_0001/read", {
      method: "POST",
      headers: sessionHeaders(alice),
    });
    expect(second.status).toBe(200);
    expect(((await second.json()) as Notification).read_at).toBe(first.read_at);
  });

  it("404s on another user's notification rather than 403", async () => {
    // A 403 would confirm the id exists. Same rule the files and approvals read
    // paths follow.
    await seed([{ id: "ntf_0002", user_id: user.bob }]);
    const alice = await login("alice@notifs.test");

    const res = await fetchWorker("/v1/notifications/ntf_0002/read", {
      method: "POST",
      headers: sessionHeaders(alice),
    });
    expect(res.status).toBe(404);

    // And Bob's notification is untouched.
    const row = await env.DB.prepare(
      "SELECT read_at FROM notifications WHERE notification_id = ?",
    )
      .bind("ntf_0002")
      .first<{ read_at: string | null }>();
    expect(row?.read_at).toBeNull();
  });

  it("404s on an id that does not exist", async () => {
    const alice = await login("alice@notifs.test");
    const res = await fetchWorker("/v1/notifications/ntf_nope/read", {
      method: "POST",
      headers: sessionHeaders(alice),
    });
    expect(res.status).toBe(404);
  });

  it("requires a CSRF token", async () => {
    await seed([{ id: "ntf_0001", user_id: user.alice }]);
    const alice = await login("alice@notifs.test");

    const res = await fetchWorker("/v1/notifications/ntf_0001/read", {
      method: "POST",
      headers: { Cookie: alice.cookie, "Content-Type": "application/json", Origin: ORIGIN },
    });
    expect(res.status).toBe(403);
  });
});

describe("POST /v1/notifications/read-all", () => {
  it("clears the badge and reports how many it cleared", async () => {
    await seed([
      { id: "ntf_0001", user_id: user.alice },
      { id: "ntf_0002", user_id: user.alice, read: true },
      { id: "ntf_0003", user_id: user.alice },
    ]);
    const alice = await login("alice@notifs.test");

    const res = await fetchWorker("/v1/notifications/read-all", {
      method: "POST",
      headers: sessionHeaders(alice),
    });
    expect(res.status).toBe(200);
    // Two, not three: the already-read one was not touched.
    expect(await res.json()).toMatchObject({ marked: 2, unread_count: 0 });

    expect((await list(alice)).unread_count).toBe(0);
  });

  it("leaves other users' notifications unread", async () => {
    await seed([
      { id: "ntf_0001", user_id: user.alice },
      { id: "ntf_0002", user_id: user.bob },
    ]);
    const alice = await login("alice@notifs.test");

    await fetchWorker("/v1/notifications/read-all", {
      method: "POST",
      headers: sessionHeaders(alice),
    });

    const bob = await login("bob@notifs.test");
    expect((await list(bob)).unread_count).toBe(1);
  });

  it("is a no-op on an empty feed", async () => {
    const bob = await login("bob@notifs.test");
    const res = await fetchWorker("/v1/notifications/read-all", {
      method: "POST",
      headers: sessionHeaders(bob),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ marked: 0 });
  });
});

describe("tenant isolation (PRD-000 criterion 4)", () => {
  it("never returns tenant A's notifications to a tenant B user", async () => {
    // Both users are called "alice" and both have a notification. The only thing
    // keeping them apart is the tenant scope on every query.
    await seed([
      { id: "ntf_0001", user_id: user.alice, tenant_id: TENANT_ID },
      { id: "ntf_0002", user_id: user.otherAlice, tenant_id: OTHER_TENANT_ID },
    ]);

    const otherAlice = await login("alice@notifs-other.test", OTHER_WORKSPACE);
    const body = await list(otherAlice);

    expect(body.items.map((n) => n.notification_id)).toEqual(["ntf_0002"]);
    expect(body.unread_count).toBe(1);
  });

  it("404s when a tenant B user marks tenant A's notification read", async () => {
    await seed([{ id: "ntf_0001", user_id: user.alice, tenant_id: TENANT_ID }]);
    const otherAlice = await login("alice@notifs-other.test", OTHER_WORKSPACE);

    const res = await fetchWorker("/v1/notifications/ntf_0001/read", {
      method: "POST",
      headers: sessionHeaders(otherAlice),
    });
    expect(res.status).toBe(404);
  });

  it("read-all in tenant B does not touch tenant A", async () => {
    await seed([
      { id: "ntf_0001", user_id: user.alice, tenant_id: TENANT_ID },
      { id: "ntf_0002", user_id: user.otherAlice, tenant_id: OTHER_TENANT_ID },
    ]);

    const otherAlice = await login("alice@notifs-other.test", OTHER_WORKSPACE);
    await fetchWorker("/v1/notifications/read-all", {
      method: "POST",
      headers: sessionHeaders(otherAlice),
    });

    const alice = await login("alice@notifs.test");
    expect((await list(alice)).unread_count).toBe(1);
  });
});

describe("programmatic callers", () => {
  // A tenant API key authenticates a tenant, not a person. There is no "my
  // notifications" for it, and answering with an empty list would let an
  // integration poll forever and conclude nothing was happening.
  const bearer = {
    Authorization: `Bearer ${API_KEY}`,
    "Content-Type": "application/json",
  };

  it("400s on list", async () => {
    const res = await fetchWorker("/v1/notifications", { headers: bearer });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "invalid_request" });
  });

  it("400s on mark-read", async () => {
    const res = await fetchWorker("/v1/notifications/ntf_0001/read", {
      method: "POST",
      headers: bearer,
    });
    expect(res.status).toBe(400);
  });

  it("400s on read-all", async () => {
    const res = await fetchWorker("/v1/notifications/read-all", { method: "POST", headers: bearer });
    expect(res.status).toBe(400);
  });
});

describe("authentication", () => {
  it("401s with no credential at all", async () => {
    const res = await fetchWorker("/v1/notifications");
    expect(res.status).toBe(401);
  });
});
