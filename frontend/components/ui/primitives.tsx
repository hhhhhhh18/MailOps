"use client";

import { forwardRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { Loader2 } from "lucide-react";
import { cn, TONE_CLASSES, type Tone } from "@/lib/utils";

/**
 * UI primitives.
 *
 * Intentionally small and unopinionated: a dense, dark, information-first SaaS
 * look. No gradients, no decorative animation, no oversized type.
 */

/** ------------------------------------------------------------------------ */
/** Button                                                                    */
/** ------------------------------------------------------------------------ */

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "success";
export type ButtonSize = "sm" | "md" | "lg" | "icon";

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary:
    "bg-[color:var(--tone-accent)] text-[color:var(--surface-base)] hover:brightness-110 disabled:bg-[color:var(--tone-accent)]/50",
  secondary:
    "border border-[color:var(--surface-border)] bg-[color:var(--surface-overlay)] text-[color:var(--content-primary)] hover:bg-[color:var(--surface-hover)]",
  ghost: "text-secondary hover:bg-[color:var(--surface-hover)] hover:text-[color:var(--content-primary)]",
  danger: "bg-[color:var(--tone-critical)] text-[color:var(--surface-base)] hover:brightness-110",
  success: "bg-[color:var(--tone-success)] text-[color:var(--surface-base)] hover:brightness-110",
};

const BUTTON_SIZES: Record<ButtonSize, string> = {
  sm: "h-8 px-3 text-xs",
  md: "h-9 px-4 text-sm",
  lg: "h-11 px-5 text-sm",
  icon: "h-9 w-9",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  icon?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant = "secondary", size = "md", loading, icon, children, disabled, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={cn(
        "inline-flex items-center justify-center gap-2 rounded-lg font-medium transition-colors",
        "disabled:cursor-not-allowed disabled:opacity-60",
        BUTTON_VARIANTS[variant],
        BUTTON_SIZES[size],
        className,
      )}
      {...props}
    >
      {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : icon}
      {children}
    </button>
  );
});

/** ------------------------------------------------------------------------ */
/** Badge                                                                     */
/** ------------------------------------------------------------------------ */

export interface BadgeProps {
  tone?: Tone;
  children: ReactNode;
  className?: string;
  title?: string;
}

export function Badge({ tone = "neutral", children, className, title }: BadgeProps) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-2xs font-medium ring-1 ring-inset",
        TONE_CLASSES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

/** ------------------------------------------------------------------------ */
/** Card                                                                      */
/** ------------------------------------------------------------------------ */

export interface CardProps {
  title?: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
  /** Removes body padding for edge-to-edge tables. */
  flush?: boolean;
}

export function Card({ title, description, action, children, className, bodyClassName, flush }: CardProps) {
  return (
    <section className={cn("surface-card overflow-hidden", className)}>
      {(title || action) && (
        <header className="flex items-start justify-between gap-4 border-b border-[color:var(--surface-border)] px-4 py-3">
          <div className="min-w-0">
            {title && <h2 className="truncate text-sm font-semibold text-[color:var(--content-primary)]">{title}</h2>}
            {description && <p className="mt-0.5 text-xs text-muted">{description}</p>}
          </div>
          {action && <div className="flex shrink-0 items-center gap-2">{action}</div>}
        </header>
      )}
      <div className={cn(flush ? "" : "p-4", bodyClassName)}>{children}</div>
    </section>
  );
}

/** ------------------------------------------------------------------------ */
/** Inputs                                                                    */
/** ------------------------------------------------------------------------ */

