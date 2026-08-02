import type { z } from "zod";
import { invoiceCreatedV1 } from "./invoice.created.v1";
import { invoiceSentV1 } from "./invoice.sent.v1";
import { invoiceOverdueV2 } from "./invoice.overdue.v2";
import { paymentReceivedV2 } from "./payment.received.v2";
import { paymentPartialV1 } from "./payment.partial.v1";
import { customerCreatedV1 } from "./customer.created.v1";
import { customerRiskFlaggedV1 } from "./customer.risk_flagged.v1";
import { customerNoContactV1 } from "./customer.no_contact.v1";
import { collectionsDecisionV1 } from "./collections.decision.v1";
import { dealCreatedV1 } from "./deal.created.v1";
import { dealStageChangedV1 } from "./deal.stage_changed.v1";
import { dealWonV1 } from "./deal.won.v1";
import { dealLostV1 } from "./deal.lost.v1";
import { activityLoggedV1 } from "./activity.logged.v1";
import { leadCreatedV1 } from "./lead.created.v1";
import { leadEnrichedV1 } from "./lead.enriched.v1";
import { leadConvertedV1 } from "./lead.converted.v1";
import { ticketCreatedV1 } from "./ticket.created.v1";
import { ticketMessageAddedV1 } from "./ticket.message_added.v1";
import { ticketStatusChangedV1 } from "./ticket.status_changed.v1";
import { ticketResolvedV1 } from "./ticket.resolved.v1";
import { projectCreatedV1 } from "./project.created.v1";
import { issueCreatedV1 } from "./issue.created.v1";
import { issueStatusChangedV1 } from "./issue.status_changed.v1";
import { issueCompletedV1 } from "./issue.completed.v1";
import { quoteCreatedV1 } from "./quote.created.v1";
import { quoteSentV1 } from "./quote.sent.v1";
import { quoteAcceptedV1 } from "./quote.accepted.v1";
import { quoteRejectedV1 } from "./quote.rejected.v1";
import { quoteExpiredV1 } from "./quote.expired.v1";
import { quoteConvertedV1 } from "./quote.converted.v1";
import { codePushV1 } from "./code.push.v1";
import { codePrOpenedV1 } from "./code.pr_opened.v1";
import { codePrMergedV1 } from "./code.pr_merged.v1";
import { emailReceivedV1 } from "./email.received.v1";
import { employeeCreatedV1 } from "./employee.created.v1";
import { employeeUpdatedV1 } from "./employee.updated.v1";
import { teamCreatedV1 } from "./team.created.v1";
import { approvalRequestedV1 } from "./approval.requested.v1";
import { approvalApprovedV1 } from "./approval.approved.v1";
import { approvalRejectedV1 } from "./approval.rejected.v1";
import { approvalNudgedV1 } from "./approval.nudged.v1";
import { claimSubmittedV1 } from "./claim.submitted.v1";
import { claimApprovedV1 } from "./claim.approved.v1";
import { claimRejectedV1 } from "./claim.rejected.v1";
import { claimPaidV1 } from "./claim.paid.v1";
import { leaveRequestedV1 } from "./leave.requested.v1";
import { leaveApprovedV1 } from "./leave.approved.v1";
import { leaveRejectedV1 } from "./leave.rejected.v1";
import { leaveCancelledV1 } from "./leave.cancelled.v1";

/**
 * event_type → current payload schema. The queue consumer refuses events whose
 * type is unknown or whose payload fails validation; those retry and then land
 * in the dead-letter queue rather than reaching agents malformed.
 *
 * Convention: each entry points at the latest version of that event's schema
 * (`invoice.overdue` → invoice.overdue.v1 today). When a payload changes
 * incompatibly, add a v2 file and bump the mapping here.
 */
