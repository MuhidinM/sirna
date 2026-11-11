//! Reminders that fire with no window open (plan §8).
//!
//! A thread wakes at each minute boundary, reads due reminders from the
//! `v_reminders_*` views, and decides what to show with `plan_tick` (pure, so
//! it is tested without Windows):
//! - due within the last 15 minutes → its own toast;
//! - later than that (the laptop slept) → one summary toast;
//! - more than 3 at once → one summary toast;
//! - older than 12 hours → recorded as expired, not shown (the brief lists it).

use std::time::Duration;

use rusqlite::{Connection, params};
use tauri::{AppHandle, Emitter, Manager};

use crate::db::Db;
use crate::notify::{self, Button};
use crate::{clock, tasks, windows};

const MINUTE_MS: i64 = 60_000;
pub const LATE_MS: i64 = 15 * MINUTE_MS;
pub const EXPIRE_MS: i64 = 12 * 60 * MINUTE_MS;
pub const BURST: usize = 3;
pub const SNOOZE_MS: i64 = 10 * MINUTE_MS;
/// App-initiated nudges allowed per day (plan §8). Your own reminders don't count.
pub const DAILY_NUDGE_CAP: i64 = 8;

/// Block toasts and nudges are about this moment: late ones are dropped, not summarised.
fn is_moment(kind: &str) -> bool {
    kind == "block" || kind == "nudge"
}

#[derive(Debug, Clone, PartialEq)]
pub struct Due {
    pub key: String,
    pub kind: String,
    pub entity_id: String,
    pub fire_at: i64,
    /// When it became due: the snooze end for a snoozed reminder, else fire_at.
    /// Lateness is measured from here, so a snoozed reminder comes back as a
    /// normal toast, not a summary.
    pub due_at: i64,
    pub title: String,
}

#[derive(Debug, PartialEq)]
pub enum Action {
    Show(Due),
    Summary(Vec<Due>),
    Expire(Due),
}

/// Decides what to show for the reminders due at `now_ms`.
pub fn plan_tick(due: Vec<Due>, now_ms: i64) -> Vec<Action> {
    let mut actions = Vec::new();
    let mut fresh = Vec::new();
    let mut late = Vec::new();
    for item in due {
        let age = now_ms - item.due_at;
        if age > EXPIRE_MS || (is_moment(&item.kind) && age > LATE_MS) {
            actions.push(Action::Expire(item));
        } else if age > LATE_MS {
            late.push(item);
        } else {
            fresh.push(item);
        }
    }
    if fresh.len() > BURST {
        late.append(&mut fresh);
    }
    actions.extend(fresh.into_iter().map(Action::Show));
    if !late.is_empty() {
        late.sort_by_key(|item| item.fire_at);
        actions.push(Action::Summary(late));
    }
    actions
}

/// Reminders whose time has come and that haven't been shown (or whose snooze ended).
pub fn due_now(conn: &Connection, now_ms: i64) -> rusqlite::Result<Vec<Due>> {
    let mut statement = conn.prepare(
        "SELECT r.key, r.kind, r.entity_id, r.fire_at,
                COALESCE(CASE WHEN n.outcome = 'snoozed' THEN n.snoozed_until END, r.fire_at),
                r.title
         FROM (SELECT * FROM v_reminders_task UNION ALL SELECT * FROM v_reminders_block) AS r
         LEFT JOIN core_notifications AS n ON n.key = r.key
         WHERE r.fire_at <= ?1
           AND (n.key IS NULL OR (n.outcome = 'snoozed' AND n.snoozed_until <= ?1))
         ORDER BY r.fire_at",
    )?;
    let rows = statement.query_map([now_ms], |row| {
        Ok(Due {
            key: row.get(0)?,
            kind: row.get(1)?,
            entity_id: row.get(2)?,
            fire_at: row.get(3)?,
            due_at: row.get(4)?,
            title: row.get(5)?,
        })
    })?;
    rows.collect()
}

/// Records that a reminder was shown (or summarised, or expired).
pub fn record(
    conn: &Connection,
    item: &Due,
    now_ms: i64,
    outcome: Option<&str>,
) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO core_notifications (key, kind, fired_at, outcome, outcome_at, snoozed_until)
         VALUES (?1, ?2, ?3, ?4, CASE WHEN ?4 IS NULL THEN NULL ELSE ?3 END, NULL)
         ON CONFLICT (key) DO UPDATE SET fired_at = ?3, outcome = ?4,
           outcome_at = CASE WHEN ?4 IS NULL THEN NULL ELSE ?3 END, snoozed_until = NULL",
        params![item.key, item.kind, now_ms, outcome],
    )?;
    Ok(())
}

