import type { EnrichmentProvider } from "./types";

/** Default provider: finds nothing, honestly. Keeps callers branch-free. */
export class NoopEnrichment implements EnrichmentProvider {
  readonly name = "noop";

  async enrichLead(): Promise<Record<string, never>> {
    return {};
  }
}
