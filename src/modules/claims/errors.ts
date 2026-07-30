/**
 * Mirrors SupportError / ApprovalsError / FilesError: a code, a message, and the
 * status the route returns.
 *
 * Its own file rather than living in `service.ts` as the other modules do,
 * because `posting.ts` and `decision.ts` both throw it and `service.ts` imports
 * them — putting it there would be a cycle. `decision.ts` in particular must not
 * pull in the write path, since the approvals service imports it.
 *
 * `illegal_transition` -> 409 is the codebase's state-machine convention
 * (src/modules/support/state-machine.ts), which PRD-006's "an approved claim,
 * when edited, then 409" criterion needs to match.
 */
export class ClaimsError extends Error {
  constructor(
    readonly code:
      | "not_found"
      | "invalid_request"
      | "illegal_transition"
      | "forbidden"
      | "unpostable",
    message: string,
    readonly httpStatus: 400 | 403 | 404 | 409 | 422,
  ) {
    super(message);
    this.name = "ClaimsError";
  }
}
