#!/usr/bin/env node
// Populates a seeded tenant with realistic sample data across all four
// modules by calling the live /v1/* API — useful for poking around the
// operator console (ui/) or the API by hand without inventing data by hand.
//
// Usage:
//   npm run seed:sample -- --api-key <key> [--base-url http://localhost:8787]
//
// Requires `npm run dev` (the Worker) already running and a tenant already
// seeded via `npm run seed:local` (that command prints the --api-key value).

function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : fallback;
}

const baseUrl = arg("--base-url", "http://localhost:8787");
const apiKey = arg("--api-key", process.env.API_KEY);

if (!apiKey) {
  console.error(
    "Missing --api-key (or API_KEY env var). Run `npm run seed:local` first to get one.",
  );
  process.exit(1);
}

async function api(method, path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`${method} ${path} → ${res.status}: ${JSON.stringify(json)}`);
  }
  return json;
}

function daysFromNow(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

async function main() {
  console.log(`Seeding sample data into ${baseUrl} ...`);

  // --- CRM: customers ---------------------------------------------------
  const acme = await api("POST", "/v1/customers", {
    name: "Acme Corp",
    email: "ap@acme.test",
    phone: "+15551234567",
  });
  const globex = await api("POST", "/v1/customers", {
    name: "Globex Inc",
    email: "billing@globex.test",
  });
  const initech = await api("POST", "/v1/customers", {
    name: "Initech LLC",
    email: "finance@initech.test",
  });
  console.log(`Customers: ${acme.name}, ${globex.name}, ${initech.name}`);

  // --- Finance: three invoices in different lifecycle states -------------
  // 1. Acme — sent, not yet due (shows as "sent" on the dashboard/list).
  const invAcme = await api("POST", "/v1/invoices", {
    customer_id: acme.customer_id,
    currency: "USD",
    due_date: daysFromNow(30),
    lines: [{ description: "Consulting — July", quantity: 10, unit_cents: 15000 }],
  });
  await api("POST", `/v1/invoices/${invAcme.invoice_id}/send`);

  // 2. Globex — sent with a due date in the past, then the overdue sweep is
  //    triggered below to flip it to "overdue" so the dashboard has
  //    something to show in that stat.
  const invGlobex = await api("POST", "/v1/invoices", {
    customer_id: globex.customer_id,
    currency: "USD",
    due_date: daysFromNow(-10),
    lines: [{ description: "Platform license — Q2", quantity: 1, unit_cents: 250000 }],
  });
  await api("POST", `/v1/invoices/${invGlobex.invoice_id}/send`);

  // 3. Initech — sent and fully paid, to populate payment history + ledger.
  const invInitech = await api("POST", "/v1/invoices", {
    customer_id: initech.customer_id,
    currency: "USD",
    due_date: daysFromNow(14),
    lines: [{ description: "Onboarding package", quantity: 1, unit_cents: 80000 }],
  });
  await api("POST", `/v1/invoices/${invInitech.invoice_id}/send`);
  await api("POST", "/v1/payments", {
    customer_id: initech.customer_id,
    amount_cents: 80000,
    currency: "USD",
    method: "bank_transfer",
    applications: [{ invoice_id: invInitech.invoice_id, applied_cents: 80000 }],
  });
  console.log("Invoices: Acme (sent), Globex (past due), Initech (paid)");

  // Trigger the daily overdue sweep manually (wrangler dev doesn't fire
  // cron on its own) so Globex's invoice actually flips to "overdue" and
  // the CollectionsAgent gets a reminder-sending run in.
  try {
    await fetch(`${baseUrl}/cdn-cgi/handler/scheduled`);
    console.log("Triggered the overdue sweep (Globex's invoice should now be 'overdue').");
  } catch {
    console.log("Could not trigger the overdue sweep automatically — run this manually:");
    console.log(`  curl "${baseUrl}/cdn-cgi/handler/scheduled"`);
  }

  // --- CRM: activity + deals ---------------------------------------------
  await api("POST", "/v1/activities", {
    customer_id: acme.customer_id,
    kind: "call",
    body: "Kickoff call — scoped the July consulting engagement.",
  });

  const stages = await api("GET", "/v1/deals/stages");
  const wonStage = stages.stages.find((s) => s.is_won);
  const proposalStage = stages.stages.find((s) => s.name === "Proposal");

  const dealAcme = await api("POST", "/v1/deals", {
    customer_id: acme.customer_id,
    title: "Acme — annual consulting retainer",
    value_cents: 1200000,
    currency: "USD",
  });
  if (proposalStage) {
    await api("POST", `/v1/deals/${dealAcme.deal_id}/stage`, { stage_id: proposalStage.stage_id });
  }

  const dealGlobex = await api("POST", "/v1/deals", {
    customer_id: globex.customer_id,
    title: "Globex — platform expansion",
    value_cents: 450000,
    currency: "USD",
  });
  if (wonStage) {
    await api("POST", `/v1/deals/${dealGlobex.deal_id}/stage`, { stage_id: wonStage.stage_id });
  }
  console.log("Deals: Acme (proposal), Globex (won)");

  // --- Support: tickets ----------------------------------------------------
  const ticketOpen = await api("POST", "/v1/tickets", {
    customer_id: acme.customer_id,
    subject: "SSO login intermittently fails",
    priority: "high",
    body: "Getting redirected back to the login screen about 1 in 5 attempts.",
  });
  await api("POST", `/v1/tickets/${ticketOpen.ticket_id}/messages`, {
    author: "agent",
    body: "Looking into it — can you share the timestamps of the last failures?",
  });

  const ticketResolved = await api("POST", "/v1/tickets", {
    customer_id: initech.customer_id,
    subject: "How do I export invoices to CSV?",
    priority: "low",
    body: "Is there a bulk export option?",
  });
  await api("POST", `/v1/tickets/${ticketResolved.ticket_id}/messages`, {
    author: "agent",
    body: "Not yet, but GET /v1/invoices returns JSON you can pipe into a CSV converter.",
  });
  await api("POST", `/v1/tickets/${ticketResolved.ticket_id}/status`, { status: "resolved" });
  console.log("Tickets: 1 open (high priority), 1 resolved");

  // --- Build: project + issues --------------------------------------------
  const project = await api("POST", "/v1/projects", { name: "Operator Console" });
  await api("POST", "/v1/issues", {
    project_id: project.project_id,
    title: "Add pagination to list endpoints",
    priority: "medium",
  });
  const issueInProgress = await api("POST", "/v1/issues", {
    project_id: project.project_id,
    title: "Wire CORS for the operator UI",
    priority: "high",
    assignee: "platform-team",
  });
  await api("POST", `/v1/issues/${issueInProgress.issue_id}/status`, { status: "in_progress" });
  const issueDone = await api("POST", "/v1/issues", {
    project_id: project.project_id,
    title: "Ship read-only operator console MVP",
    priority: "high",
  });
  await api("POST", `/v1/issues/${issueDone.issue_id}/status`, { status: "done" });
  console.log("Project: Operator Console (3 issues: todo, in_progress, done)");

  console.log("\nDone. Open the operator console and connect with your API key to look around.");
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
