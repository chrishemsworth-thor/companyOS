import type { ComponentType } from "react";
import type { Approval } from "../../../api/types";

/**
 * What every approval card renderer receives.
 *
 * Deliberately small. A renderer gets the approval row and a way to resolve user
 * names, and fetches whatever else its own subject needs itself — S5's claim card
 * loads the claim and its receipt, S7's leave card loads dates and the balance.
 * The shell knows nothing about any of it, which is what makes "adding a new
 * approvable type costs one renderer file" true.
 */
export interface ApprovalRendererProps {
  approval: Approval;
  /** `usr_...` → display name, falling back to the id when unknown. */
  userName: (userId: string | null) => string;
}

export type ApprovalRenderer = ComponentType<ApprovalRendererProps>;
