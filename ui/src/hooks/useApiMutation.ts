import { useMutation, useQueryClient, type QueryKey } from "@tanstack/react-query";
import { useAuth } from "../auth/AuthContext";
import type { ApiClient } from "../api/client";

/**
 * useMutation wired to the authed ApiClient, invalidating the given query
 * keys on success. Invalidation (not optimistic writes) is the default here
 * because the backend computes derived state — amount_due, ledger postings,
 * resolved_at — that the client can't guess.
 */
export function useApiMutation<TVars, TData>(opts: {
  mutationFn: (client: ApiClient, vars: TVars) => Promise<TData>;
  invalidates: (vars: TVars, data: TData) => QueryKey[];
  onSuccess?: (data: TData) => void;
}) {
  const { client } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: TVars) => opts.mutationFn(client!, vars),
    onSuccess: async (data, vars) => {
      await Promise.all(
        opts.invalidates(vars, data).map((queryKey) => queryClient.invalidateQueries({ queryKey })),
      );
      opts.onSuccess?.(data);
    },
  });
}
