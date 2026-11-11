//! The night review prompt (plan §3.9). A toast at review time with Start,
//! In 30 min and Skip tonight; if the PC was locked or asleep, it comes at the
//! next unlock before the hard stop. The tray offers it until 03:00. It never
//! opens by itself.

use parking_lot::Mutex;
use rusqlite::{Connection, OptionalExtension};
use tauri::{AppHandle, Emitter, Manager};

use crate::{clock, db::Db, notify, session, tasks, windows};

pub const DEFAULT_REVIEW_MIN: u32 = 21 * 60;
pub const DEFAULT_HARD_STOP_MIN: u32 = 22 * 60 + 30;
pub const SNOOZE_MS: i64 = 30 * 60_000;
/// The logical date the toast last showed.
const PROMPTED_KEY: &str = "review.prompted";

static OFFERED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// A screen the main window should show when it opens (the review).
#[derive(Default)]
pub struct PendingScreen(pub Mutex<Option<String>>);

/// Snooze end, in memory: a restart simply prompts again.
#[derive(Default)]
pub struct Snooze(pub Mutex<Option<i64>>);

/// Minutes since the logical day began (03:00), so 01:00 is after 21:00.
pub fn logical_minutes(local_min: u32) -> u32 {
    (local_min + 24 * 60 - 3 * 60) % (24 * 60)
}

/// Pure: should the review toast show now? Times are local minutes.
pub fn should_prompt(
    local_min: u32,
    review_min: u32,
    hard_stop_min: u32,
    finished: bool,
    prompted_today: bool,
    snooze_over: Option<bool>,
) -> bool {
    let now = logical_minutes(local_min);
    let open = now >= logical_minutes(review_min) && now < logical_minutes(hard_stop_min);
    if finished || !open {
        return false;
    }
    match snooze_over {
        Some(over) => over,
        None => !prompted_today,
    }
}

/// Pure: whether the tray shows "Night review" (from review time to 03:00).
pub fn tray_offers(local_min: u32, review_min: u32, finished: bool) -> bool {
    !finished && logical_minutes(local_min) >= logical_minutes(review_min)
}

fn minutes_setting(conn: &Connection, key: &str, default: u32) -> u32 {
    crate::db::setting_string(conn, key)
        .and_then(|text| session::parse_hhmm(&text))
        .unwrap_or(default)
}

/// Done or skipped tonight.
pub fn finished(conn: &Connection, date: &str) -> bool {
    conn.query_row(
        "SELECT status FROM day_reviews WHERE logical_date = ?1",
        [date],
        |row| row.get::<_, String>(0),
    )
    .optional()
    .ok()
    .flatten()
    .is_some_and(|status| status != "open")
}

/// For the tray menu.
pub fn offered(conn: &Connection, now_ms: i64) -> bool {
    let (date, _) = tasks::logical_day(now_ms);
    tray_offers(
        session::local_minutes(now_ms),
        minutes_setting(conn, "day.review", DEFAULT_REVIEW_MIN),
        finished(conn, &date) || crate::away::is_away(conn, &date),
    )
}

fn upsert(conn: &mut Connection, table: &str, id: &str, key: &str, value: serde_json::Value) {
    let result = (|| -> Result<(), String> {
        let txn = conn.transaction().map_err(|error| error.to_string())?;
        let mut values = serde_json::Map::new();
        values.insert(key.into(), value);
        let op = crate::tx::Op::Upsert {
            table: table.into(),
            id: id.into(),
            values,
        };
        crate::tx::apply_ops(&txn, "user", Some("review"), &[op], clock::now_ms())
            .map_err(|error| error.to_string())?;
        txn.commit().map_err(|error| error.to_string())
    })();
    if let Err(error) = result {
        log::warn!("could not save {table} {id}: {error}");
    }
}

/// Called once a minute while the session is unlocked, and at unlock.
pub fn tick(app: &AppHandle) {
    let now = clock::now_ms();
    let (date, _) = tasks::logical_day(now);
    let snooze_over = app.state::<Snooze>().0.lock().map(|until| now >= until);
    let prompt = {
        let db = app.state::<Db>();
        let conn = db.write.lock();
        should_prompt(
            session::local_minutes(now),
            minutes_setting(&conn, "day.review", DEFAULT_REVIEW_MIN),
            minutes_setting(&conn, "day.hard_stop", DEFAULT_HARD_STOP_MIN),
            // Away pauses the review (plan §3.11).
            finished(&conn, &date) || crate::away::is_away(&conn, &date),
            crate::db::setting_string(&conn, PROMPTED_KEY).as_deref() == Some(date.as_str()),
            snooze_over,
        )
    };
    let offer = offered(&app.state::<Db>().write.lock(), now);
    if OFFERED.swap(offer, std::sync::atomic::Ordering::Relaxed) != offer {
        crate::tray::rebuild(app);
    }
    if !prompt {
        return;
    }
    *app.state::<Snooze>().0.lock() = None;
    upsert(
        &mut app.state::<Db>().write.lock(),
        "core_settings",
        PROMPTED_KEY,
        "value_json",
        serde_json::Value::from(format!("\"{date}\"")),
    );
    show_toast(app, date);
}

