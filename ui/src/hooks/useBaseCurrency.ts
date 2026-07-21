import { useQuery } from "@tanstack/react-query";
import { useAuth } from "../auth/AuthContext";
import type { CompanyProfile } from "../api/types";

/**
 * The company's base currency — the default for new documents. Shares the
 * settings page's query key, so it's usually already cached. Falls back to
 * MYR while loading or when no profile row exists yet.
 */
export function useBaseCurrency(): string {
  const { client } = useAuth();
  const query = useQuery({
    queryKey: ["settings", "company-profile"],
    queryFn: () => client!.get<{ company_profile: CompanyProfile | null }>("/v1/settings/company-profile"),
    enabled: !!client,
  });
  return query.data?.company_profile?.base_currency ?? "MYR";
}
