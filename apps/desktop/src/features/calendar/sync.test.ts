import { describe, expect, it } from "vitest";

import { type Op, type Row, type SqlValue } from "../../kernel/db";
import { localToEpoch } from "../../capture/when";
import { openTestDb } from "../../test/sqlite";
import {
  calendarCheck,
  isDue,
  readStatus,
  statusText,
  SYNC_EVERY_MS,
  SYNC_SQL,
  syncCalendar,
} from "./sync";

const NOW = localToEpoch("2026-11-12", 9 * 60);

/** A tiny stand-in for the Rust transaction: upserts and soft deletes. */
function harness(feed: () => Promise<string>) {
  const db = openTestDb();
  const query = <T extends Row>(sql: string, params: SqlValue[] = []) =>
    Promise.resolve(db.prepare(sql).all(...(params as (string | number | null)[])) as T[]);
  const transact = (ops: Op[]) => {
    for (const op of ops) {
      if (op.op === "delete") {
        db.prepare(`UPDATE ${op.table} SET deleted_at = 1 WHERE id = ?`).run(op.id);
      } else if (op.op === "upsert" && op.table === "core_settings") {
        db.prepare(
          "INSERT INTO core_settings (key, value_json, updated_at) VALUES (?, ?, 0) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json",
        ).run(op.id, String(op.values.value_json));
      } else if (op.op === "upsert") {
        const cols = Object.keys(op.values);
        db.prepare(
          `INSERT INTO ${op.table} (id, ${cols.join(", ")}, created_at, updated_at) VALUES (?, ${cols.map(() => "?").join(", ")}, 0, 0)
           ON CONFLICT(id) DO UPDATE SET ${cols.map((c) => `${c} = excluded.${c}`).join(", ")}, deleted_at = NULL`,
        ).run(op.id, ...(Object.values(op.values) as (string | number | null)[]));
      } else throw new Error(`unexpected op ${op.op}`);
    }
    return Promise.resolve();
  };
  let n = 0;
  return { db, deps: { query, transact, fetchFeed: feed, newId: () => `id${n++}`, nowMs: NOW } };
}

const feedWith = (...uids: string[]) =>
  [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    ...uids.flatMap((uid, i) => [
      "BEGIN:VEVENT",
      `UID:${uid}`,
      `SUMMARY:${uid}`,
      `DTSTART:202611${13 + i}T070000Z`,
      `DTEND:202611${13 + i}T080000Z`,
      "END:VEVENT",
    ]),
    "END:VCALENDAR",
  ].join("\r\n");

const live = (db: ReturnType<typeof openTestDb>) =>
  db
    .prepare("SELECT ical_uid FROM cal_occurrences WHERE deleted_at IS NULL ORDER BY start_at")
    .all();

describe("calendar sync", () => {
  it("writes the window and saves an ok status", async () => {
    const { db, deps } = harness(() => Promise.resolve(feedWith("a", "b")));
    const status = await syncCalendar(deps);
    expect(status).toEqual({ at: NOW, code: "ok", count: 2, held: false });
    expect(live(db)).toEqual([{ ical_uid: "a" }, { ical_uid: "b" }]);
    const [row] = db.prepare(SYNC_SQL).all() as { value_json: string }[];
    expect(readStatus(row?.value_json)).toEqual(status);
  });

  it("removes an event that left the feed", async () => {
    let feed = feedWith("a", "b");
    const { db, deps } = harness(() => Promise.resolve(feed));
    await syncCalendar(deps);
    feed = feedWith("a");
    await syncCalendar(deps);
    expect(live(db)).toEqual([{ ical_uid: "a" }]);
  });

  it("keeps the events and says why when the fetch fails", async () => {
    let fail = false;
    const { db, deps } = harness(() =>
      fail ? Promise.reject("link_revoked") : Promise.resolve(feedWith("a")),
    );
    await syncCalendar(deps);
    fail = true;
    const status = await syncCalendar(deps);
    expect(status).toMatchObject({ code: "link_revoked", count: 1 });
    expect(live(db)).toHaveLength(1);
    expect(statusText(status)).toMatch(/copy the secret address again/);
  });

  it("calls a page that isn't a calendar bad_payload and anything unknown offline", async () => {
    const page = harness(() => Promise.resolve("<html>"));
    expect((await syncCalendar(page.deps)).code).toBe("bad_payload");
    const odd = harness(() => Promise.reject(new Error("socket hang up")));
    expect((await syncCalendar(odd.deps)).code).toBe("offline");
  });

  it("holds deletions when the feed shrinks, until you accept it", async () => {
    let feed = feedWith("a", "b", "c", "d", "e");
    const { db, deps } = harness(() => Promise.resolve(feed));
    await syncCalendar(deps);
    feed = feedWith("a");
    expect((await syncCalendar(deps)).held).toBe(true);
    expect(live(db)).toHaveLength(5);
    expect((await syncCalendar(deps, true)).held).toBe(false);
    expect(live(db)).toHaveLength(1);
  });

  it("is due after 15 minutes", () => {
    expect(isDue(null, NOW)).toBe(true);
    const status = { at: NOW, code: "ok" as const, count: 0, held: false };
    expect(isDue(status, NOW + SYNC_EVERY_MS - 1)).toBe(false);
    expect(isDue(status, NOW + SYNC_EVERY_MS)).toBe(true);
    expect(readStatus("{bad")).toBeNull();
  });

  it("asks for a new address in the brief only when you need to act", () => {
    const at = (code: "ok" | "offline" | "link_revoked", held = false) => ({
      at: NOW,
      code,
      count: 0,
      held,
    });
    expect(calendarCheck(at("link_revoked"))).toMatch(/needs replacing/);
    expect(calendarCheck(at("ok", true))).toMatch(/fewer events/);
    expect(calendarCheck(at("offline"))).toBeNull();
    expect(calendarCheck(at("ok"))).toBeNull();
    expect(calendarCheck(null)).toBeNull();
  });
});
