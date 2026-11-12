import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";

import { systemClock } from "../kernel/clock";
import { query, transact } from "../kernel/db";
import { ulid } from "../kernel/ulid";
import {
  isDue,
  readStatus,
  statusText,
  SYNC_EVERY_MS,
  SYNC_SQL,
  syncCalendar,
  type SyncStatus,
} from "../features/calendar/sync";
import { Button } from "./ui";
import { useLiveQuery } from "./useLiveQuery";

/** One sync at a time in this window. */
let running: Promise<SyncStatus> | null = null;
let runningAccepts = false;

function start(allowShrink: boolean): Promise<SyncStatus> {
  runningAccepts = allowShrink;
  const run = syncCalendar(
    {
      query,
      transact: (ops) => transact("system", ops, "calendar"),
      fetchFeed: () => invoke<string>("calendar_fetch"),
      newId: () => ulid(),
      nowMs: systemClock.now(),
    },
    allowShrink,
  ).finally(() => {
    if (running === run) running = null;
  });
  running = run;
  return run;
}

/**
 * Syncs, or joins the sync already running. Accepting a shrink (Sync now
 * after the warning) while a plain sync runs queues one more that accepts it.
 */
export function syncNow(allowShrink = false): Promise<SyncStatus> {
  if (!running) return start(allowShrink);
  if (!allowShrink || runningAccepts) return running;
  const after = running.catch(() => undefined).then(() => start(true));
  running = after;
  runningAccepts = true;
  return after;
}

async function syncIfDue(): Promise<void> {
  const [row] = await query<{ value_json: string }>(SYNC_SQL);
  const status = readStatus(row?.value_json);
  if (isDue(status, systemClock.now())) await syncNow();
}

/** Syncs when the window opens (if stale) and every 15 minutes while open. */
export function useCalendarSync(): void {
  useEffect(() => {
    void syncIfDue().catch(() => undefined);
    const timer = window.setInterval(() => void syncIfDue().catch(() => undefined), SYNC_EVERY_MS);
    return () => window.clearInterval(timer);
  }, []);
}

const ago = (ms: number) => {
  const minutes = Math.round(ms / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours} h ago` : `${Math.round(hours / 24)} d ago`;
};

/** Settings: the last sync in words, and Sync now. */
export function CalendarStatus() {
  const { rows } = useLiveQuery<{ value_json: string }>(SYNC_SQL);
  const status = readStatus(rows[0]?.value_json);
  const [busy, setBusy] = useState(false);
  const run = () => {
    setBusy(true);
    // After a "far fewer events" warning, syncing again accepts the change.
    void syncNow(status?.held === true).finally(() => setBusy(false));
  };
  return (
    <div className="setting">
      <span>Calendar</span>
      <p className="meta" role="status">
        {statusText(status)}
        {status && ` (${ago(systemClock.now() - status.at)})`}
      </p>
      <div className="row">
        <Button onClick={run} disabled={busy}>
          {busy ? "Syncing…" : "Sync now"}
        </Button>
      </div>
    </div>
  );
}
