/**
 * `subject_type` → console route.
 *
 * This map lives in the console, next to the router, and NOT in the API payload.
 * A notification row says what it is about; where that lives in this particular
 * frontend is a frontend concern. Putting a path on the payload would make the
 * backend own console routes, and every route rename would then be a server
 * deploy.
 *
 * Returning `null` is a first-class answer, used in two distinct cases:
 *
 *  - a `subject_type` this bundle does not know (a newer server, a module that
 *    landed after this build), and
 *  - a subject that has no detail screen of its own.
 *
 * Either way the caller renders the item as unavailable rather than linking
 * nowhere — PRD-007's criterion that a notification whose subject was deleted or
 * cancelled "renders as unavailable rather than erroring".
 */

type RouteBuilder = (subjectId: string) => string;

const SUBJECT_ROUTES: Record<string, RouteBuilder> = {
  quote: (id) => `/quotes/${id}`,
  invoice: (id) => `/invoices/${id}`,
  // `leave_request` and `expense_claim` are deliberately ABSENT. Their screens
  // ship with S7 and S5 respectively; until then the generic fallback is the
  // honest answer, and adding a route to a page that does not exist would send
  // a user to the catch-all redirect instead. Each session adds its own line
  // here — that plus a renderer is the whole cost of a new approvable type.
};

/** The route for a subject, or null when this build cannot show it. */
export function subjectRoute(subjectType: string, subjectId: string): string | null {
  const build = SUBJECT_ROUTES[subjectType];
  return build ? build(subjectId) : null;
}

/** Subject types this build can deep-link to. Exported for the parity test. */
export function linkableSubjectTypes(): string[] {
  return Object.keys(SUBJECT_ROUTES);
}

/**
 * Human wording for a subject type in console chrome — filter labels, dropdown
 * group headings, card titles.
 *
 * Intentionally separate from the server's label map (which renders stored
 * notification titles). A stored title is a historical record of what a user was
 * told and must not change wording when the console relabels a filter; these
 * labels are live UI and may.
 */
const SUBJECT_LABELS: Record<string, string> = {
  leave_request: "Leave request",
  expense_claim: "Expense claim",
  quote: "Quote",
  invoice: "Invoice",
  other: "Request",
};

export function subjectLabel(subjectType: string): string {
  return (
    SUBJECT_LABELS[subjectType] ??
    // Unknown type: `purchase_order` → `Purchase order`. Readable, and visibly
    // not a designed label, which is the right signal.
    subjectType.replace(/_/g, " ").replace(/^./, (ch) => ch.toUpperCase())
  );
}

/**
 * Human wording for a notification `type` (the source event_type), used to group
 * the bell dropdown. Unknown types group under their raw value rather than being
 * hidden — a notification nobody labelled is still a notification.
 */
const NOTIFICATION_TYPE_LABELS: Record<string, string> = {
  "approval.requested": "Awaiting your decision",
  "approval.approved": "Approved",
  "approval.rejected": "Rejected",
  "approval.nudged": "Reminders",
};

export function notificationTypeLabel(type: string): string {
  return NOTIFICATION_TYPE_LABELS[type] ?? type;
}
