import { GenericApprovalCard } from "./GenericApprovalCard";
import type { ApprovalRenderer } from "./types";

/**
 * `subject_type` → context card renderer (PRD-007 § "Type-specific context
 * renderers").
 *
 * The inbox shell is generic: it lists approvals, shows age, and offers
 * approve/reject. Everything that differs per subject — a receipt image, a leave
 * balance, a quote total — lives in a renderer registered here. PRD-007's success
 * metric is that "adding a new approvable type costs one renderer file and no
 * changes to the inbox shell", and this map is where that one file gets plugged
 * in.
 *
 * **S4 registers nothing.** The table below is empty on purpose:
 *
 *  - `leave_request` → S7 (PRD-006c), with dates, working days, remaining balance
 *    after approval, overlapping team leave and the attachment.
 *  - `expense_claim` → S5 (PRD-006a), with the receipt image inline and zoomable.
 *  - `quote` → S9 (PRD-004), with total, validity, lines and discount.
 *  - `invoice` → never. It is a reserved subject type nothing creates
 *    (SESSION-PLAN conflict C5); the fallback covers it.
 *
 * A static map rather than a `register()` call at import time, matching how the
 * codebase does registries elsewhere (`eventRegistry`, `AGENT_ROUTES`,
 * `SUBJECT_ROUTES`). Runtime registration would mean a renderer's module has to
 * be imported for its type to work, which is a lazy-loading bug waiting to
 * happen — a card that silently falls back because nothing pulled its file in.
 */
const RENDERERS: Record<string, ApprovalRenderer> = {};

/**
 * The renderer for a subject type, or the generic fallback.
 *
 * Never returns undefined and never throws. An unknown `subject_type` is a normal
 * runtime condition, not an error: the API column has no CHECK, so a newer server
 * can hand this bundle a type it has never heard of, and PRD-007 requires that to
 * render rather than crash.
 */
export function getApprovalRenderer(subjectType: string): ApprovalRenderer {
  return RENDERERS[subjectType] ?? GenericApprovalCard;
}

/** True when a purpose-built card exists. Exported for the registry's own tests. */
export function hasApprovalRenderer(subjectType: string): boolean {
  return subjectType in RENDERERS;
}

/** Subject types with a purpose-built card. Empty in S4 — see above. */
export function registeredSubjectTypes(): string[] {
  return Object.keys(RENDERERS);
}
