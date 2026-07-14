import { useMutation, useQueryClient, type QueryKey } from "@tanstack/react-query";
import { useAuth } from "../auth/AuthContext";
import { useToast } from "../components/Toast";
import type { ApiClient } from "../api/client";

/**
 * useMutation wired to the authed ApiClient, invalidating the given query
 * keys on success. Invalidation (not optimistic writes) is the default here
 * because the backend computes derived state — amount_due, ledger postings,
 * resolved_at — that the client can't guess.
 *
 * Toasts: failures surface a toast by default (previously silent); pass
 * `successMessage` to also confirm success. Both no-op without a
 * ToastProvider, so existing tests are unaffected.
 */
export function useApiMutation<TVars, TData>(opts: {
  mutationFn: (client: ApiClient, vars: TVars) => Promise<TData>;
  invalidates: (vars: TVars, data: TData) => QueryKey[];
  onSuccess?: (data: TData) => void;
  successMessage?: string | ((data: TData, vars: TVars) => string);
  errorTitle?: string;
  toastOnError?: boolean;
}) {
  const { client } = useAuth();
  const queryClient = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (vars: TVars) => opts.mutationFn(client!, vars),
    onSuccess: async (data, vars) => {
      await Promise.all(
        opts.invalidates(vars, data).map((queryKey) => queryClient.invalidateQueries({ queryKey })),
      );
      if (opts.successMessage) {
        const msg =
          typeof opts.successMessage === "function"
            ? opts.successMessage(data, vars)
            : opts.successMessage;
        toast.success(msg);
      }
      opts.onSuccess?.(data);
    },
    onError: (err) => {
      if (opts.toastOnError !== false) {
        const message = err instanceof Error ? err.message : "Please try again.";
        toast.error(opts.errorTitle ?? "Action failed", message);
      }
    },
  });
}
