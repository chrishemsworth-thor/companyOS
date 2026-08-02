# CompanyOS — LinkedIn Page content pack

Everything the LinkedIn "Create a company page" flow asks for, in the order it
asks for it. Copy is written against what is actually shipped in the repo, not
the roadmap.

---

## 1. Identity fields

| Field | Value |
|---|---|
| **Page name** | CompanyOS |
| **LinkedIn public URL** | `linkedin.com/company/companyos` — likely taken. Fallbacks in preference order: `companyos-my`, `getcompanyos`, `companyos-hq` |
| **Website** | `https://companyos.com.my` (the API already runs on `api.companyos.com.my`) |
| **Industry** | Software Development |
| **Company size** | 2–10 employees |
| **Company type** | Privately Held |
| **Logo** | `companyos-logo-300.png` (300×300, dark) |
| **Cover** | `companyos-linkedin-cover-1128x191.png` |
| **Tagline** | see below (LinkedIn caps this at 120 characters) |

---

## 2. Tagline (≤120 characters)

**Recommended** (109 chars):

> The agent-first operating system for running a company. Finance, sales, support, build and people, one API.

Alternatives:

- (98) `One API for the whole company — finance, sales, support, build and people. Built for AI agents.`
- (92) `Run your company through one API. AI agents do the work; people approve it.`
- (116) `The business operating system where AI agents are the users, not another dashboard for humans to click through.`

---

## 3. About / Overview (≤2,000 characters)

**Recommended — 1,847 characters:**

> CompanyOS is an operating system for running a company, built for a world where the primary user of your business software is an AI agent rather than a person clicking through a dashboard.
>
> Every business process — issuing an invoice, moving a deal, resolving a ticket, approving a leave request — is exposed through one normalized, machine-readable API. Agents drive that API end to end. People stay in the loop through an operator console and an approvals inbox, not by doing the data entry.
>
> Five domains run natively on one platform and one database:
>
> • **Finance** — a real double-entry general ledger (append-only, balanced, reversal-based corrections), invoices, payments, and a daily overdue sweep.
> • **Sales** — leads, customers, contacts, a configurable deal pipeline, quotes with branded documents, and one-click quote-to-invoice.
> • **Support** — tickets with an explicit state machine and threaded messages.
> • **Build** — projects and issues, with signed inbound webhooks from JIRA, GitHub and Bitbucket so engineering work is visible next to everything else.
> • **People** — employee directory, teams and reporting lines, leave policy and balances built for Malaysian rules (state-varying public holidays, configurable work weeks), and expense claims that post straight to the ledger.
>
> Because it is one database rather than five integrated products, the questions that normally need a BI project are plain SQL: which customers have open tickets *and* overdue invoices, what a project actually costs once approved expense claims are counted, where the cash is going.
>
> The first autonomous agent is already live: a collections agent that detects an overdue invoice, assembles the customer's full context across finance, sales and support, decides whether to remind, escalate or wait, and sends the message — logging every decision to an auditable event log.
>
> Built in Malaysia, for companies that would rather run on an API than on twelve subscriptions.

**Short variant — 612 characters**, if you would rather the page read light:

> CompanyOS is an agent-first operating system for running a company. Finance, sales, support, engineering and people all live on one API and one database, so AI agents can drive real business processes end to end — issuing invoices, chasing payment, moving deals, approving expense claims — while people stay in the loop through an approvals inbox rather than doing the data entry.
>
> Real double-entry accounting. An auditable event log behind every action. A collections agent that already chases overdue invoices on its own. Built in Malaysia.

---

## 4. Specialties (LinkedIn allows up to 20 — 14 recommended)

```
AI agents
Business operating system
Double-entry accounting
Accounts receivable automation
Invoicing
CRM
Quote-to-cash
Customer support software
Project tracking
HR and leave management
Expense claims
Workflow approvals
API-first software
Malaysian SME software
```

---

## 5. Locations

- **Primary (HQ):** Kuala Lumpur, Malaysia — tick "This is my primary location"
- Leave the street address blank if you would rather not publish it; city + country is enough for the page to show a location.

---

## 6. Custom button

LinkedIn gives one call-to-action button on the page header.

- **Recommended:** `Visit website` → `https://companyos.com.my`
- Switch to `Sign up` → your waitlist URL if you launch one before the site.

---

## 7. Hashtags (up to 3, used for the page's "community" feed)

```
#AIagents  #BusinessAutomation  #MalaysianTech
```

---

## 8. First three posts (LinkedIn hides pages with no content from search)

**Post 1 — the thesis** (pin this one):

> Most business software assumes a human will click the button.
>
> We built CompanyOS on the opposite assumption. Every process — invoicing, collections, deals, tickets, leave, expense claims — is one normalized API, and the default user is an AI agent. Humans stay in the loop where judgement is actually needed: an approvals inbox, on a phone, in about four seconds.
>
> The first agent is live. It notices an invoice going overdue, reads the customer's whole history across finance, sales and support, decides whether to chase, escalate or wait, and sends the message. Every decision it makes is written to an audit log.
>
> One API. One database. One company, running itself.

**Post 2 — the technical differentiator:**

> An HR product can approve an expense claim. It cannot post the journal entry, because it does not own your books.
>
> CompanyOS does. An approved claim writes a balanced double-entry posting — expense against reimbursements payable — tagged with employee, project and department. So the claim shows up in the project's margin and in the cash-flow outlook the same second it is approved. No export, no month-end reconciliation, no integration to maintain.
>
> That is the whole argument for one database instead of five integrated products.

**Post 3 — the local angle:**

> Building HR software for Malaysia means getting the boring things exactly right.
>
> Public holidays vary by state — Selangor, Penang and Sarawak genuinely differ, and an office manager notices on day one. Some tenants run a Sunday–Thursday work week. Statutory minimums are a floor, but plenty of companies offer better terms, and software that fights that is software people stop using.
>
> So CompanyOS ships the holiday calendar with state variation, lets a tenant add or suppress any date, makes the work week configurable per employee, and treats Employment Act minimums as a warning rather than a hard block.
>
> A wrong leave balance destroys trust permanently. We wrote the tests first.

---

## 9. Assets included

| File | Size | Use |
|---|---|---|
| `companyos-logo-300.png` | 300×300 | Page logo (LinkedIn's minimum and its display size) |
| `companyos-logo-400.png` | 400×400 | Spare, for anywhere that wants more resolution |
| `companyos-logo-light-300.png` | 300×300 | Inverted mark, for dark backgrounds |
| `companyos-linkedin-cover-1128x191.png` | 1128×191 | Page cover image |
| `logo-dark.svg`, `logo-light.svg`, `cover.svg` | vector | Sources, if you want to change anything |

Brand values as used: near-black `#16181d`, dark surface `#0f1116`, off-white
`#e8eaed`, muted text `#9aa2b1`.
