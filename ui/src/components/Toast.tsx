import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { CheckCircle2, AlertCircle, Info, X } from "lucide-react";
import { cn } from "../lib/cn";

type Tone = "success" | "error" | "info";

interface ToastItem {
  id: number;
  tone: Tone;
  title: string;
  description?: string;
}

interface ToastApi {
  show: (title: string, opts?: { tone?: Tone; description?: string }) => void;
  success: (title: string, description?: string) => void;
  error: (title: string, description?: string) => void;
  dismiss: (id: number) => void;
}

const noop = () => {};
/** Default no-op API so components using useToast render fine without a provider (e.g. in tests). */
const ToastContext = createContext<ToastApi>({ show: noop, success: noop, error: noop, dismiss: noop });

export function useToast(): ToastApi {
  return useContext(ToastContext);
}

const TONE_STYLES: Record<Tone, { icon: ReactNode; accent: string }> = {
  success: { icon: <CheckCircle2 className="size-5 text-good" />, accent: "border-l-good" },
  error: { icon: <AlertCircle className="size-5 text-bad" />, accent: "border-l-bad" },
  info: { icon: <Info className="size-5 text-accent" />, accent: "border-l-accent" },
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setToasts((cur) => cur.filter((t) => t.id !== id));
  }, []);

  const show = useCallback(
    (title: string, opts?: { tone?: Tone; description?: string }) => {
      const id = nextId.current++;
      setToasts((cur) => [...cur, { id, title, tone: opts?.tone ?? "info", description: opts?.description }]);
      setTimeout(() => dismiss(id), 4500);
    },
    [dismiss],
  );

  const api = useMemo<ToastApi>(
    () => ({
      show,
      success: (title, description) => show(title, { tone: "success", description }),
      error: (title, description) => show(title, { tone: "error", description }),
      dismiss,
    }),
    [show, dismiss],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        className="fixed z-[100] bottom-0 right-0 left-0 sm:left-auto flex flex-col gap-2 p-4 pointer-events-none"
        aria-live="polite"
        aria-atomic="false"
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            role="status"
            className={cn(
              "pointer-events-auto flex items-start gap-3 w-full sm:w-96 ml-auto",
              "bg-surface border border-border border-l-4 rounded-md shadow-lg p-3.5",
              "animate-[toast-in_180ms_ease-out]",
              TONE_STYLES[t.tone].accent,
            )}
          >
            <span className="shrink-0 mt-0.5">{TONE_STYLES[t.tone].icon}</span>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-semibold text-fg">{t.title}</div>
              {t.description && <div className="text-sm text-muted mt-0.5 break-words">{t.description}</div>}
            </div>
            <button
              onClick={() => dismiss(t.id)}
              aria-label="Dismiss"
              className="shrink-0 text-subtle hover:text-fg transition-colors cursor-pointer"
            >
              <X className="size-4" />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
