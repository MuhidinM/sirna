/**
 * Calendar sync (R-CAL-01): fetch through Rust, parse here, write the
 * window, then plan today and tomorrow again around the events. Runs when
 * the main window opens (if the last sync is over 15 minutes old), every 15
 * minutes while it is open, and from Settings → Sync now.
 */
import { type Op, type Row } from "../../kernel/db";
import { logicalDate } from "../../kernel/dates";
import { type Query, replanDay, shiftDate } from "../plan/dayplan";
import { FeedError, type Occurrence, parseFeed, syncOps, windowOf, WINDOW_SQL } from "./ics";

export const SYNC_EVERY_MS = 15 * 60 * 1000;
export const SYNC_KEY = "calendar.sync";
export const SYNC_SQL = `SELECT value_json FROM core_settings WHERE key = '${SYNC_KEY}'`;

export type SyncCode = "ok" | "no-link" | "bad_link" | "link_revoked" | "bad_payload" | "offline";

export interface SyncStatus {
  at: number;
  code: SyncCode;
  /** Events in the window after the sync. */
  count: number;
  /** Deletions held back: the feed shrank by more than half. */
  held: boolean;
}

const CODES: SyncCode[] = ["ok", "no-link", "bad_link", "link_revoked", "bad_payload", "offline"];

export function readStatus(valueJson: string | null | undefined): SyncStatus | null {
  try {
    const value: unknown = JSON.parse(valueJson ?? "null");
    if (!value || typeof value !== "object") return null;
    const { at, code, count, held } = value as Record<string, unknown>;
    if (typeof at !== "number" || !CODES.includes(code as SyncCode)) return null;
    return {
      at,
      code: code as SyncCode,
      count: typeof count === "number" ? count : 0,
      held: held === true,
    };
  } catch {
    return null;
  }
}

/** What a status means, in words. */
export function statusText(status: SyncStatus | null): string {
  if (!status) return "Not synced yet.";
  switch (status.code) {
    case "ok":
      return status.held
        ? `Synced, but the calendar suddenly has far fewer events, so nothing was removed. Check the address, or sync again to accept it.`
        : `Synced: ${status.count} event${status.count === 1 ? "" : "s"} in the next two weeks.`;
    case "no-link":
      return "No calendar address saved. Add your Google Calendar secret iCal address above.";
    case "bad_link":
      return "That address isn't a Google Calendar iCal address (it should start with https://calendar.google.com/).";
    case "link_revoked":
      return "Google refused the address. It may have been reset: copy the secret address again from Google Calendar settings.";
    case "bad_payload":
      return "The address gave something that isn't a calendar. Check you copied the secret address in iCal format.";
    case "offline":
      return "Couldn't reach Google Calendar. Sirna will try again in 15 minutes; your plan keeps the last events.";
  }
}

/** A brief CHECK line when the calendar needs you (not for a passing outage). */
export function calendarCheck(status: SyncStatus | null): string | null {
  if (!status) return null;
  if (status.code === "link_revoked" || status.code === "bad_link" || status.code === "bad_payload")
    return "Calendar sync stopped: the iCal address needs replacing in Settings.";
  if (status.code === "ok" && status.held)
    return "Your calendar suddenly has far fewer events; check it in Settings.";
  return null;
}

export function isDue(status: SyncStatus | null, nowMs: number): boolean {
  return !status || nowMs - status.at >= SYNC_EVERY_MS;
}

export interface SyncDeps {
  query: Query;
  transact: (ops: Op[]) => Promise<unknown>;
  fetchFeed: () => Promise<string>;
  newId: () => string;
  nowMs: number;
}

const statusOp = (status: SyncStatus): Op => ({
  op: "upsert",
  table: "core_settings",
  id: SYNC_KEY,
  values: { value_json: JSON.stringify(status) },
});

const asCode = (error: unknown): SyncCode => {
  if (error instanceof FeedError) return error.code;
  const text = typeof error === "string" ? error : error instanceof Error ? error.message : "";
  return CODES.includes(text as SyncCode) && text !== "ok" ? (text as SyncCode) : "offline";
};

/**
 * One sync. `allowShrink` accepts a big drop in events (Sync now after a
 * warning). Never throws: the result is saved and returned.
 */
export async function syncCalendar(deps: SyncDeps, allowShrink = false): Promise<SyncStatus> {
  const today = logicalDate(deps.nowMs);
  const { from, to } = windowOf(today);
  let status: SyncStatus;
  let changed = false;
  try {
    const feed = await deps.fetchFeed();
    const fresh = parseFeed(feed, from, to);
    const existing = await deps.query<Occurrence & Row>(WINDOW_SQL, [from, to]);
    const plan = syncOps(fresh, existing, allowShrink);
    changed = plan.changed;
    status = { at: deps.nowMs, code: "ok", count: fresh.length, held: plan.held };
    await deps.transact([...plan.ops, statusOp(status)]);
  } catch (error) {
    const [previous] = await deps.query<{ value_json: string }>(SYNC_SQL).catch(() => []);
    const count = readStatus(previous?.value_json)?.count ?? 0;
    status = { at: deps.nowMs, code: asCode(error), count, held: false };
    await deps.transact([statusOp(status)]).catch(() => undefined);
    return status;
  }
  if (changed)
    for (const date of [today, shiftDate(today, 1)])
      await replanDay(deps.query, deps.transact, date, deps.newId).catch(() => undefined);
  return status;
}
