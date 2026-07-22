/**
 * Enrichment port — fills missing lead fields from an external data source
 * (see docs/architecture/sales-module-design.md). Same shape as the llm/ and
 * delivery/ ports: an interface, a default that works without configuration,
 * and real providers that slot in behind getEnrichmentProvider().
 */

/** What the provider gets to work with — the lead's current identity fields. */
export interface LeadEnrichmentInput {
  name: string;
  company?: string | null;
  email?: string | null;
  phone?: string | null;
  title?: string | null;
}

/**
 * Fields the provider found. The service merges these into the lead but only
 * where the lead's own value is empty — enrichment never overwrites what an
 * operator typed.
 */
export type LeadEnrichmentResult = Partial<
  Record<"company" | "email" | "phone" | "title" | "notes", string>
>;

export interface EnrichmentProvider {
  readonly name: string;
  enrichLead(input: LeadEnrichmentInput): Promise<LeadEnrichmentResult>;
}
