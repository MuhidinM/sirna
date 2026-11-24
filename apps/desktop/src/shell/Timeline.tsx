import {
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  useEffect,
  useRef,
  useState,
} from "react";

import { logicalDate, showDate } from "../kernel/dates";
import { type Op, type SqlValue, transact } from "../kernel/db";
import { ulid } from "../kernel/ulid";
import { localToEpoch } from "../capture/when";
import {
  addOps,
  type BlockDraft,
  BOARD_TASKS_SQL,
  blockBefore,
  type BoardTask,
  changeOps,
  clockOf,
  deleteOps,
  draftOf,
  editorKey,
  focusAfterDelete,
  minuteOf,
  moveOps,
  moveSpan,
  newDraft,
  readClock,
  readDraft,
  resizeOps,
  resizeSpan,
  SNAP_MIN,
  spanOf,
  undoOps,
} from "../features/plan/edit";
import { AREA_TASKS_SQL, blockTaskLists, type JobTask } from "../features/plan/jobs";
import { shiftDate } from "../features/plan/dayplan";
import { statusOps } from "../features/tasks/list";
import { systemClock } from "../kernel/clock";
import {
  type BlockRow,
  firstStep,
  focusOffer,
  formatMinutes,
  nowAndNext,
} from "../features/plan/now";
import { type FocusStatus, startFocus } from "./Focus";
import { IconPlus } from "./icons";
import { EventCard, NowCard, toneOf } from "./kit";
import { Button } from "./ui";
import { useLiveQuery } from "./useLiveQuery";

const time = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "Africa/Addis_Ababa",
});

/** "12.00", as in the reference: the day board only. */
const dot = (ms: number) => time.format(ms).replace(":", ".");
const range = (block: BlockRow) => `${dot(block.start_at)} – ${dot(block.end_at)}`;
/** "12:00–13:00": times in prose (the Now card), as in the brief. */
const span = (block: BlockRow) => `${time.format(block.start_at)}–${time.format(block.end_at)}`;

/** The yellow Now card: the current block, or the next one, with the time left. */
export function NowCards({
  blocks,
  nowMs,
  focus,
}: {
  blocks: BlockRow[];
  nowMs: number;
  focus?: FocusStatus | undefined;
}) {
  const { now, next, minutesToNext } = nowAndNext(blocks, nowMs);
  // Always offered while no session runs (rule 7); the sheet asks what it's for.
  const offer = focusOffer(now, focus?.kind);
  const focusButton = offer && (
    <Button className="btn-orange" onClick={() => void startFocus(offer.blockId)}>
      Start focus
    </Button>
  );
  if (now) {
    const left = Math.max(0, Math.round((now.end_at - nowMs) / 60_000));
    return (
      <NowCard
        when={span(now)}
        left={`${formatMinutes(left)} left`}
        title={now.title}
        sub={
          <>
            {now.kind === "area" && (
              <>
                First step: {firstStep(now)}
                <br />
              </>
            )}
            {next && minutesToNext !== undefined
              ? `Next: ${next.title} at ${time.format(next.start_at)} · in ${formatMinutes(minutesToNext)}`
              : "Nothing after this today."}
          </>
        }
      >
        {focusButton}
      </NowCard>
    );
  }
  return (
    <NowCard
      when={next ? `Next at ${time.format(next.start_at)}` : "Free time"}
      left={next && minutesToNext !== undefined ? formatMinutes(minutesToNext) : null}
      title={next ? next.title : "Nothing else today"}
      sub={next ? "Free time until then." : "The rest of the day is yours."}
    >
      {focusButton}
    </NowCard>
  );
}

/** The board fits about this tall; a long day packs its hours closer. */
const BOARD_PX = 680;
const MAX_PX_PER_MIN = 1.1;
const MIN_PX_PER_MIN = 0.62;
/** Cards shorter than this many pixels show one line. */
const SHORT_PX = 66;
/** An editable board always shows at least these hours, so there is room to add. */
const OPEN_FROM_MIN = 6 * 60;
const OPEN_TO_MIN = 22 * 60;
/** A press that moves less than this is a click (opens the editor), not a drag. */
const DRAG_PX = 4;