pub fn set_outcome(
    conn: &Connection,
    key: &str,
    outcome: &str,
    now_ms: i64,
    snoozed_until: Option<i64>,
) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE core_notifications SET outcome = ?2, outcome_at = ?3, snoozed_until = ?4 WHERE key = ?1",
        params![key, outcome, now_ms, snoozed_until],
    )?;
    Ok(())
}

fn local_time(epoch_ms: i64) -> String {
    let minutes = (epoch_ms / MINUTE_MS + 180).rem_euclid(24 * 60);
    format!("{:02}:{:02}", minutes / 60, minutes % 60)
}

pub fn summary_text(items: &[Due]) -> String {
    let names: Vec<&str> = items
        .iter()
        .take(3)
        .map(|item| item.title.as_str())
        .collect();
    let more = items.len().saturating_sub(3);
    let list = if more > 0 {
        format!("{} and {more} more", names.join(", "))
    } else {
        names.join(", ")
    };
    let count = items.len();
    let noun = if count == 1 { "reminder" } else { "reminders" };
    format!("{count} {noun} passed: {list}")
}

/// Nudges shown today (for the daily cap), counted from the logical day's start.
fn nudges_today(conn: &Connection, now_ms: i64) -> i64 {
    let (_, day_start) = tasks::logical_day(now_ms);
    conn.query_row(
        "SELECT count(*) FROM core_notifications WHERE kind = 'nudge' AND counted = 1 AND fired_at >= ?1",
        [day_start],
        |row| row.get(0),
    )
    .unwrap_or(0)
}

fn set_block_status(app: &AppHandle, block_id: &str, status: &str) {
    let result = {
        let db = app.state::<Db>();
        let mut conn = db.write.lock();
        (|| -> Result<(), String> {
            let txn = conn.transaction().map_err(|error| error.to_string())?;
            let mut values = serde_json::Map::new();
            values.insert("status".into(), serde_json::Value::from(status));
            let op = crate::tx::Op::Update {
                table: "day_blocks".into(),
                id: block_id.into(),
                values,
            };
            crate::tx::apply_ops(&txn, "user", Some("toast"), &[op], clock::now_ms())
                .map_err(|error| error.to_string())?;
            txn.commit().map_err(|error| error.to_string())
        })()
    };
    if let Err(error) = result {
        log::warn!("could not update the block from a toast: {error}");
    }
    let _ = app.emit("data-changed", ["day_blocks"]);
}

fn record_outcome(app: &AppHandle, key: &str, outcome: &str) {
    let db = app.state::<Db>();
    let conn = db.write.lock();
    if let Err(error) = set_outcome(&conn, key, outcome, clock::now_ms(), None) {
        log::warn!("could not record the toast outcome: {error}");
    }
}

/// A block starting (focus or routine), or the "just one session?" nudge.
fn show_block(app: &AppHandle, item: Due) {
    let handle = app.clone();
    let key = item.key.clone();
    let block_id = item.entity_id.clone();
    let (first_step, is_area, end) = {
        let db = app.state::<Db>();
        let conn = db.write.lock();
        conn.query_row(
            "SELECT COALESCE(t.title, b.title), b.kind = 'area', b.end_at FROM day_blocks AS b
             LEFT JOIN task_items AS t ON t.id = b.task_id WHERE b.id = ?1",
            [&block_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, bool>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            },
        )
        .unwrap_or((item.title.clone(), false, item.fire_at))
    };
    let (title, body, buttons): (String, String, Vec<Button>) = match (item.kind.as_str(), is_area)
    {
        ("nudge", _) => (
            format!("Just one session on {}?", item.title),
            "25 minutes. You can stop after that.".into(),
            vec![
                Button {
                    label: "Start",
                    action: "start",
                },
                Button {
                    label: "Skip",
                    action: "skip",
                },
            ],
        ),
        (_, true) => (
            format!(
                "{} · {}–{}",
                item.title,
                local_time(item.fire_at),
                local_time(end)
            ),
            format!("First step: {first_step}"),
            vec![
                Button {
                    label: "Start focus",
                    action: "start",
                },
                Button {
                    label: "Skip",
                    action: "skip",
                },
            ],
        ),
        _ => (
            format!("{} · {}", item.title, local_time(item.fire_at)),
            "From your routine.".into(),
            vec![
                Button {
                    label: "Done",
                    action: "done",
                },
                Button {
                    label: "Skip",
                    action: "skip",
                },
            ],
        ),
    };
    let result = notify::show(app, &title, &body, &buttons, move |action| {
        match action.as_deref() {
            Some("start") => {
                crate::windows::spawn_open_setup(handle.clone(), Some(block_id.clone()));
                record_outcome(&handle, &key, "clicked");
            }
            Some("done") => {
                set_block_status(&handle, &block_id, "done");
                record_outcome(&handle, &key, "done");
            }
            Some("skip") => {
                set_block_status(&handle, &block_id, "skipped");
                record_outcome(&handle, &key, "dismissed");
            }
            _ => {
                windows::spawn_open_main(handle.clone());
                record_outcome(&handle, &key, "clicked");
            }
        }
    });
    if let Err(error) = result {
        log::error!("could not show a block toast: {error}");
    }
}

