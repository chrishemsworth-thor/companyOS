import { describe, it, expect, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { AuthProvider } from "../auth/AuthContext";
import { useApiMutation } from "./useApiMutation";

function makeWrapper(queryClient: QueryClient) {
  sessionStorage.setItem("companyos_api_key", "key_test");
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>{children}</AuthProvider>
    </QueryClientProvider>
  );
}

describe("useApiMutation", () => {
  it("runs the mutation with the authed client and invalidates the given keys", async () => {
    const queryClient = new QueryClient();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    const onSuccess = vi.fn();

    const { result } = renderHook(
      () =>
        useApiMutation({
          mutationFn: async (_client, vars: { id: string }) => ({ created: vars.id }),
          invalidates: (vars, data) => [["things"], ["thing", vars.id, data.created]],
          onSuccess,
        }),
      { wrapper: makeWrapper(queryClient) },
    );

    result.current.mutate({ id: "x1" });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["things"] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["thing", "x1", "x1"] });
    expect(onSuccess).toHaveBeenCalledWith({ created: "x1" });
  });

  it("surfaces mutation errors without invalidating", async () => {
    const queryClient = new QueryClient();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    const { result } = renderHook(
      () =>
        useApiMutation({
          mutationFn: async () => {
            throw new Error("boom");
          },
          invalidates: () => [["things"]],
        }),
      { wrapper: makeWrapper(queryClient) },
    );

    result.current.mutate(undefined as never);
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(invalidateSpy).not.toHaveBeenCalled();
  });
});