/** Side-by-side lanes for blocks that overlap (calendar events over a routine). */
function lanes(blocks: BlockRow[]): Map<string, { lane: number; of: number }> {
  const endOf = (block: BlockRow) => block.end_at;
  const sorted = [...blocks].sort((a, b) => a.start_at - b.start_at || endOf(b) - endOf(a));
  const out = new Map<string, { lane: number; of: number }>();
  let group: BlockRow[] = [];
  let groupEnd = -Infinity;
  const flush = () => {
    const ends: number[] = [];
    const placed: { id: string; lane: number }[] = [];
    for (const block of group) {
      let lane = ends.findIndex((end) => end <= block.start_at);
      if (lane === -1) lane = ends.length;
      ends[lane] = endOf(block);
      placed.push({ id: block.id, lane });
    }
    for (const p of placed) out.set(p.id, { lane: p.lane, of: ends.length });
    group = [];
  };
  for (const block of sorted) {
    if (group.length > 0 && block.start_at >= groupEnd) flush();
    groupEnd = group.length === 0 ? endOf(block) : Math.max(groupEnd, endOf(block));
    group.push(block);
  }
  if (group.length) flush();
  return out;
}

/** What the board needs to edit: the areas and open tasks to pick from. */
export interface BoardEdit {
  areas: { id: string; name: string }[];
  tasks: BoardTask[];
}

interface Drag {
  id: string;
  mode: "move" | "resize";
  startY: number;
  deltaMin: number;
  moved: boolean;
}

type Editing =
  { mode: "edit"; block: BlockRow } | { mode: "add"; draft: BlockDraft; opened: number } | null;

/** The last edit, with the ops that put it back. */
interface Done {
  said: string;
  undo: Op[];
}

const isControl = (target: EventTarget | null) =>
  target instanceof Element && target.closest("input, button, label, select, a") !== null;

/**
 * A day's blocks on an hour grid: event cards sized by length, a line at now.
 * With `edit`, every block can be dragged (move), stretched by its bottom edge
 * (15-minute steps), clicked or Enter-ed to edit, nudged with the arrow keys,
 * and an empty hour clicked to add one (time-first §1 rule 8).
 */
