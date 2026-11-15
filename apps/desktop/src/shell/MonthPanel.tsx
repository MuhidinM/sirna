import { useState } from "react";

import { occurrences, readRule } from "../features/money/regulars";
import { IconArrowUpRight, IconBolt } from "./icons";
import { MonthGrid, PanelHead, shiftMonth } from "./kit";
import { useLiveQuery } from "./useLiveQuery";

type Show = "due" | "bills" | "pay";

const SHOW: { value: Show; label: string; mark: string }[] = [
  { value: "due", label: "Due", mark: "something is due" },
  { value: "bills", label: "Bills", mark: "a bill is due" },
  { value: "pay", label: "Pay", mark: "pay is expected" },
];

const DUE_DAYS_SQL = `
  SELECT DISTINCT COALESCE(planned_date, due_date) AS day FROM task_items
  WHERE deleted_at IS NULL AND status IN ('todo', 'waiting')
    AND COALESCE(planned_date, due_date) BETWEEN ?1 AND ?2`;

const RULES_SQL = `
  SELECT kind, rule_json FROM money_regulars WHERE deleted_at IS NULL AND active = 1`;

/** The month in cream circles, with the days that matter in pink (docs/design.md). */
export function MonthPanel({
  today,
  onOpen,
}: {
  today: string;
  onOpen?: (() => void) | undefined;
}) {
  const [month, setMonth] = useState(`${today.slice(0, 8)}01`);
  const [show, setShow] = useState<Show>("due");
  const to = shiftMonth(month, 1);
  const end = new Date(Date.parse(`${to}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  const due = useLiveQuery<{ day: string }>(DUE_DAYS_SQL, [month, end]);
  const rules = useLiveQuery<{ kind: string; rule_json: string }>(RULES_SQL);
  const marked = new Set<string>();
  if (show === "due") for (const row of due.rows) marked.add(row.day);
  else
    for (const row of rules.rows) {
      if (row.kind !== (show === "bills" ? "bill" : "pay")) continue;
      const rule = readRule(row.rule_json);
      if (rule) for (const date of occurrences(rule, month, end)) marked.add(date);
    }
  const current = SHOW.find((s) => s.value === show) ?? SHOW[0];
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
            onClick={() => setShow(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>
      <div className="month-dots" aria-hidden="true">
        <i />
        <i />
        <i />
      </div>
      <MonthGrid
        month={month}
        today={today}
        marked={marked}
        markLabel={current?.mark ?? ""}
        onMonth={setMonth}
      />
    </section>
  );
}
