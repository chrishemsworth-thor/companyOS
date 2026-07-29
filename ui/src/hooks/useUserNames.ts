import { useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "../auth/AuthContext";

interface DirectoryUser {
  user_id: string;
  display_name: string | null;
  email: string;
}

/**
 * `usr_...` → display name, for the caller's tenant.
 *
 * Backed by `GET /v1/meta/users`, which any authenticated user may read —
 * `/v1/users` is admin-only, and a manager who is not an admin still has to see
 * "requested by Aisha" on an approval card. Cached for a long while: names change
 * about never, and the approvals inbox would otherwise refetch the whole
 * directory on every tab switch.
 *
 * Falls back to the raw id rather than an empty string, so a user who was
 * deleted or belongs to a page the directory has not loaded yet degrades to
 * something identifiable instead of a blank cell.
 */
export function useUserNames(): (userId: string | null) => string {
  const { client } = useAuth();

  const query = useQuery({
    queryKey: ["meta", "users"],
    queryFn: () => client!.get<{ users: DirectoryUser[] }>("/v1/meta/users"),
    enabled: !!client,
    staleTime: 5 * 60_000,
  });

  const users = query.data?.users;
  return useCallback(
    (userId: string | null) => {
      if (!userId) return "—";
      const match = users?.find((u) => u.user_id === userId);
      if (!match) return userId;
      return match.display_name?.trim() || match.email;
    },
    [users],
  );
}
