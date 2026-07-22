import type { Env } from "../env";
import type { EnrichmentProvider } from "./types";
import { NoopEnrichment } from "./noop";

export type { EnrichmentProvider, LeadEnrichmentInput, LeadEnrichmentResult } from "./types";

type EnrichmentFactory = (env: Env) => EnrichmentProvider;

/** Test seam (same pattern as the llm port): tests inject a stub provider. */
let overrideFactory: EnrichmentFactory | null = null;

export function setEnrichmentProviderFactoryForTests(factory: EnrichmentFactory | null): void {
  overrideFactory = factory;
}

/**
 * Provider selection point. Unlike the llm port this never returns null —
 * the no-op provider is a valid provider (it just never finds anything), so
 * callers stay branch-free. Real data providers (Apollo-style) register here
 * behind ENRICHMENT_PROVIDER when they land.
 */
export function getEnrichmentProvider(env: Env): EnrichmentProvider {
  if (overrideFactory) return overrideFactory(env);

  switch (env.ENRICHMENT_PROVIDER) {
    case "noop":
    case undefined:
      break;
    default:
      console.warn(
        `[enrichment] unknown ENRICHMENT_PROVIDER "${env.ENRICHMENT_PROVIDER}", using noop`,
      );
  }
  return new NoopEnrichment();
}
