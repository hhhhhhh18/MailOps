"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button, type ButtonVariant } from "./primitives";

/** ------------------------------------------------------------------------ */
/** Toasts                                                                    */
/** ------------------------------------------------------------------------ */

export type ToastTone = "success" | "error" | "info" | "warning";

export interface Toast {
  id: string;
  tone: ToastTone;
  title: string;
  description?: string;
  /** Optional inline action, e.g. "Undo" on a destructive operation. */
  action?: { label: string; onClick: () => void };
  durationMs?: number;
}

interface ToastContextValue {
  toast: (input: Omit<Toast, "id">) => void;
  success: (title: string, description?: string) => void;
  error: (title: string, description?: string) => void;
  info: (title: string, description?: string) => void;
  dismiss: (id: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const dismiss = useCallback((id: string) => {
    setToasts((current) => current.filter((item) => item.id !== id));
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const toast = useCallback(
    (input: Omit<Toast, "id">) => {
      const id = `toast_${Math.random().toString(36).slice(2, 9)}`;
      const duration = input.durationMs ?? (input.tone === "error" ? 8000 : 5000);

      setToasts((current) => [...current.slice(-3), { ...input, id }]);

      if (duration > 0) {
        timers.current.set(
          id,
          setTimeout(() => dismiss(id), duration),
        );
      }
    },
    [dismiss],
  );

  useEffect(
    () => () => {
      for (const timer of timers.current.values()) clearTimeout(timer);
      timers.current.clear();
    },
    [],
  );

  const value = useMemo<ToastContextValue>(
    () => ({
      toast,
      dismiss,
      success: (title, description) => toast({ tone: "success", title, description }),
      error: (title, description) => toast({ tone: "error", title, description }),
      info: (title, description) => toast({ tone: "info", title, description }),
    }),
    [toast, dismiss],
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-full max-w-sm flex-col gap-2">
        {toasts.map((item) => (
          <ToastCard key={item.id} toast={item} onDismiss={() => dismiss(item.id)} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function ToastCard({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  const Icon = toast.tone === "success" ? CheckCircle2 : toast.tone === "error" ? XCircle : toast.tone === "warning" ? AlertTriangle : Info;

  const toneClass =
    toast.tone === "success"
      ? "border-[color:var(--tone-success)]/40 text-[color:var(--tone-success)]"
      : toast.tone === "error"
        ? "border-[color:var(--tone-critical)]/40 text-[color:var(--tone-critical)]"
        : toast.tone === "warning"
          ? "border-[color:var(--tone-waiting)]/40 text-[color:var(--tone-waiting)]"
          : "border-[color:var(--tone-info)]/40 text-[color:var(--tone-info)]";

  return (
    <div
      role="status"
      className={cn(
        "pointer-events-auto animate-fade-in rounded-card border bg-[color:var(--surface-overlay)] p-3 shadow-popover",
        toneClass,
      )}
    >
      <div className="flex items-start gap-2.5">
        <Icon className="mt-0.5 h-4 w-4 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium text-[color:var(--content-primary)]">{toast.title}</p>
          {toast.description && <p className="mt-0.5 text-xs text-secondary">{toast.description}</p>}
          {toast.action && (
            <button
              type="button"
              onClick={() => {
                toast.action?.onClick();
                onDismiss();
              }}
              className="mt-1.5 text-xs font-medium underline underline-offset-2"
            >
              {toast.action.label}
            </button>
          )}
        </div>
        <button type="button" onClick={onDismiss} aria-label="Dismiss" className="text-muted hover:text-[color:var(--content-primary)]">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);
  if (!context) throw new Error("useToast must be used inside ToastProvider");
  return context;
}

/** ------------------------------------------------------------------------ */
/** Modal                                                                     */
/** ------------------------------------------------------------------------ */

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = "md",
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  size?: "sm" | "md" | "lg" | "xl";
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    // Prevent background scroll while the modal owns the viewport.
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [open, onClose]);

  if (!open) return null;

  const width = size === "sm" ? "max-w-md" : size === "lg" ? "max-w-3xl" : size === "xl" ? "max-w-5xl" : "max-w-xl";

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-0 sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-label={title}>
      <button type="button" className="absolute inset-0 cursor-default" aria-label="Close" onClick={onClose} />
      <div
        className={cn(
          "relative z-10 flex max-h-[92vh] w-full flex-col overflow-hidden rounded-t-2xl border border-[color:var(--surface-border)] bg-[color:var(--surface-raised)] shadow-popover sm:rounded-card",
          width,
        )}
      >
        <header className="flex items-start justify-between gap-4 border-b border-[color:var(--surface-border)] px-5 py-3.5">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-[color:var(--content-primary)]">{title}</h2>
            {description && <p className="mt-0.5 text-xs text-muted">{description}</p>}
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="text-muted hover:text-[color:var(--content-primary)]">
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>

        {footer && <footer className="flex items-center justify-end gap-2 border-t border-[color:var(--surface-border)] px-5 py-3">{footer}</footer>}
      </div>
    </div>
  );
}

/** ------------------------------------------------------------------------ */
/** Confirm dialog                                                            */
/** ------------------------------------------------------------------------ */

export interface ConfirmDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  description: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: ButtonVariant;
  loading?: boolean;
  /** Requires the user to type this exact word to enable confirmation. */
  requirePhrase?: string;
}

/**
 * Confirmation for destructive actions.
 *
 * `requirePhrase` exists for the genuinely irreversible cases (deleting stored
 * email data); a single click should not be enough for those.
 */
export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  variant = "danger",
  loading,
  requirePhrase,
}: ConfirmDialogProps) {
  const [phrase, setPhrase] = useState("");

  useEffect(() => {
    if (open) setPhrase("");
  }, [open]);

  const phraseOk = !requirePhrase || phrase.trim().toLowerCase() === requirePhrase.toLowerCase();

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={loading}>
            {cancelLabel}
          </Button>
          <Button variant={variant} onClick={onConfirm} loading={loading} disabled={!phraseOk}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-xs text-secondary">{description}</div>
      {requirePhrase && (
        <div className="mt-4 space-y-1.5">
          <label htmlFor="confirm-phrase" className="block text-xs text-muted">
            Type <span className="font-mono text-[color:var(--content-primary)]">{requirePhrase}</span> to confirm
          </label>
          <input
            id="confirm-phrase"
            value={phrase}
            onChange={(event) => setPhrase(event.target.value)}
            className="w-full rounded-lg border border-[color:var(--surface-border)] bg-[color:var(--surface-base)] px-3 py-2 text-sm"
            autoComplete="off"
          />
        </div>
      )}
    </Modal>
  );
}