export function Timeline({
  blocks,
  nowMs,
  date,
  blockTasks,
  onDone,
  edit,
  label = "Today's plan",
}: {
  blocks: BlockRow[];
  nowMs: number;
  /** The logical date shown; today when left out. */
  date?: string;
  /** The open tasks listed inside each block, by block id (rule 6; `blockTaskLists`). */
  blockTasks?: Map<string, JobTask[]>;
  onDone?: (task: JobTask) => void;
  edit?: BoardEdit;
  label?: string;
}) {
  const day = date ?? logicalDate(nowMs);
  const today = logicalDate(nowMs);
  // A block whose task list is opened in full.
  const [open, setOpen] = useState<string | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [editing, setEditing] = useState<Editing>(null);
  /** Counts add clicks: each one opens a fresh popover (`editorKey`). */
  const opened = useRef(0);
  const [done, setDone] = useState<Done | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Where keyboard focus goes once the popover closes: a block, or the board.
  const lanesRef = useRef<HTMLDivElement>(null);
  /** Focus a block's card (it is on the page already), else the board itself. */
  const focusBlock = (blockId: string | null) => {
    const lanes = lanesRef.current;
    const card = blockId
      ? lanes?.querySelector<HTMLElement>(`[data-block-id="${CSS.escape(blockId)}"]`)
      : null;
    (card ?? lanes)?.focus();
  };
  /** The popover closes and focus goes back where you were (a11y). */
  const closeEditor = (blockId: string | null) => {
    focusBlock(blockId);
    setEditing(null);
  };

  const write = (ops: Op[], said: string, before: Record<string, Record<string, SqlValue>>) => {
    if (ops.length === 0) return;
    setError(null);
    void transact("user", ops, `day:${day}`)
      .then(() => setDone({ said, undo: undoOps(ops, before) }))
      .catch((failure: unknown) =>
        setError(
          `Couldn't save it: ${failure instanceof Error ? failure.message : String(failure)}`,
        ),
      );
  };
  const undo = () => {
    if (!done) return;
    const ops = done.undo;
    setDone(null);
    void transact("user", ops, `day:${day}:undo`).catch((failure: unknown) =>
      setError(`Couldn't undo: ${failure instanceof Error ? failure.message : String(failure)}`),
    );
  };

  if (blocks.length === 0 && !edit) {
    return <p className="empty">Today&apos;s blocks show up here once your week is set up.</p>;
  }
  const hour = 3_600_000;
  const starts = blocks.map((b) => b.start_at);
  const ends = blocks.map((b) => b.end_at);
  if (edit) {
    starts.push(localToEpoch(day, OPEN_FROM_MIN));
    ends.push(localToEpoch(day, OPEN_TO_MIN));
  }
  const first = Math.floor(Math.min(...starts) / hour) * hour;
  const last = Math.ceil(Math.max(...ends) / hour) * hour;
  const perMin = Math.min(
    MAX_PX_PER_MIN,
    Math.max(MIN_PX_PER_MIN, BOARD_PX / ((last - first) / 60_000)),
  );
  const y = (ms: number) => ((ms - first) / 60_000) * perMin;
  const hours: number[] = [];
  for (let t = first; t <= last; t += hour) hours.push(t);
  const { now } = nowAndNext(blocks, nowMs);

  /** Where a block is drawn: its own times, or where the drag has it. */
  const shown = (block: BlockRow): { start: number; end: number } => {
    if (!drag || drag.id !== block.id || !drag.moved)
      return { start: block.start_at, end: block.end_at };
    const span = spanOf(day, block);
    const next =
      drag.mode === "move"
        ? moveSpan(span, drag.deltaMin)
        : resizeSpan(span, span.endMin + drag.deltaMin);
    return { start: localToEpoch(day, next.startMin), end: localToEpoch(day, next.endMin) };
  };
  const placedBlocks = blocks.map((block) => {
    const at = shown(block);
    return { ...block, start_at: at.start, end_at: at.end };
  });

  // Rest is a soft band behind the day, not a card beside it.
  const rest = placedBlocks.filter((block) => block.kind === "rest");
  const MIN_CARD_PX = 30;
  const cards = placedBlocks.filter((block) => block.kind !== "rest");
  const placed = lanes(cards);
  /** Where the next card in the same lane starts, so a short card never covers it. */
  const nextInLane = (block: BlockRow): number | null => {
    const lane = placed.get(block.id)?.lane ?? 0;
    const later = cards
      .filter(
        (other) => other.start_at >= block.end_at && (placed.get(other.id)?.lane ?? 0) === lane,
      )
      .map((other) => other.start_at);
    return later.length > 0 ? Math.min(...later) : null;
  };
  const showNow = day === today && nowMs >= first && nowMs <= last;
  const original = new Map(blocks.map((block) => [block.id, block]));
  const areaName = (id: string | null) => edit?.areas.find((area) => area.id === id)?.name;

  const commitDrag = (block: BlockRow, state: Drag) => {
    if (!state.moved) {
      setEditing({ mode: "edit", block });
      return;
    }
    const span = spanOf(day, block);
    const ops =
      state.mode === "move"
        ? moveOps(day, block, state.deltaMin)
        : resizeOps(day, block, span.endMin + state.deltaMin);
    const next =
      state.mode === "move"
        ? moveSpan(span, state.deltaMin)
        : resizeSpan(span, span.endMin + state.deltaMin);
    write(
      ops,
      state.mode === "move"
        ? `Moved ${block.title} to ${clockOf(next.startMin)}.`
        : `${block.title} now ends at ${clockOf(next.endMin)}.`,
      { [block.id]: blockBefore(block) },
    );
  };

  const onKey = (block: BlockRow, event: KeyboardEvent<HTMLElement>) => {
    if (!edit || event.target !== event.currentTarget) return;
    const span = spanOf(day, block);
    const step = event.key === "ArrowUp" ? -SNAP_MIN : event.key === "ArrowDown" ? SNAP_MIN : 0;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      setEditing({ mode: "edit", block });
    } else if (step !== 0 && event.shiftKey) {
      event.preventDefault();
      const next = resizeSpan(span, span.endMin + step);
      write(
        resizeOps(day, block, span.endMin + step),
        `${block.title} now ends at ${clockOf(next.endMin)}.`,
        {
          [block.id]: blockBefore(block),
        },
      );
    } else if (step !== 0) {
      event.preventDefault();
      const next = moveSpan(span, step);
      write(moveOps(day, block, step), `Moved ${block.title} to ${clockOf(next.startMin)}.`, {
        [block.id]: blockBefore(block),
      });
    } else if (event.key === "Delete") {
      event.preventDefault();
      write(deleteOps(block), `Deleted ${block.title}.`, { [block.id]: blockBefore(block) });
      focusBlock(focusAfterDelete(blocks, block.id));
    }
  };

  const pointerDown = (block: BlockRow, mode: Drag["mode"], event: PointerEvent<HTMLElement>) => {
    if (!edit || event.button !== 0) return;
    if (mode === "move" && isControl(event.target)) return;
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    setDrag({ id: block.id, mode, startY: event.clientY, deltaMin: 0, moved: false });
  };
  const pointerMove = (event: PointerEvent<HTMLElement>) => {
    if (!drag) return;
    const dy = event.clientY - drag.startY;
    setDrag({ ...drag, deltaMin: dy / perMin, moved: drag.moved || Math.abs(dy) >= DRAG_PX });
  };
  const pointerUp = (block: BlockRow) => {
    if (!drag) return;
    const state = drag;
    setDrag(null);
    const before = original.get(block.id);
    if (before) commitDrag(before, state);
  };

  /** A click on an empty spot of the board adds a block there. */
  const addAt = (event: MouseEvent<HTMLDivElement>) => {
    if (!edit) return;
    const target = event.target as Element;
    if (target.closest(".event, .day-editor, .day-edit-bar")) return;
    const top = event.currentTarget.getBoundingClientRect().top;
    const minute = minuteOf(day, first) + (event.clientY - top) / perMin;
    setEditing({ mode: "add", draft: newDraft(minute), opened: ++opened.current });
  };

  const editorTop = (() => {
    if (!editing) return 0;
    if (editing.mode === "edit") return y(editing.block.start_at);
    const start = readClock(editing.draft.start);
    return start === null ? 0 : y(localToEpoch(day, start));
  })();

  return (
    <div className="day-board-wrap">
      {edit && (
        <div className="day-edit-bar">
          {/* The hint stays in the page: every block points at it (aria-describedby). */}
          <p className={done ? "visually-hidden" : "meta day-edit-hint"} id={`day-hint-${day}`}>
            Drag to move, drag the bottom edge to resize, click to edit, click an empty hour to add.
            Keys: Enter edits, ↑ ↓ move 15 min, Shift+↑ ↓ change the end, Delete removes.
          </p>
          {done && (
            <p className="day-edit-status" role="status">
              {done.said}{" "}
              {done.undo.length > 0 && (
                <button type="button" className="link-btn" onClick={undo}>
                  Undo
                </button>
              )}
            </p>
          )}
          <Button
            className="day-add"
            onClick={() => {
              const nowMin = minuteOf(day, nowMs);
              const at = day === today && nowMin > OPEN_FROM_MIN ? nowMin + SNAP_MIN : 9 * 60;
              setEditing({ mode: "add", draft: newDraft(at), opened: ++opened.current });
            }}
          >
            <IconPlus size={14} /> Add a block
          </Button>
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
        </div>
      )}
      {/* A click on an empty hour adds a block; "Add a block" above is the keyboard way. */}
      {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions */}
      <div
        className={edit ? "day-board editable" : "day-board"}
        style={
          { height: `${Math.max(y(last), editing ? editorTop + 340 : 0) + 16}px` } as CSSProperties
        }
        onClick={addAt}
      >
        <div className="day-hours" aria-hidden="true">
          {hours.map((t) => (
            <span key={t} className="day-hour" style={{ top: y(t) }}>
              {dot(t)}
            </span>
          ))}
          {showNow && (
            <span className="day-hour now" style={{ top: y(nowMs) }}>
              {dot(nowMs)}
            </span>
          )}
        </div>
        <div
          className="day-lanes"
          ref={lanesRef}
          role="list"
          aria-label={label}
          tabIndex={edit ? -1 : undefined}
        >
          {hours.map((t) => (
            <span key={t} className="day-line" style={{ top: y(t) }} aria-hidden="true" />
          ))}
          {showNow && (
            <span className="day-line now" style={{ top: y(nowMs) }} aria-hidden="true" />
          )}
          {rest.map((block) => (
            <div
              key={block.id}
              role="listitem"
              className="day-rest"
              style={{ top: y(block.start_at), height: y(block.end_at) - y(block.start_at) }}
            >
              <span>
                {block.title} · {range(block)}
              </span>
            </div>
          ))}
          {cards.map((block) => {
            const lane = placed.get(block.id) ?? { lane: 0, of: 1 };
            const minutes = (block.end_at - block.start_at) / 60_000;
            const short = minutes * perMin < SHORT_PX;
            const dragging = drag?.id === block.id && drag.moved;
            // One block per area lists that area's open tasks (rule 6).
            const tasks = blockTasks?.get(block.id) ?? [];
            const next = nextInLane(block);
            const room = next === null || dragging ? Infinity : y(next) - y(block.start_at) - 3;
            const height = Math.max(
              18,
              Math.min(room, Math.max(MIN_CARD_PX - 4, y(block.end_at) - y(block.start_at) - 4)),
            );
            const expanded = open === block.id;
            // As many tasks as the card has room for; the rest behind "+N more".
            const fits = short ? 0 : Math.max(1, Math.floor((height - 64) / 22));
            const shownTasks = expanded ? tasks : tasks.slice(0, fits);
            const hidden = tasks.length - shownTasks.length;
            const skipped = block.status === "skipped";
            const style: CSSProperties = {
              top: y(block.start_at),
              height: expanded ? "auto" : height,
              minHeight: expanded ? height : undefined,
              zIndex: expanded || dragging ? 6 : undefined,
              left: `calc(${(lane.lane / lane.of) * 100}% + ${lane.lane ? 4 : 0}px)`,
              width: `calc(${100 / lane.of}% - ${lane.of > 1 ? 4 : 0}px)`,
            };
            const color = block.color ?? "admin";
            const tail = `${block.kind === "fixed" ? " · fixed" : ""}${skipped ? " · skipped" : ""}`;
            const source = original.get(block.id) ?? block;
            return (
              <div role="listitem" key={block.id}>
                <EventCard
                  tone={toneOf(color)}
                  label={
                    short
                      ? `${range(block)}${block.task_title && block.kind === "area" && block.task_title !== block.title ? ` · ${block.task_title}` : ""}${tail}`
                      : `${range(block)}${tail}`
                  }
                  title={block.title}
                  art={!short && block.kind === "fixed" && minutes >= 90}
                  faded={
                    (day === today && block.end_at <= nowMs) || block.status === "done" || skipped
                  }
                  current={day === today && block.id === now?.id}
                  className={[
                    short && !expanded ? "short" : "",
                    expanded ? "expanded" : "",
                    dragging ? "dragging" : "",
                    edit ? "editable" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  style={style}
                  {...(edit
                    ? {
                        "data-block-id": block.id,
                        tabIndex: 0,
                        "aria-label": `${block.title}, ${range(block)}`,
                        "aria-describedby": `day-hint-${day}`,
                        onKeyDown: (event: KeyboardEvent<HTMLElement>) => onKey(source, event),
                        onPointerDown: (event: PointerEvent<HTMLElement>) =>
                          pointerDown(source, "move", event),
                        onPointerMove: pointerMove,
                        onPointerUp: () => pointerUp(source),
                        onPointerCancel: () => setDrag(null),
                      }
                    : {})}
                >
                  {!short &&
                    block.task_title &&
                    block.kind === "area" &&
                    block.task_title !== block.title && (
                      <span className="event-label">{block.task_title}</span>
                    )}
                  {shownTasks.length > 0 && (
                    <ul className="event-check" aria-label={`${block.title} tasks`}>
                      {shownTasks.map((task) => (
                        <li key={task.id}>
                          <label>
                            <input
                              type="checkbox"
                              checked={false}
                              onChange={() => onDone?.(task)}
                            />
                            {task.title}
                            {task.due_date && (
                              <span className="event-due">
                                {" "}
                                · due {showDate(task.due_date, today)}
                              </span>
                            )}
                          </label>
                        </li>
                      ))}
                    </ul>
                  )}
                  {(hidden > 0 || expanded) && tasks.length > 0 && (
                    <button
                      type="button"
                      className="event-more"
                      aria-expanded={expanded}
                      onClick={() => setOpen(expanded ? null : block.id)}
                    >
                      {expanded
                        ? "Show less"
                        : shownTasks.length === 0
                          ? `${tasks.length} task${tasks.length === 1 ? "" : "s"}`
                          : `+${hidden} more`}
                    </button>
                  )}
                  {edit && (
                    <span
                      className="event-resize"
                      aria-hidden="true"
                      onPointerDown={(event) => pointerDown(source, "resize", event)}
                      // Kept off the card, or its own handlers run the drag a second time.
                      onPointerMove={(event) => {
                        event.stopPropagation();
                        pointerMove(event);
                      }}
                      onPointerUp={(event) => {
                        event.stopPropagation();
                        pointerUp(source);
                      }}
                      onPointerCancel={(event) => {
                        event.stopPropagation();
                        setDrag(null);
                      }}
                    />
                  )}
                </EventCard>
              </div>
            );
          })}
        </div>
        {/* The popover is a dialog beside the list, not an item in it. */}
        {edit && editing && (
          <BlockEditor
            key={editorKey(editing)}
            top={editorTop}
            date={day}
            editing={editing}
            areas={edit.areas}
            tasks={edit.tasks}
            onClose={() => closeEditor(editing.mode === "edit" ? editing.block.id : null)}
            onSave={(ops, said, before) => {
              write(ops, said, before);
              const id = editing.mode === "edit" ? editing.block.id : null;
              const deleted = id !== null && ops.some((op) => op.op === "delete" && op.id === id);
              closeEditor(deleted ? focusAfterDelete(blocks, id) : id);
            }}
            areaName={areaName}
          />
        )}
      </div>
    </div>
  );
}

/** The popover: title, start, end, area, task, delete. Escape closes it. */
function BlockEditor({
  top,
  date,
  editing,
  areas,
  tasks,
  onClose,
  onSave,
  areaName,
}: {
  top: number;
  date: string;
  editing: NonNullable<Editing>;
  areas: { id: string; name: string }[];
  tasks: BoardTask[];
  onClose: () => void;
  onSave: (ops: Op[], said: string, before: Record<string, Record<string, SqlValue>>) => void;
  areaName: (id: string | null) => string | undefined;
}) {
  const block = editing.mode === "edit" ? editing.block : null;
  const [draft, setDraft] = useState<BlockDraft>(() =>
    block ? draftOf(date, block) : editing.mode === "add" ? editing.draft : newDraft(540),
  );
  const [error, setError] = useState<string | null>(null);
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => first.current?.focus(), []);

  // The chosen area's tasks first, then tasks with no area.
  const pick = tasks.filter(
    (task) => task.area_id === draft.areaId || task.area_id === null || task.id === draft.taskId,
  );
  const names = () => ({
    task: tasks.find((task) => task.id === draft.taskId)?.title,
    area: areaName(draft.areaId),
  });
  const save = () => {
    const checked = readDraft(draft);
    if (typeof checked === "string") {
      setError(checked);
      return;
    }
    if (block) {
      const ops = changeOps(date, block, draft, names());
      onSave(ops, `Changed ${block.title}.`, { [block.id]: blockBefore(block) });
    } else {
      const ops = addOps(date, draft, ulid(), names());
      const title = ops[0]?.op === "insert" ? String(ops[0].values.title) : "the block";
      onSave(ops, `Added ${title} at ${draft.start}.`, {});
    }
  };
  const id = block ? `edit-${block.id}` : "edit-new";
  // Escape closes the popover from any of its fields.
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    const node = form.current;
    if (!node) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      onClose();
    };
    node.addEventListener("keydown", onKey);
    return () => node.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <form
      ref={form}
      className="day-editor"
      role="dialog"
      aria-labelledby={`${id}-heading`}
      style={{ top: Math.max(0, top) }}
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      <h3 className="day-editor-heading" id={`${id}-heading`}>
        {block ? `Edit ${block.title}` : "Add a block"}
      </h3>
      <label className="field">
        <span>Title</span>
        <input
          ref={first}
          id={`${id}-title`}
          value={draft.title}
          placeholder={names().task ?? names().area ?? "What is it?"}
          onChange={(event) => setDraft({ ...draft, title: event.target.value })}
        />
      </label>
      <div className="day-editor-times">
        <label className="field">
          <span>Start</span>
          <input
            type="time"
            step={900}
            value={draft.start}
            onChange={(event) => setDraft({ ...draft, start: event.target.value })}
          />
        </label>
        <label className="field">
          <span>End</span>
          <input
            type="time"
            step={900}
            value={draft.end}
            onChange={(event) => setDraft({ ...draft, end: event.target.value })}
          />
        </label>
      </div>
      <label className="field">
        <span>Area</span>
        <select
          value={draft.areaId ?? ""}
          onChange={(event) => setDraft({ ...draft, areaId: event.target.value || null })}
        >
          <option value="">No area</option>
          {areas.map((area) => (
            <option key={area.id} value={area.id}>
              {area.name}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>Task</span>
        <select
          value={draft.taskId ?? ""}
          onChange={(event) => setDraft({ ...draft, taskId: event.target.value || null })}
        >
          <option value="">No task</option>
          {pick.map((task) => (
            <option key={task.id} value={task.id}>
              {task.title}
            </option>
          ))}
        </select>
      </label>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <div className="day-editor-actions">
        <Button primary type="submit">
          {block ? "Save" : "Add"}
        </Button>
        <Button onClick={onClose}>Cancel</Button>
        {block && (
          <Button
            className="day-delete btn-danger"
            onClick={() =>
              onSave(deleteOps(block), `Deleted ${block.title}.`, {
                [block.id]: blockBefore(block),
              })
            }
          >
            Delete
          </Button>
        )}
      </div>
    </form>
  );
}

const BOARD_AREAS_SQL =
  "SELECT id, name FROM area_items WHERE deleted_at IS NULL AND active = 1 ORDER BY priority_rank";

/**
 * What a day's board needs besides its blocks: each area's open tasks for the
 * cards (a task with its own block that day isn't listed again), and the
 * areas and tasks the popover picks from.
 */
export function useBoard(date: string, blocks: BlockRow[], nowMs: number) {
  const areaRows = useLiveQuery<AreaTaskRow>(AREA_TASKS_SQL, [shiftDate(date, 7)]);
  const areas = useLiveQuery<{ id: string; name: string }>(BOARD_AREAS_SQL);
  const tasks = useLiveQuery<BoardTask & Record<string, string | number | null>>(BOARD_TASKS_SQL);
  return {
    blockTasks: blockTaskLists(blocks, areaRows.rows, nowMs),
    edit: { areas: areas.rows, tasks: tasks.rows } satisfies BoardEdit,
    onDone: (task: JobTask) =>
      void transact("user", statusOps(task, "done", systemClock.now()), `task:${task.id}`),
  };
}

type AreaTaskRow = JobTask & Record<string, string | number | null>;
