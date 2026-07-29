# CompanyOS PRDs — Index & Sequencing

Eight PRDs covering the seven gaps identified on 2026-07-24, plus the platform
foundation they all depend on. PRD-008 was added on 2026-07-28 from a gap found
while building user invites: roles exist but are not enforced.

| # | PRD | Priority | Depends on |
|---|---|---|---|
| 000 | Platform Foundations — file storage, approvals, notifications | P0 | — |
| 001 | Finance — ledger dimensions, tax, credit notes | P0 | — |
| 002 | Collections Agent — model portability & eval harness | P1 | — |
| 003 | CRM — contact roles, customer depth, health | P1 | 001 (loosely) |
| 004 | Quotes — branded documents & click-to-sign | P1 | 000, 003 |
| 005 | Support — customer-facing intake & tracking | P1 | 000 (partial) |
| 006 | People — leave & expense claims | P0 | 000, 001 |
| 007 | Console — approvals inbox & notifications | P0 | 000 |
| 008 | Roles, permissions & employee self-service | P0 | — (design against 000, 006) |

## Dependency graph

```
000 (foundations) ──┬──> 004 (quote signing)
                    ├──> 006 (leave & claims)
                    ├──> 007 (approvals inbox)
                    └──> 005 (attachments only)

001 (ledger dims) ──┬──> 006 (claims → GL with project tags)
                    └──> profitability rollups

003 (contact roles) ──> 004 (signatory) , 002 (better targeting)

002, 005 (email path) — independent, parallelisable
```

## Recommended build order

1. **001 ledger dimensions only** — do this before any real customer data exists.
   The rest of 001 (tax, credit notes, multi-currency) can wait.
2. **000 + 007 together** — the primitive and its inbox are one shippable increment.
   An approvals backend nobody can see is not a feature.
3. **006 claims** — proves the architecture (claim → GL → cash position → project margin).
   The demo no HR competitor can match.
4. **006 leave** — the table-stakes feature that makes People adoptable at all.
5. **004 quote signing** — closes quote-to-cash.
6. **003 contact roles** — small, high leverage; can be pulled earlier if it unblocks 004.
7. **002 guardrails** — before any real customer data touches the agent. The eval harness
   can follow, but the hard guardrails (out-of-hours sends, escalation limits, kill
   switch) should land before an agent messages a stranger.
8. **005 support intake** — after the wedge is proven.
9. **001 tax + credit notes** — when a design partner hits them.

## Handing these to Claude Code

Each PRD is self-contained and states its dependencies. Suggested per-PRD prompt:

> Read `PRD-00X-*.md`. Before writing code, produce an implementation plan covering
> D1 migrations, new/changed endpoints, event types to register in the schema registry,
> and the test files you will add. Confirm the plan before implementing. Every
> acceptance criterion must have a corresponding test in the Workers runtime suite.

Two standing instructions worth repeating in every session:

- **Do not weaken the append-only ledger guarantees or the multi-tenant isolation
  pattern.** If a requirement seems to need it, stop and ask.
- **Do not invent an approvals or notifications mechanism inside a module.** Everything
  routes through the PRD-000 primitives.

## What these PRDs deliberately do not cover

Named so they do not get built by accident:

- **SalesAgent** (designed, not built) — its own PRD once the CRM substrate settles.
- **SupportAgent** — PRD-005 builds the substrate only.
- **Payroll and statutory submissions** — assessed and rejected as a defensible moat.
- **Apollo-style contact database** — cannot be won; enrichment stays a pluggable port.
- **Scoped/rotatable API keys** — designed only; PRD-005's intake token may be the
  forcing function.
- **Time tracking** — flagged as an open question in PRD-001 because project
  profitability may need it.

## The open question underneath all of these

None of these gaps came from a customer. They are the gaps visible from inside the
codebase. The structural ones (ledger dimensions, approvals primitive, agent guardrails,
quote immutability) are worth building blind — they get harder later and they are hard to
get wrong. The shaped ones (how leave policies actually work, what a claims approval chain
needs, which CRM fields matter) are guesses until someone else's data is in the system.

Build the structural ones. Time-box the shaped ones and let the first design partner
correct them.