fn show_one(app: &AppHandle, item: Due) {
    if is_moment(&item.kind) {
        show_block(app, item);
        return;
    }
    let handle = app.clone();
    let key = item.key.clone();
    let task_id = item.entity_id.clone();
    let title = format!("{} · {}", item.title, local_time(item.fire_at));
    let buttons = [
        Button {
            label: "Done",
            action: "done",
        },
        Button {
            label: "Snooze 10 min",
            action: "snooze",
        },
    ];
    let result = notify::show(app, &title, "Sirna reminder", &buttons, move |action| {
        let db = handle.state::<Db>();
        let mut conn = db.write.lock();
        let now = clock::now_ms();
        let outcome = match action.as_deref() {
            Some("done") => {
                if let Err(error) = tasks::mark_done(&mut conn, &task_id, now) {
                    log::warn!("could not mark the task done from a toast: {error}");
                }
                set_outcome(&conn, &key, "done", now, None)
            }
            Some("snooze") => set_outcome(&conn, &key, "snoozed", now, Some(now + SNOOZE_MS)),
            _ => {
                windows::spawn_open_main(handle.clone());
                set_outcome(&conn, &key, "clicked", now, None)
            }
        };
        drop(conn);
        if let Err(error) = outcome {
            log::warn!("could not record the toast outcome: {error}");
        }
        let _ = handle.emit("data-changed", ["task_items", "core_notifications"]);
    });
    if let Err(error) = result {
        log::error!("could not show a reminder: {error}");
    }
}

fn show_summary(app: &AppHandle, items: &[Due]) {
    let handle = app.clone();
    let result = notify::show(
        app,
        "While you were away",
        &summary_text(items),
        &[Button {
            label: "Open Sirna",
            action: "open",
        }],
        move |_| windows::spawn_open_main(handle.clone()),
    );
    if let Err(error) = result {
        log::error!("could not show the reminder summary: {error}");
    }
}

/// One tick: read, decide, record, then show (toasts outside the DB lock).
pub fn tick(app: &AppHandle, now_ms: i64) {
    let actions = {
        let db = app.state::<Db>();
        let conn = db.write.lock();
        let due = match due_now(&conn, now_ms) {
            Ok(due) => due,
            Err(error) => {
                log::error!("could not read reminders: {error}");
                return;
            }
        };
        let mut actions = plan_tick(due, now_ms);
        // Nudges are app-initiated: at most DAILY_NUDGE_CAP a day.
        let mut nudges = nudges_today(&conn, now_ms);
        for action in &mut actions {
            if let Action::Show(item) = action
                && item.kind == "nudge"
            {
                if nudges >= DAILY_NUDGE_CAP {
                    *action = Action::Expire(item.clone());
                } else {
                    nudges += 1;
                }
            }
        }
        for action in &actions {
            let result = match action {
                Action::Show(item) => record(&conn, item, now_ms, None).and_then(|()| {
                    if item.kind == "nudge" {
                        conn.execute(
                            "UPDATE core_notifications SET counted = 1 WHERE key = ?1",
                            [&item.key],
                        )?;
                    }
                    Ok(())
                }),
                Action::Summary(items) => items
                    .iter()
                    .try_for_each(|item| record(&conn, item, now_ms, Some("summarized"))),
                Action::Expire(item) => record(&conn, item, now_ms, Some("expired")),
            };
            if let Err(error) = result {
                log::error!("could not record a reminder: {error}");
            }
        }
        actions
    };
    for action in actions {
        match action {
            Action::Show(item) => show_one(app, item),
            Action::Summary(items) => show_summary(app, &items),
            Action::Expire(_) => {}
        }
    }
}

