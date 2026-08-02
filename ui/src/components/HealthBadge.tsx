import { Badge, type Tone } from "./Badge";
import type { HealthBand } from "../api/types";

const TONE_BY_BAND: Record<HealthBand, Tone> = {
  good: "good",
  watch: "warn",
  at_risk: "bad",
};

const LABEL_BY_BAND: Record<HealthBand, string> = {
  good: "Good",
  watch: "Watch",
  at_risk: "At risk",
};

/**
 * PRD-003 customer health. A signal only — nothing in the product acts on this
 * band, it exists so a human can see the account at a glance. The reasons panel
 * on the customer detail page is the part that is actually actionable.
 */
export function HealthBadge({ band }: { band: HealthBand }) {
  return <Badge tone={TONE_BY_BAND[band]}>{LABEL_BY_BAND[band]}</Badge>;
}
