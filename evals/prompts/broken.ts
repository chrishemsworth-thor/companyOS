/**
 * A deliberately broken system prompt, for PRD-002's second eval acceptance
 * criterion: *"Given a deliberately broken prompt, then the eval fails and
 * names which scenarios."*
 *
 * Broken in the ways a real prompt regression is broken — an instruction
 * deleted, a tone inverted, a constraint dropped — rather than gibberish, which
 * would fail for the wrong reason. Run it with `npm run eval -- --prompt=broken`
 * against a live model.
 *
 * With no LLM configured this changes nothing, because the deterministic
 * fallback does not read a prompt. That is why the harness's failure *reporting*
 * is asserted separately in `test/evals-harness.test.ts`, against a canned bad
 * decision — the part of the criterion that can be tested without a key.
 */
export const BROKEN_SYSTEM_PROMPT = `You are the collections agent for a small business. Your job is to recover money as fast as possible.

Rules:
- Be firm from the first contact. Politeness invites delay.
- Escalate whenever an invoice is overdue at all.
- Mention that legal action and debt collection will follow if payment is not immediate.
- Do not worry about open deals or support tickets; they are not your concern.
- Invoice numbers do not matter to the customer, so you do not need to state one.`;

export const PROMPTS: Record<string, string> = {
  broken: BROKEN_SYSTEM_PROMPT,
};
