/** Base components (plan §3.14). Colours come from theme/tokens.css. */
import { type ButtonHTMLAttributes, type CSSProperties, type ReactNode } from "react";

/** The life areas' colour variables (theme/tokens.css). */
export type AreaColor =
  "work" | "jobhunt" | "coding" | "experiments" | "gym" | "quran" | "admin" | "rest";

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={className ? `card ${className}` : "card"}>{children}</div>;
}

export function Button({
  primary = false,
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { primary?: boolean }) {
  const classes = ["btn", primary ? "btn-primary" : "", className ?? ""].filter(Boolean).join(" ");
  return <button type="button" className={classes} {...props} />;
}

export function Chip({ area = "admin", children }: { area?: AreaColor; children: ReactNode }) {
  const style = { "--chip-color": `var(--area-${area})` } as CSSProperties;
  return (
    <span className="chip" style={style}>
      {children}
    </span>
  );
}

/** A progress bar; `value` from 0 to 1. */
export function Bar({ value, area, label }: { value: number; area?: AreaColor; label: string }) {
  const clamped = Math.max(0, Math.min(1, value));
  const style = area ? ({ "--bar-color": `var(--area-${area})` } as CSSProperties) : undefined;
  return (
    <div
      className="bar"
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(clamped * 100)}
      style={style}
    >
      <span style={{ width: `${clamped * 100}%` }} />
    </div>
  );
}