fn show_toast(app: &AppHandle, date: String) {
    let handle = app.clone();
    let buttons = [
        notify::Button {
            label: "Start",
            action: "start",
        },
        notify::Button {
            label: "In 30 min",
            action: "snooze",
        },
        notify::Button {
            label: "Skip tonight",
            action: "skip",
        },
    ];
    let result = notify::show(
        app,
        "Night review",
        "Four short steps: today, spending, energy, tomorrow.",
        &buttons,
        move |action| match action.as_deref() {
            Some("snooze") => {
                *handle.state::<Snooze>().0.lock() = Some(clock::now_ms() + SNOOZE_MS);
            }
            Some("skip") => {
                upsert(
                    &mut handle.state::<Db>().write.lock(),
                    "day_reviews",
                    &date,
                    "status",
                    serde_json::Value::from("skipped"),
                );
                let _ = handle.emit("data-changed", ["day_reviews"]);
            }
            _ => open(&handle),
        },
    );
    if let Err(error) = result {
        log::error!("could not show the review toast: {error}");
    }
}

/// Opens the main window on the review.
pub fn open(app: &AppHandle) {
    open_screen(app, "review");
}

/// Opens the main window on a screen: "review", or "notes:<query>".
pub fn open_screen(app: &AppHandle, screen: &str) {
    *app.state::<PendingScreen>().0.lock() = Some(screen.to_string());
    let _ = app.emit("show-screen", screen);
    windows::spawn_open_main(app.clone());
}

pub fn manage(app: &AppHandle) {
    app.manage(PendingScreen::default());
    app.manage(Snooze::default());
}

#[cfg(test)]
mod tests {
    use super::*;

    const REVIEW: u32 = 21 * 60;
    const STOP: u32 = 22 * 60 + 30;

    #[test]
    fn prompts_once_between_review_and_hard_stop() {
        assert!(!should_prompt(
            20 * 60 + 59,
            REVIEW,
            STOP,
            false,
            false,
            None
        ));
        assert!(should_prompt(21 * 60, REVIEW, STOP, false, false, None));
        assert!(!should_prompt(21 * 60 + 5, REVIEW, STOP, false, true, None));
        assert!(!should_prompt(STOP, REVIEW, STOP, false, false, None));
    }

    #[test]
    fn done_or_skipped_never_prompts() {
        assert!(!should_prompt(
            21 * 60 + 10,
            REVIEW,
            STOP,
            true,
            false,
            None
        ));
        assert!(!should_prompt(
            21 * 60 + 40,
            REVIEW,
            STOP,
            true,
            true,
            Some(true)
        ));
    }

    #[test]
    fn snooze_brings_it_back_once_over() {
        assert!(!should_prompt(
            21 * 60 + 10,
            REVIEW,
            STOP,
            false,
            true,
            Some(false)
        ));
        assert!(should_prompt(
            21 * 60 + 40,
            REVIEW,
            STOP,
            false,
            true,
            Some(true)
        ));
    }

    #[test]
    fn hard_stop_after_midnight_still_works() {
        let stop = 30; // 00:30
        assert!(should_prompt(
            23 * 60 + 50,
            REVIEW,
            stop,
            false,
            false,
            None
        ));
        assert!(should_prompt(15, REVIEW, stop, false, false, None));
        assert!(!should_prompt(31, REVIEW, stop, false, false, None));
    }

    #[test]
    fn tray_offers_it_until_three() {
        assert!(!tray_offers(20 * 60, REVIEW, false));
        assert!(tray_offers(23 * 60, REVIEW, false));
        assert!(tray_offers(2 * 60 + 59, REVIEW, false));
        assert!(!tray_offers(3 * 60, REVIEW, false));
        assert!(!tray_offers(23 * 60, REVIEW, true));
    }

    #[test]
    fn skipped_review_counts_as_finished() {
        let mut conn = Connection::open_in_memory().unwrap();
        crate::db::configure(&conn).unwrap();
        crate::migrate::run(&mut conn, crate::migrate::MIGRATIONS, 0).unwrap();
        assert!(!finished(&conn, "2026-11-11"));
        upsert(
            &mut conn,
            "day_reviews",
            "2026-11-11",
            "status",
            serde_json::Value::from("skipped"),
        );
        assert!(finished(&conn, "2026-11-11"));
        assert!(!finished(&conn, "2026-11-12"));
    }
}