export const eventRegistry: Record<string, z.ZodTypeAny> = {
  "invoice.created": invoiceCreatedV1,
  "invoice.sent": invoiceSentV1,
  "invoice.overdue": invoiceOverdueV2,
  "payment.received": paymentReceivedV2,
  "payment.partial": paymentPartialV1,
  "customer.created": customerCreatedV1,
  "customer.risk_flagged": customerRiskFlaggedV1,
  "customer.no_contact": customerNoContactV1,
  "collections.decision": collectionsDecisionV1,
  "deal.created": dealCreatedV1,
  "deal.stage_changed": dealStageChangedV1,
  "deal.won": dealWonV1,
  "deal.lost": dealLostV1,
  "activity.logged": activityLoggedV1,
  "lead.created": leadCreatedV1,
  "lead.enriched": leadEnrichedV1,
  "lead.converted": leadConvertedV1,
  "ticket.created": ticketCreatedV1,
  "ticket.message_added": ticketMessageAddedV1,
  "ticket.status_changed": ticketStatusChangedV1,
  "ticket.resolved": ticketResolvedV1,
  "project.created": projectCreatedV1,
  "issue.created": issueCreatedV1,
  "issue.status_changed": issueStatusChangedV1,
  "issue.completed": issueCompletedV1,
  "quote.created": quoteCreatedV1,
  "quote.sent": quoteSentV1,
  "quote.accepted": quoteAcceptedV1,
  "quote.rejected": quoteRejectedV1,
  "quote.expired": quoteExpiredV1,
  "quote.converted": quoteConvertedV1,
  "code.push": codePushV1,
  "code.pr_opened": codePrOpenedV1,
  "code.pr_merged": codePrMergedV1,
  "email.received": emailReceivedV1,
  "employee.created": employeeCreatedV1,
  "employee.updated": employeeUpdatedV1,
  "team.created": teamCreatedV1,
  // Approvals primitive (PRD-000b). There is deliberately no
  // `approval.cancelled`: cancellation happens because the SUBJECT went away,
  // and the subject module emits its own `*.cancelled` event. A second event
  // here would have the notification consumer telling an approver about work
  // that has simply evaporated.
  "approval.requested": approvalRequestedV1,
  "approval.approved": approvalApprovedV1,
  "approval.rejected": approvalRejectedV1,
  // PRD-007's nudge (S4). Registered rather than inserting a notification row
  // directly, so the notifications table keeps exactly one writer — see
  // SESSION-PLAN conflict C4 and src/schemas/events/approval.nudged.v1.ts.
  "approval.nudged": approvalNudgedV1,
  // Expense claims (PRD-006a). `source_module` is `people`, not `platform`:
  // claims are a business module's concern, and `platform` is reserved for
  // primitives that belong to no module.
  //
  // None of these four is mapped in the notification consumer, on purpose. The
  // `approval.*` events above already tell the approver a decision is needed and
  // the employee what was decided; adding claim.* mappers would put two rows in
  // the same bell for one submission. These exist for the audit log and for the
  // PeopleAgent PRD-006 designs for.
  "claim.submitted": claimSubmittedV1,
  "claim.approved": claimApprovedV1,
  "claim.rejected": claimRejectedV1,
  "claim.paid": claimPaidV1,

  // Leave requests (PRD-006c, S7). These are the DOMAIN facts and sit alongside
  // the primitive's `approval.*` audit facts rather than replacing them: one
  // decision emits both, because `approval.approved` is what notifies the
  // requester while `leave.approved` is what a PeopleAgent or a calendar feed
  // subscribes to. Unlike approvals, there IS a `leave.cancelled` — the subject
  // going away is exactly the fact this module owns.
  "leave.requested": leaveRequestedV1,
  "leave.approved": leaveApprovedV1,
  "leave.rejected": leaveRejectedV1,
  "leave.cancelled": leaveCancelledV1,
};

export function validatePayload(
  eventType: string,
  payload: unknown,
): { ok: true } | { ok: false; error: string } {
  const schema = eventRegistry[eventType];
  if (!schema) {
    return { ok: false, error: `unknown event_type: ${eventType}` };
  }
  const result = schema.safeParse(payload);
  if (!result.success) {
    return { ok: false, error: result.error.message };
  }
  return { ok: true };
}