/// Starts the minute tick on its own thread. Wall-clock based: after sleep the
/// next tick catches up, so the worst delay after waking is a minute.
pub fn start(app: AppHandle) {
    let spawned = std::thread::Builder::new()
        .name("sirna-tick".into())
        .spawn(move || {
            let mut day = tasks::logical_day(clock::now_ms()).0;
            loop {
                let now = clock::now_ms();
                let wait = MINUTE_MS - now.rem_euclid(MINUTE_MS) + 50;
                std::thread::sleep(Duration::from_millis(u64::try_from(wait).unwrap_or(60_000)));
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    tick(&app, clock::now_ms());
                }));
                if result.is_err() {
                    log::error!("the reminder tick panicked; it will run again next minute");
                }
                // At 03:00 a new logical day starts: the tray and Today must show it
                // even when nothing was written overnight.
                let today = tasks::logical_day(clock::now_ms()).0;
                if today != day {
                    day = today;
                    let _ = app.emit("data-changed", ["day"]);
                }
            }
        });
    if let Err(error) = spawned {
        log::error!("could not start the reminder tick: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{db, migrate};

    const NOW: i64 = 1_794_387_600_000; // 2026-11-11 12:00 Addis

    fn due(key: &str, minutes_ago: i64) -> Due {
        Due {
            key: key.into(),
            kind: "task".into(),
            entity_id: key.into(),
            fire_at: NOW - minutes_ago * MINUTE_MS,
            due_at: NOW - minutes_ago * MINUTE_MS,
            title: key.into(),
        }
    }

    #[test]
    fn fresh_reminders_get_their_own_toast() {
        assert_eq!(
            plan_tick(vec![due("a", 0), due("b", 14)], NOW),
            vec![Action::Show(due("a", 0)), Action::Show(due("b", 14))]
        );
    }

    #[test]
    fn missed_while_asleep_become_one_summary() {
        assert_eq!(
            plan_tick(vec![due("a", 120), due("b", 30)], NOW),
            vec![Action::Summary(vec![due("a", 120), due("b", 30)])]
        );
    }

    #[test]
    fn a_burst_becomes_one_summary() {
        let items: Vec<Due> = (0..4).map(|i| due(&format!("r{i}"), i)).collect();
        let actions = plan_tick(items, NOW);
        assert!(matches!(actions.as_slice(), [Action::Summary(list)] if list.len() == 4));
    }

    #[test]
    fn very_old_reminders_expire_quietly() {
        assert_eq!(
            plan_tick(vec![due("old", 13 * 60)], NOW),
            vec![Action::Expire(due("old", 13 * 60))]
        );
    }

    #[test]
    fn summary_text_lists_up_to_three() {
        let items: Vec<Due> = ["Call bank", "Pay EEU", "Gym", "Read"]
            .iter()
            .map(|t| due(t, 30))
            .collect();
        assert_eq!(
            summary_text(&items),
            "4 reminders passed: Call bank, Pay EEU, Gym and 1 more"
        );
        assert_eq!(summary_text(&items[..1]), "1 reminder passed: Call bank");
    }

    #[test]
    fn local_time_is_addis_ababa() {
        assert_eq!(local_time(NOW), "12:00");
    }

    fn conn() -> Connection {
        let mut conn = Connection::open_in_memory().expect("open");
        db::configure(&conn).expect("pragmas");
        migrate::run(&mut conn, migrate::MIGRATIONS, 0).expect("migrate");
        conn
    }

    #[test]
    fn a_reminder_fires_once_and_again_after_snooze() {
        let conn = conn();
        conn.execute(
            "INSERT INTO task_items (id, title, status, remind_at, created_at, updated_at)
             VALUES ('t1', 'Call bank', 'todo', ?1, 0, 0)",
            [NOW - MINUTE_MS],
        )
        .expect("task");

        let first = due_now(&conn, NOW).expect("due");
        assert_eq!(first.len(), 1);
        record(&conn, &first[0], NOW, None).expect("record");
        assert!(due_now(&conn, NOW + MINUTE_MS).expect("due").is_empty());

        set_outcome(&conn, &first[0].key, "snoozed", NOW, Some(NOW + SNOOZE_MS)).expect("snooze");
        assert!(due_now(&conn, NOW + 5 * MINUTE_MS).expect("due").is_empty());
        assert_eq!(due_now(&conn, NOW + SNOOZE_MS).expect("due").len(), 1);
    }

    #[test]
    fn done_and_future_tasks_do_not_fire() {
        let conn = conn();
        conn.execute_batch(&format!(
            "INSERT INTO task_items (id, title, status, remind_at, created_at, updated_at) VALUES
               ('done', 'x', 'done', {past}, 0, 0),
               ('later', 'y', 'todo', {future}, 0, 0);",
            past = NOW - MINUTE_MS,
            future = NOW + 60 * MINUTE_MS
        ))
        .expect("seed");
        assert!(due_now(&conn, NOW).expect("due").is_empty());
    }

    #[test]
    fn waiting_items_remind_at_nine_on_their_follow_up_date() {
        let conn = conn();
        conn.execute(
            "INSERT INTO task_items (id, title, status, waiting_on, follow_up_date, created_at, updated_at)
             VALUES ('w', 'Waiting: recruiter', 'waiting', 'recruiter', '2026-11-11', 0, 0)",
            [],
        )
        .expect("seed");
        let items = due_now(&conn, NOW).expect("due");
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].title, "Follow up: recruiter");
        assert_eq!(local_time(items[0].fire_at), "09:00");
    }

    #[test]
    fn a_snoozed_reminder_comes_back_as_its_own_toast() {
        let conn = conn();
        conn.execute(
            "INSERT INTO task_items (id, title, status, remind_at, created_at, updated_at)
             VALUES ('t1', 'Call bank', 'todo', ?1, 0, 0)",
            [NOW - 30 * MINUTE_MS],
        )
        .expect("task");
        let item = &due_now(&conn, NOW - 30 * MINUTE_MS).expect("due")[0];
        record(&conn, item, NOW - 30 * MINUTE_MS, None).expect("record");
        set_outcome(&conn, &item.key, "snoozed", NOW - 25 * MINUTE_MS, Some(NOW)).expect("snooze");

        let back = due_now(&conn, NOW).expect("due again");
        assert_eq!(back[0].due_at, NOW);
        assert!(matches!(plan_tick(back, NOW).as_slice(), [Action::Show(_)]));
    }

    fn moment(key: &str, kind: &str, minutes_ago: i64) -> Due {
        Due {
            kind: kind.into(),
            ..due(key, minutes_ago)
        }
    }

    #[test]
    fn late_block_toasts_and_nudges_are_dropped_not_summarised() {
        let actions = plan_tick(
            vec![
                moment("b", "block", 20),
                moment("n", "nudge", 30),
                due("t", 20),
            ],
            NOW,
        );
        assert_eq!(
            actions,
            vec![
                Action::Expire(moment("b", "block", 20)),
                Action::Expire(moment("n", "nudge", 30)),
                Action::Summary(vec![due("t", 20)]),
            ]
        );
    }

    #[test]
    fn blocks_toast_when_they_start_and_nudge_without_a_session() {
        let conn = conn();
        conn.execute_batch(&format!(
            "INSERT INTO day_blocks (id, logical_date, start_at, end_at, kind, area_id, title, created_at, updated_at) VALUES
               ('focus', '2026-11-11', {start}, {end}, 'area', 'coding', 'Coding skills', 0, 0),
               ('work', '2026-11-11', {start}, {end}, 'fixed', 'joba', 'Job A', 0, 0),
               ('quran', '2026-11-11', {start}, {end}, 'routine', 'quran', 'Quran', 0, 0),
               ('review', '2026-11-11', {start2}, {end}, 'routine', NULL, 'Night review', 0, 0);",
            start = NOW - 11 * MINUTE_MS,
            start2 = NOW - 10 * MINUTE_MS,
            end = NOW + 60 * MINUTE_MS
        ))
        .expect("blocks");
        let keys = |conn: &Connection| -> Vec<String> {
            due_now(conn, NOW)
                .expect("due")
                .into_iter()
                .map(|d| d.key)
                .collect()
        };
        assert_eq!(
            keys(&conn),
            vec!["block:focus", "block:quran", "nudge:focus"]
        );

        // A session started in the block silences the nudge.
        conn.execute(
            "INSERT INTO focus_sessions (id, block_id, kind, started_at, planned_min) VALUES ('s', 'focus', 'focus', ?1, 25)",
            [NOW - 5 * MINUTE_MS],
        )
        .expect("session");
        assert_eq!(keys(&conn), vec!["block:focus", "block:quran"]);
    }

    #[test]
    fn nudges_count_toward_the_daily_cap() {
        let conn = conn();
        for n in 0..3 {
            conn.execute(
                "INSERT INTO core_notifications (key, kind, fired_at, counted) VALUES (?1, 'nudge', ?2, 1)",
                params![format!("nudge:{n}"), NOW - MINUTE_MS],
            )
            .expect("seed");
        }
        assert_eq!(nudges_today(&conn, NOW), 3);
    }
}
