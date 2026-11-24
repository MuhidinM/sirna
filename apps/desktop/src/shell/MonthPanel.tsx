import { useState } from "react";

import { showDate } from "../kernel/dates";
import { formatAmount } from "../kernel/money";
import { occurrences, readRule } from "../features/money/regulars";
import { IconArrowUpRight, IconBolt } from "./icons";
import { MonthGrid, PanelHead, shiftMonth } from "./kit";
import { useLiveQuery } from "./useLiveQuery";

type Show = "due" | "bills" | "pay";

const SHOW: {
  value: Show;
  label: string;
  mark: string;
  none: string;
  legend: (n: number) => string;
}[] = [
  {
    value: "due",
    label: "Due",
    mark: "something is due",
    none: "Nothing due or planned on this day.",
    legend: (n) => `${n} day${n === 1 ? "" : "s"} with a task due or planned`,
  },
  {
    value: "bills",
    label: "Bills",
    mark: "a bill is due",
    none: "No bills due on this day.",
    legend: (n) => `${n} day${n === 1 ? "" : "s"} with a bill due`,
  },
  {
    value: "pay",
    label: "Pay",
    mark: "pay is expected",
    none: "No pay expected on this day.",
    legend: (n) => `${n} pay day${n === 1 ? "" : "s"}`,
  },
];

const DUE_SQL = `
  SELECT COALESCE(planned_date, due_date) AS day, title FROM task_items
  WHERE deleted_at IS NULL AND status IN ('todo', 'waiting')
    AND COALESCE(planned_date, due_date) BETWEEN ?1 AND ?2
  ORDER BY day, title`;

const RULES_SQL = `
  SELECT kind, name, amount_minor, rule_json FROM money_regulars
  WHERE deleted_at IS NULL AND active = 1
  ORDER BY name`;

/**
 * The month in cream circles (docs/design.md). Pink marks the days that need
 * you in the chosen view: tasks due or planned, bills due, or pay expected.
 * Pick a day to see what falls on it.
 */
export function MonthPanel({
  today,
  onOpen,
}: {
  today: string;
  onOpen?: (() => void) | undefined;
}) {
  const [month, setMonth] = useState(`${today.slice(0, 8)}01`);
  const [show, setShow] = useState<Show>("due");
  const [picked, setPicked] = useState<string | null>(null);
  const to = shiftMonth(month, 1);
  const end = new Date(Date.parse(`${to}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  const due = useLiveQuery<{ day: string; title: string }>(DUE_SQL, [month, end]);
  const rules = useLiveQuery<{
    kind: string;
    name: string;
    amount_minor: number;
    rule_json: string;
  }>(RULES_SQL);

  // What falls on each marked day, in the chosen view.
  const items = new Map<string, string[]>();
  const add = (day: string, line: string) => items.set(day, [...(items.get(day) ?? []), line]);
  if (show === "due") for (const row of due.rows) add(row.day, row.title);
  else
    for (const row of rules.rows) {
      if (row.kind !== (show === "bills" ? "bill" : "pay")) continue;
      const rule = readRule(row.rule_json);
      if (rule)
        for (const date of occurrences(rule, month, end))
          add(date, `${row.name} · ${formatAmount(row.amount_minor)}`);
    }
  const marked = new Set(items.keys());
  const current = SHOW.find((s) => s.value === show) ?? SHOW[0];
  const index = SHOW.findIndex((s) => s.value === show);
  const pickedItems = picked ? (items.get(picked) ?? []) : [];

  return (
    <section className="panel calendar" aria-labelledby="month-title">
      <PanelHead
        id="month-title"
        icon={<IconBolt size={18} />}
        title="Calendar"
        sub="Days that need you"
        action={
          onOpen && (
            <button
              type="button"
              className="icon-btn plain"
              aria-label="Open the week"
              onClick={onOpen}
            >
              <IconArrowUpRight />
            </button>
          )
        }
      />
      <div className="month-chips" role="group" aria-label="Show">
        {SHOW.map((option) => (
          <button
            key={option.value}
            type="button"
            className="pill"
            aria-pressed={show === option.value}
            onClick={() => {
              setShow(option.value);
              setPicked(null);
            }}
          >
            {option.label}
          </button>
        ))}
      </div>
      {/* Which of the three views is on, as in the reference's page dots. */}
      <div className="month-dots" aria-hidden="true">
        {SHOW.map((option, i) => (
          <i key={option.value} className={i === index ? "on" : undefined} />
        ))}
      </div>
      <MonthGrid
        month={month}
        today={today}
        marked={marked}
        markLabel={current?.mark ?? ""}
        onMonth={(next) => {
          setMonth(next);
          setPicked(null);
        }}
        selected={picked}
        onPick={(date) => setPicked(picked === date ? null : date)}
      />
      <p className="month-legend">
        <span className="dot-pink" aria-hidden="true" />
        {current?.legend(marked.size)}
      </p>
      {picked && (
        <div className="month-day-detail" role="status">
          <strong>{showDate(picked, today, { weekday: true })}</strong>{" "}
          {pickedItems.length > 0 ? (
            <ul>
              {pickedItems.map((line, i) => (
                <li key={line + i}>{line}</li>
              ))}
            </ul>
          ) : (
            <span className="meta">{current?.none}</span>
          )}
        </div>
      )}
    </section>
  );
}
