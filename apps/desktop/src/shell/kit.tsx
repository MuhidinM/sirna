/**
 * The shared pieces of the Neura look (docs/design.md): panel heads, the
 * month grid, the yellow Now card, the two-tone bar chart, event cards and
 * the day board. Presentational only; pages pass the data in.
 */
import { type CSSProperties, type ReactNode, useState } from "react";

import { IconArrowLeft, IconArrowRight, IconPlus } from "./icons";

// --- Panel head ---------------------------------------------------------------------------

export function PanelHead({
  icon,
  title,
  sub,
  action,
  id,
}: {
  icon?: ReactNode;
  title: ReactNode;
  sub?: ReactNode;
  action?: ReactNode;
  id?: string;
}) {
  return (
    <div className="panel-head">
      {icon && <span className="panel-icon">{icon}</span>}
      <div className="grow">
        <h2 id={id}>{title}</h2>
        {sub && <span className="panel-sub">{sub}</span>}
      </div>
      {action}
    </div>
  );
}

// --- Month grid -----------------------------------------------------------------------------

const MONTH_NAME = new Intl.DateTimeFormat("en-GB", {
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});

const daysIn = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate();

/** Monday-first month: blanks before the 1st, then each date (YYYY-MM-DD). */
export function monthCells(monthStart: string): (string | null)[] {
  const [y = 1970, m = 1] = monthStart.split("-").map(Number);
  const first = new Date(Date.UTC(y, m - 1, 1)).getUTCDay(); // 0 = Sunday
  const blanks = (first + 6) % 7;
  const cells: (string | null)[] = Array.from({ length: blanks }, () => null);
  for (let d = 1; d <= daysIn(y, m); d++)
    cells.push(`${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`);
  return cells;
}

export function shiftMonth(monthStart: string, delta: number): string {
  const [y = 1970, m = 1] = monthStart.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1 + delta, 1));
  return date.toISOString().slice(0, 8) + "01";
}

export function MonthGrid({
  month,
  today,
  marked,
  markLabel,
  onMonth,
  onPick,
  selected,
}: {
  /** YYYY-MM-01 */
  month: string;
  today: string;
  /** Dates shown in pink (and joined when side by side). */
  marked: Set<string>;
  /** What a pink day means, for screen readers ("a bill is due"). */
  markLabel: string;
  onMonth: (month: string) => void;
  onPick?: (date: string) => void;
  selected?: string | null;
}) {
  const cells = monthCells(month);
  const [y = 1970, m = 1] = month.split("-").map(Number);
  return (
    <div className="month">
      <div className="month-grid" role="grid" aria-label={MONTH_NAME.format(Date.UTC(y, m - 1, 1))}>
        {["M", "T", "W", "T", "F", "S", "S"].map((day, i) => (
          <span key={i} className="month-dow" aria-hidden="true">
            {day}
          </span>
        ))}
        {cells.map((date, i) => {
          if (!date) return <span key={`b${i}`} className="month-blank" aria-hidden="true" />;
          const day = Number(date.slice(8));
          const on = marked.has(date);
          const col = i % 7;
          const prev = cells[i - 1];
          const next = cells[i + 1];
          const joinLeft = on && col > 0 && prev !== null && prev !== undefined && marked.has(prev);
          const joinRight =
            on && col < 6 && next !== null && next !== undefined && marked.has(next);
          const classes = [
            "month-day",
            on ? "marked" : "",
            joinLeft ? "join-left" : "",
            joinRight ? "join-right" : "",
            date === today ? "today" : "",
            date === selected ? "selected" : "",
            date < today ? "past" : "",
          ]
            .filter(Boolean)
            .join(" ");
          const label = `${day}${on ? `, ${markLabel}` : ""}${date === today ? ", today" : ""}`;
          return onPick ? (
            <button
              key={date}
              type="button"
              className={classes}
              aria-label={label}
              aria-pressed={date === selected}
              onClick={() => onPick(date)}
            >
              {day}
            </button>
          ) : (
            <span key={date} className={classes} role="gridcell" aria-label={label}>
              {day}
            </span>
          );
        })}
      </div>
      <div className="month-foot">
        <button
          type="button"
          className="icon-btn plain"
          aria-label="Previous month"
          onClick={() => onMonth(shiftMonth(month, -1))}
        >
          <IconArrowLeft />
        </button>
        <span className="month-name">{MONTH_NAME.format(Date.UTC(y, m - 1, 1))}</span>
        <button
          type="button"
          className="icon-btn plain"
          aria-label="Next month"
          onClick={() => onMonth(shiftMonth(month, 1))}
        >
          <IconArrowRight />
        </button>
      </div>
    </div>
  );
}

// --- Now card -------------------------------------------------------------------------------

export function NowCard({
  when,
  left,
  title,
  sub,
  children,
  art = true,
}: {
  when: ReactNode;
  left?: string | null;
  title: ReactNode;
  sub?: ReactNode;
  children?: ReactNode;
  art?: boolean;
}) {
  return (
    <section className="now-card" aria-label="Now">
      <div className="now-card-top">
        <span className="now-when">{when}</span>
        {left && <span className="time-pill">{left}</span>}
      </div>
      <p className="now-card-title">{title}</p>
      {sub && <p className="now-card-sub">{sub}</p>}
      {children && <div className="now-card-actions">{children}</div>}
      {art && <NowArt />}
    </section>
  );
}

