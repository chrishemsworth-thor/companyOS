import { z } from "zod";

export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 200;

/** Shared query schema for list endpoints: `?limit=&cursor=`. */
export const pageQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(MAX_PAGE_LIMIT).default(DEFAULT_PAGE_LIMIT),
  cursor: z.string().optional(),
});
export type PageQuery = z.infer<typeof pageQuerySchema>;

export interface CursorPage<T> {
  items: T[];
  next_cursor: string | null;
}

/**
 * Cursor pagination on an id column. IDs are ULIDs (time-sortable), so
 * `ORDER BY id ASC` with `id > cursor` gives stable, non-overlapping pages
 * as new rows are inserted — no offset drift.
 *
 * Fetches `limit + 1` rows; the caller passes that oversized result here to
 * detect whether another page follows without a second COUNT query.
 */
export function paginate<T>(rows: T[], limit: number, idKey: keyof T): CursorPage<T> {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];
  const next_cursor = hasMore && last ? String(last[idKey]) : null;
  return { items, next_cursor };
}
