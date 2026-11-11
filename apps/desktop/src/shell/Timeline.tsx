import { type CSSProperties } from "react";

import { type BlockRow, firstStep, formatMinutes, nowAndNext } from "../features/plan/now";
import { Card } from "./ui";

const time = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "Africa/Addis_Ababa",
});

const range = (block: BlockRow) => `${time.format(block.start_at)}–${time.format(block.end_at)}`;

function areaStyle(block: BlockRow): CSSProperties {
  const color = block.kind === "rest" ? "rest" : (block.color ?? "admin");
  return { "--chip-color": `var(--area-${color})` } as CSSProperties;
}

/** The Now card and the countdown to the next block. */
export function NowCards({ blocks, nowMs }: { blocks: BlockRow[]; nowMs: number }) {
  const { now, next, minutesToNext } = nowAndNext(blocks, nowMs);
  return (
    <div className="now-row">
      <Card className={now ? "now-card active" : "now-card"}>
        <p className="meta">{now ? `Now · ${range(now)}` : "Now"}</p>
        <p className="now-title">{now ? now.title : "Free time"}</p>
        {now && now.kind === "area" && <p className="meta">First step: {firstStep(now)}</p>}
      </Card>
      <Card className="next-card">
        <p className="meta">Next</p>
        {next && minutesToNext !== undefined ? (
          <>
            <p className="now-title">{formatMinutes(minutesToNext)}</p>
            <p className="meta">
              {next.title} · {time.format(next.start_at)}
            </p>
          </>
        ) : (
          <p className="now-title">Nothing else today</p>
        )}
      </Card>
    </div>
  );
}

/** Today's blocks in order, past ones faded, the current one marked. */
export function Timeline({ blocks, nowMs }: { blocks: BlockRow[]; nowMs: number }) {
  const { now } = nowAndNext(blocks, nowMs);
  if (blocks.length === 0) {
    return <p className="empty">No plan yet. Finish setup and today&apos;s blocks appear here.</p>;
  }
  return (
    <ol className="timeline" aria-label="Today's plan">
      {blocks.map((block) => {
        const past = block.end_at <= nowMs;
        const current = block.id === now?.id;
        const classes = [
          "block",
          past ? "past" : "",
          current ? "current" : "",
          block.status === "done" ? "done-block" : "",
        ]
          .filter(Boolean)
          .join(" ");
        return (
          <li
            key={block.id}
            className={classes}
            aria-current={current ? "time" : undefined}
            style={areaStyle(block)}
          >
            <span className="block-time">{range(block)}</span>
            <span className="block-swatch" aria-hidden="true" />
            <span className="block-title">{block.title}</span>
            {block.task_title && block.kind === "area" && (
              <span className="meta">{block.task_title}</span>
            )}
          </li>
        );
      })}
    </ol>
  );
}