/** A small hand-drawn notebook, as in the reference's sticker. */
function NowArt() {
  return (
    <svg className="now-art" viewBox="0 0 120 90" aria-hidden="true" focusable="false">
      <g stroke="#2a1a12" strokeWidth="2.4" strokeLinejoin="round" strokeLinecap="round">
        <path
          d="M10 30c14-6 30-6 48 4 16-12 34-14 54-8l-4 50c-18-6-34-3-50 8-16-10-32-12-48-6Z"
          fill="#f78fb3"
        />
        <path d="M58 34v50" fill="none" />
        <path
          d="M18 40c10-3 20-2 32 3M18 50c10-3 20-2 32 3M18 60c10-3 20-2 30 3M66 42c12-5 24-6 36-3M66 52c12-5 24-6 36-3M66 62c10-4 22-5 34-2"
          fill="none"
        />
        <path d="M4 24l26-12 10 18-24 12Z" fill="#ffd34d" />
        <path d="M12 24l12-6M14 30l10-5" fill="none" />
      </g>
    </svg>
  );
}

// --- Bar chart --------------------------------------------------------------------------------

export interface Bar {
  label: string;
  /** The lighter cap: what was planned or assigned. */
  total: number;
  /** The darker body: what got done. */
  done: number;
  highlight?: boolean;
  /** Lines for the tooltip. */
  tip?: { label: string; value: string; tone: "yellow" | "cream" | "orange" }[];
  tipTitle?: string;
}

export function BarChart({
  bars,
  unit,
  ariaLabel,
}: {
  bars: Bar[];
  unit: string;
  ariaLabel: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...bars.map((bar) => Math.max(bar.total, bar.done)));
  const step = niceStep(max / 4);
  const top = step * 4;
  const ticks = [4, 3, 2, 1].map((n) => n * step);
  const shown = hover ?? bars.findIndex((bar) => bar.highlight);
  return (
    <div className="bars" role="img" aria-label={ariaLabel}>
      <div className="bars-axis" aria-hidden="true">
        {ticks.map((tick) => (
          <span key={tick} style={{ bottom: `${(tick / top) * 100}%` }}>
            {fmt(tick)}
            <small>{unit}</small>
          </span>
        ))}
      </div>
      <div className="bars-plot">
        {ticks.map((tick) => (
          <span key={tick} className="bars-line" style={{ bottom: `${(tick / top) * 100}%` }} />
        ))}
        {bars.map((bar, i) => (
          <div
            key={bar.label + i}
            className={bar.highlight ? "bars-col hi" : "bars-col"}
            onMouseEnter={() => setHover(i)}
            onMouseLeave={() => setHover(null)}
          >
            <div
              className="bars-stack"
              style={{ height: `${(Math.max(bar.total, bar.done) / top) * 100}%` }}
            >
              <span
                className="bars-done"
                style={{
                  height: `${bar.total > 0 ? (Math.min(bar.done, bar.total) / Math.max(bar.total, bar.done)) * 100 : 100}%`,
                }}
              />
            </div>
            <span className="bars-label">{bar.label}</span>
            {shown === i && bar.tip && (
              <div className="bars-tip" role="status">
                {bar.tipTitle && <p className="bars-tip-title">{bar.tipTitle}</p>}
                {bar.tip.map((line) => (
                  <p key={line.label}>
                    <i className={`sq ${line.tone}`} aria-hidden="true" />
                    {line.label}
                    <b>{line.value}</b>
                  </p>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function niceStep(raw: number): number {
  if (raw <= 0) return 1;
  const pow = 10 ** Math.floor(Math.log10(raw));
  for (const n of [1, 2, 2.5, 5, 10]) if (n * pow >= raw) return n * pow;
  return 10 * pow;
}

const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

// --- Event cards --------------------------------------------------------------------------------

export type Tone =
  "orange" | "purple" | "pink" | "yellow" | "mint" | "cream" | "sky" | "leaf" | "raised";

/** The area colour name → the card tone. */
export function toneOf(color: string | null | undefined): Tone {
  switch (color) {
    case "work":
      return "orange";
    case "jobhunt":
      return "pink";
    case "coding":
      return "purple";
    case "experiments":
      return "yellow";
    case "gym":
      return "leaf";
    case "quran":
      return "sky";
    case "rest":
      return "raised";
    default:
      return "cream";
  }
}

export function EventCard({
  tone,
  label,
  title,
  art = false,
  faded = false,
  current = false,
  className,
  style,
  children,
}: {
  tone: Tone;
  label?: ReactNode;
  title: ReactNode;
  /** A soft gradient header, in place of the reference's photos. */
  art?: boolean;
  faded?: boolean;
  current?: boolean;
  className?: string | undefined;
  style?: CSSProperties;
  children?: ReactNode;
}) {
  return (
    <article
      className={[
        "event",
        `tone-${tone}`,
        faded ? "faded" : "",
        current ? "current" : "",
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
      style={style}
      aria-current={current ? "time" : undefined}
    >
      {art && <span className="event-art" aria-hidden="true" />}
      <div className="event-body">
        {label && <span className="event-label">{label}</span>}
        <span className="event-title">{title}</span>
        {children}
      </div>
    </article>
  );
}

export function GhostCard({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" className="ghost-card" onClick={onClick}>
      <span className="ghost-plus" aria-hidden="true">
        <IconPlus size={18} />
      </span>
      {label}
    </button>
  );
}
