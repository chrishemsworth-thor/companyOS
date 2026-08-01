import { useEffect, useRef, useState } from "react";
import { FileText, ImageOff, Maximize2 } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "../../../auth/AuthContext";

/**
 * A claim receipt, inline and zoomable (PRD-006a; PRD-007's "images tappable to
 * full screen" on mobile).
 *
 * **Why the bytes are fetched rather than put in `<img src>`.** The session cookie
 * is `SameSite=Lax`, which excludes cross-origin subresource requests, and the
 * console and API are separate origins in every deployment — so a plain `src`
 * would send no credential and 401. The bytes therefore come through the API
 * client with `credentials: 'include'` and are rendered from an object URL, which
 * is revoked on unmount.
 *
 * The endpoint is `/v1/claims/:id/lines/:n/receipt`, not `/v1/files/:id`:
 * authorization follows the claim, and neither the filer nor the approver
 * typically holds any `files` capability.
 */

export interface ReceiptThumbnailProps {
  claimId: string;
  lineNo: number;
  filename: string | null;
  contentType: string | null;
}

/** Object URL for the receipt, revoked when the component goes away. */
function useReceiptObjectUrl(claimId: string, lineNo: number, enabled: boolean) {
  const { client } = useAuth();
  const [url, setUrl] = useState<string | null>(null);
  // Kept in a ref as well as state so cleanup revokes the URL it actually
  // created, even if a re-render has already replaced the state.
  const created = useRef<string | null>(null);

  const query = useQuery({
    queryKey: ["claims", claimId, "receipt", lineNo],
    queryFn: () => client!.getBlob(`/v1/claims/${claimId}/lines/${lineNo}/receipt`),
    enabled: enabled && !!client,
    // Uploads are immutable, so the bytes behind a line never change.
    staleTime: Infinity,
    retry: false,
  });

  useEffect(() => {
    if (!query.data) return;
    const objectUrl = URL.createObjectURL(query.data);
    created.current = objectUrl;
    setUrl(objectUrl);
    return () => {
      URL.revokeObjectURL(objectUrl);
      if (created.current === objectUrl) created.current = null;
      setUrl(null);
    };
  }, [query.data]);

  return { url, isLoading: query.isLoading, isError: query.isError };
}

/** The shared "nothing to show" tile, so every failure mode reads the same. */
function ReceiptPlaceholder({ label, icon }: { label: string; icon: React.ReactNode }) {
  return (
    <div className="flex h-32 w-full flex-col items-center justify-center gap-1 rounded-md border border-dashed border-border bg-surface-2 px-3 text-center text-xs text-subtle">
      {icon}
      <span>{label}</span>
    </div>
  );
}

export function ReceiptThumbnail({
  claimId,
  lineNo,
  filename,
  contentType,
}: ReceiptThumbnailProps) {
  const { baseUrl } = useAuth();
  const [zoomed, setZoomed] = useState(false);
  const isImage = (contentType ?? "").startsWith("image/");
  // A PDF receipt is legitimate (the file policy allows it) and cannot be shown
  // in an <img>, so it is offered as a download instead of being fetched here.
  const { url, isLoading, isError } = useReceiptObjectUrl(claimId, lineNo, isImage);

  // Escape closes the zoom. Registered only while open, so it cannot swallow the
  // key from anything else on the page.
  useEffect(() => {
    if (!zoomed) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setZoomed(false);
    };
    document.addEventListener("keydown", onKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [zoomed]);

  // The receipt row was kept but its file is gone (soft-deleted). PRD-007's
  // principle: render as unavailable rather than erroring.
  if (!contentType) {
    return (
      <ReceiptPlaceholder
        label="Receipt unavailable"
        icon={<ImageOff className="size-5" aria-hidden />}
      />
    );
  }

  if (!isImage) {
    return (
      <a
        // Absolute against the API origin, not a relative path: the console and
        // the API are separate origins, so a relative href would 404 on the
        // console's own server. This one is safe as a plain link because opening
        // it is a top-level navigation, which `SameSite=Lax` does send the cookie
        // on — unlike the `<img>` subresource request the image path avoids.
        href={`${baseUrl}/v1/claims/${claimId}/lines/${lineNo}/receipt`}
        target="_blank"
        rel="noreferrer"
        className="flex h-32 w-full flex-col items-center justify-center gap-1 rounded-md border border-border bg-surface-2 px-3 text-center text-xs font-medium text-fg"
      >
        <FileText className="size-5 text-subtle" aria-hidden />
        <span>Open {filename ?? "receipt"}</span>
      </a>
    );
  }

  if (isLoading) {
    return (
      <div
        role="status"
        aria-label="Loading receipt"
        className="h-32 w-full animate-pulse rounded-md bg-surface-2"
      />
    );
  }

  if (isError || !url) {
    return (
      <ReceiptPlaceholder
        label="Receipt could not be loaded"
        icon={<ImageOff className="size-5" aria-hidden />}
      />
    );
  }

  const alt = `Receipt for line ${lineNo}${filename ? ` (${filename})` : ""}`;

  return (
    <>
      {/* A real button, not an <img onClick>: PRD-007's mobile criterion wants a
          tappable target, and min-h-40 keeps it above the 40px floor S4 pinned. */}
      <button
        type="button"
        onClick={() => setZoomed(true)}
        aria-label={`${alt} — tap to view full screen`}
        className="group relative block min-h-40 w-full overflow-hidden rounded-md border border-border bg-surface-2 focus:outline-none focus:ring-2 focus:ring-ring"
      >
        <img src={url} alt={alt} className="h-32 w-full object-cover" />
        <span className="absolute bottom-1 right-1 rounded bg-black/60 p-1 text-white opacity-80 group-hover:opacity-100">
          <Maximize2 className="size-3.5" aria-hidden />
        </span>
      </button>

      {zoomed && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={alt}
          // The backdrop closes it too — on a phone that is the gesture people
          // reach for before finding a close button.
          onClick={() => setZoomed(false)}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
        >
          <img
            src={url}
            alt={alt}
            className="max-h-full max-w-full object-contain"
            onClick={(e) => e.stopPropagation()}
          />
          <button
            type="button"
            onClick={() => setZoomed(false)}
            className="absolute right-3 top-3 min-h-10 rounded-md bg-white/90 px-3 py-2 text-sm font-semibold text-black"
          >
            Close
          </button>
        </div>
      )}
    </>
  );
}