const FIELD_CLASSES =
  "w-full rounded-lg border border-[color:var(--surface-border)] bg-[color:var(--surface-base)] px-3 py-2 text-sm text-[color:var(--content-primary)] placeholder:text-[color:var(--content-muted)] focus:border-[color:var(--tone-accent)] focus:outline-none disabled:opacity-60";

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  hint?: string;
  error?: string | null;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, label, hint, error, id, ...props },
  ref,
) {
  const inputId = id ?? props.name;
  return (
    <div className="space-y-1.5">
      {label && (
        <label htmlFor={inputId} className="block text-xs font-medium text-secondary">
          {label}
        </label>
      )}
      <input ref={ref} id={inputId} className={cn(FIELD_CLASSES, error && "border-[color:var(--tone-critical)]", className)} {...props} />
      {hint && !error && <p className="text-2xs text-muted">{hint}</p>}
      {error && <p className="text-2xs text-[color:var(--tone-critical)]">{error}</p>}
    </div>
  );
});

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label?: string;
  hint?: string;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { className, label, hint, children, id, ...props },
  ref,
) {
  const selectId = id ?? props.name;
  return (
    <div className="space-y-1.5">
      {label && (
        <label htmlFor={selectId} className="block text-xs font-medium text-secondary">
          {label}
        </label>
      )}
      <select ref={ref} id={selectId} className={cn(FIELD_CLASSES, "cursor-pointer pr-8", className)} {...props}>
        {children}
      </select>
      {hint && <p className="text-2xs text-muted">{hint}</p>}
    </div>
  );
});

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string;
  hint?: string;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { className, label, hint, id, ...props },
  ref,
) {
  const areaId = id ?? props.name;
  return (
    <div className="space-y-1.5">
      {label && (
        <label htmlFor={areaId} className="block text-xs font-medium text-secondary">
          {label}
        </label>
      )}
      <textarea ref={ref} id={areaId} className={cn(FIELD_CLASSES, "min-h-[80px] resize-y", className)} {...props} />
      {hint && <p className="text-2xs text-muted">{hint}</p>}
    </div>
  );
});

/** Switch used throughout Settings. */
export function Switch({
  checked,
  onChange,
  label,
  description,
  disabled,
  danger,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  description?: string;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <label className={cn("flex cursor-pointer items-start justify-between gap-4 py-2.5", disabled && "cursor-not-allowed opacity-60")}>
      <span className="min-w-0">
        <span className="block text-sm text-[color:var(--content-primary)]">{label}</span>
        {description && <span className="mt-0.5 block text-xs text-muted">{description}</span>}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={() => !disabled && onChange(!checked)}
        className={cn(
          "relative mt-0.5 h-5 w-9 shrink-0 rounded-full border transition-colors",
          checked
            ? danger
              ? "border-[color:var(--tone-critical)] bg-[color:var(--tone-critical)]/80"
              : "border-[color:var(--tone-accent)] bg-[color:var(--tone-accent)]/80"
            : "border-[color:var(--surface-border)] bg-[color:var(--surface-overlay)]",
        )}
      >
        <span
          className={cn(
            "absolute top-0.5 h-3.5 w-3.5 rounded-full bg-white transition-all",
            checked ? "left-[1.15rem]" : "left-0.5",
          )}
        />
      </button>
    </label>
  );
}

/** ------------------------------------------------------------------------ */
/** Feedback                                                                  */
/** ------------------------------------------------------------------------ */

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cn("h-4 w-4 animate-spin text-muted", className)} aria-label="Loading" />;
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("animate-pulse rounded bg-[color:var(--surface-overlay)]", className)} />;
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-center justify-center gap-3 px-6 py-12 text-center", className)}>
      {icon && <div className="text-muted">{icon}</div>}
      <div>
        <p className="text-sm font-medium text-[color:var(--content-primary)]">{title}</p>
        {description && <p className="mx-auto mt-1 max-w-md text-xs text-muted">{description}</p>}
      </div>
      {action}
    </div>
  );
}

export function InlineAlert({
  tone = "info",
  title,
  children,
  action,
}: {
  tone?: Tone;
  title?: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className={cn("flex items-start justify-between gap-3 rounded-lg px-3 py-2.5 ring-1 ring-inset", TONE_CLASSES[tone])}>
      <div className="min-w-0 text-xs">
        {title && <p className="font-medium">{title}</p>}
        <div className={cn(title && "mt-0.5")}>{children}</div>
      </div>
      {action}
    </div>
  );
}

/** Metric tile used on the dashboard and analytics pages. */
export function Stat({
  label,
  value,
  hint,
  tone,
  icon,
}: {
  label: string;
  value: ReactNode;
  hint?: string;
  tone?: Tone;
  icon?: ReactNode;
}) {
  return (
    <div className="surface-card px-4 py-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-2xs font-medium uppercase tracking-wide text-muted">{label}</p>
        {icon && <span className={tone ? TONE_CLASSES[tone].split(" ")[1] : "text-muted"}>{icon}</span>}
      </div>
      <p
        className={cn(
          "mt-1.5 text-xl font-semibold tabular-nums",
          tone === "success" && "text-[color:var(--tone-success)]",
          tone === "critical" && "text-[color:var(--tone-critical)]",
          tone === "waiting" && "text-[color:var(--tone-waiting)]",
          tone === "info" && "text-[color:var(--tone-info)]",
          tone === "accent" && "text-[color:var(--tone-accent)]",
        )}
      >
        {value}
      </p>
      {hint && <p className="mt-0.5 text-2xs text-muted">{hint}</p>}
    </div>
  );
}
