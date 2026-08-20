# Writing tests that drive a Durable Object

Two traps in `@cloudflare/vitest-pool-workers` (pinned at `0.8.71`) cost a
session's worth of debugging in S10. Both look like flakiness and neither is.

## 1. A frozen clock in the real past makes alarms fire immediately

`vi.setSystemTime` fakes `Date.now()` **inside the isolate**. Miniflare's alarm
scheduler runs on the **real** clock. So this:

```ts
vi.setSystemTime(new Date("2026-08-19T04:00:00Z"));   // yesterday, in real time
await agent.onEvent(overdueEvent());                  // the DO sets an alarm at
                                                      // faked now + 24h — which
                                                      // is already in the past
```

schedules an alarm the runtime fires **at once**. The DO's `alarm()` handler then
runs a second assessment *concurrently with the test that scheduled it*: an extra
send, extra events, state written after your assertions read it, and a Durable
Object still writing storage when the pool snapshots it for the next test.

It is worse than a normal flake because it is a **time bomb**: the suite passes
until the calendar catches up with the date you pinned. A suite frozen at
"yesterday" starts failing tomorrow, in CI, on a commit that did not touch it.

**Rule: pin frozen clocks years ahead of today, not near it.** The agent suites
use 2029. Say so in a comment where the constant is defined, because the next
person will otherwise "tidy" it back to a plausible-looking date.

Two knock-on details when you move a suite's clock:

- Invoice due dates and `days_overdue` move with it — check any assertion that
  depends on a threshold (the 60-day escalation gate, a health band).
- The **shipped** Malaysian holiday calendar only covers 2025–2027
  (`src/modules/leave/holidays/data.ts`). A suite pinned outside that range has
  no shipped holidays, so declare tenant rows in `public_holidays` instead — that
  works in any year, and it is the path a tenant uses anyway. Test the shipped
  calendar separately, without a Durable Object: see the `loadHolidayLookup`
  tests in `test/agent-guardrails-window.test.ts`.

## 2. Isolated storage cannot snapshot a Durable Object mid-write

With `isolatedStorage: true` (the default, and what `vitest.config.ts` uses), the
pool copies every Durable Object's SQLite file between tests and asserts each
filename ends in `.sqlite` (`pool/index.mjs` → `pushStackedStorage`). A DO with
an open WAL connection has `.sqlite-shm` / `.sqlite-wal` sidecars next to it, and
the copy fails with:

```
Isolated storage failed. There should be additional logs above.
AssertionError: Expected .sqlite, got …/<hash>.sqlite-shm
```

which surfaces as unrelated assertion failures in whichever tests run next,
because storage stops rolling back and state bleeds between them.

There is no fix inside the `0.8.x` range — `0.8.71` is the newest — so avoid
provoking it:

- **Do not leave a pending alarm at the end of a test.** Close the loop the way
  production does (for collections, a `payment.received` for every open invoice,
  which is the one path that calls `deleteAlarm()`).
- **Do not read DO storage from the test realm.** `runInDurableObject` and
  `storage.getAlarm()` both materialise the sidecars. Assert the *behaviour*
  instead: that the deferred send happens when the window opens, that a paused
  customer is chased again once unpaused. That is a stronger claim than an alarm
  timestamp anyway.
- **Keep DO-driven tests to one per mechanism.** Anything that is arithmetic or
  string handling belongs in a test that calls the function directly — see
  `test/agent-decision-guards.test.ts` next to `test/agent-guardrails.test.ts`.

If a suite genuinely needs many DO-touching tests, split it: each *file* gets its
own miniflare instance, so the per-instance storage traffic drops.

**If this ever needs a real fix**, the options are to upgrade the pool past
`0.8.x` (a major jump — it is at `0.22` and the config surface changed), or to
move the DO-heavy suites into their own vitest project with
`isolatedStorage: false` and make them self-isolating (a unique customer, and so
a unique DO, per test). Both are their own piece of work with their own risk;
neither is a five-minute change.
