//! The tray icon and its native menu: no webview needed (plan §4.1).
//!
//! The menu shows today's top 3 as check items and "Last: … · Undo", and is
//! rebuilt whenever data changes.

use tauri::menu::{CheckMenuItem, IsMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::{MouseButton, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Error, Manager, Wry};

use crate::db::Db;
use crate::hotkey::ActiveHotkey;
use crate::{clock, focus, notify, review, tasks, windows};

const TRAY_ID: &str = "sirna";
const OPEN_ID: &str = "open";
const QUIT_ID: &str = "quit";
const TEST_TOAST_ID: &str = "test-toast";
const TASK_PREFIX: &str = "task:";
const UNDO_PREFIX: &str = "undo:";
const FOCUS_START_ID: &str = "focus-start";
const FOCUS_PAUSE_ID: &str = "focus-pause";
const FOCUS_RESUME_ID: &str = "focus-resume";
const FOCUS_STOP_ID: &str = "focus-stop";
const FOCUS_DISTRACTED_ID: &str = "focus-distracted";
const REVIEW_ID: &str = "review";
const CITY_PREFIX: &str = "city:";
/// The Location submenu (T-092): where prayer times are calculated for.
pub const CITIES: [(&str, &str); 2] = [("addis", "Addis Ababa"), ("adama", "Adama")];
const MENU_TEXT_MAX: usize = 48;

/// The tooltip names the capture hotkey, so a fallback key is never a surprise.
pub fn tooltip(capture_key: Option<&str>) -> String {
    match capture_key {
        Some(key) => format!("Sirna · {key} to capture"),
        None => "Sirna · no capture hotkey (all taken)".to_string(),
    }
}

/// The tooltip while a session or break runs; None when the timer is idle.
pub fn focus_tooltip(status: &focus::Status) -> Option<String> {
    let kind = status.kind?;
    let minutes = (status.remaining_ms + 59_999) / 60_000;
    let label = match kind {
        focus::Kind::Focus if status.paused => "Paused",
        focus::Kind::Focus => "Focus",
        focus::Kind::Break => "Break",
        focus::Kind::LongBreak => "Long break",
    };
    let title = if status.title.is_empty() || status.title == label {
        String::new()
    } else {
        format!(" · {}", short(&status.title))
    };
    Some(format!("{label}{title} · {minutes} min left"))
}

/// The focus block happening now, to start a session on from the tray.
fn current_focus_block(conn: &rusqlite::Connection, now: i64) -> Option<String> {
    conn.query_row(
        "SELECT id FROM day_blocks WHERE deleted_at IS NULL AND kind = 'area'
           AND start_at <= ?1 AND end_at > ?1 ORDER BY start_at LIMIT 1",
        [now],
        |row| row.get(0),
    )
    .ok()
}

/// Menu text kept short; native menus don't wrap.
fn short(text: &str) -> String {
    let mut chars = text.chars();
    let head: String = chars.by_ref().take(MENU_TEXT_MAX).collect();
    if chars.next().is_some() {
        format!("{}…", head.trim_end())
    } else {
        head
    }
}

fn build_menu(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let (top, last, offer_review, stopped, city) = {
        let db = app.state::<Db>();
        let conn = db.write.lock();
        let now = clock::now_ms();
        let top = tasks::today_top(&conn, now).unwrap_or_default();
        // A capture you have changed since can't be undone here (F2): the
        // line stays, greyed, so the menu doesn't offer an Undo that refuses.
        let last = tasks::last_capture(&conn).map(|(raw_id, body)| {
            let blocked = matches!(
                crate::commands::undo_blocked(&conn, raw_id, "undo"),
                Ok(Some(_))
            );
            (raw_id, body, blocked)
        });
        (
            top,
            last,
            review::offered(&conn, now),
            crate::guard::stopped_now(&conn, now),
            crate::prayer::config(&conn).city,
        )
    };

    let status = {
        let focus_state = app.state::<focus::FocusState>();
        let machine = focus_state.machine.lock();
        focus::status(&machine, clock::now_ms())
    };

    let mut items: Vec<Box<dyn IsMenuItem<Wry>>> = Vec::new();
    // Focus first: it is what the tray is used for during the day.
    match (status.kind, focus_tooltip(&status)) {
        (Some(kind), Some(line)) => {
            items.push(Box::new(MenuItem::with_id(
                app,
                "focus-line",
                line,
                false,
                None::<&str>,
            )?));
            if kind == focus::Kind::Focus {
                let (id, text) = if status.paused {
                    (FOCUS_RESUME_ID, "Resume")
                } else {
                    (FOCUS_PAUSE_ID, "Pause")
                };
                items.push(Box::new(MenuItem::with_id(
                    app,
                    id,
                    text,
                    true,
                    None::<&str>,
                )?));
                items.push(Box::new(MenuItem::with_id(
                    app,
                    FOCUS_DISTRACTED_ID,
                    // Counts an interruption; it shows on the Dashboard.
                    "Distracted (+1)",
                    true,
                    None::<&str>,
                )?));
            }
            let stop = if kind == focus::Kind::Focus {
                "Stop"
            } else {
                "End break"
            };
            items.push(Box::new(MenuItem::with_id(
                app,
                FOCUS_STOP_ID,
                stop,
                true,
                None::<&str>,
            )?));
        }
        _ => {
            if stopped {
                items.push(Box::new(MenuItem::with_id(
                    app,
                    "stopped",
                    "Stopped for today",
                    false,
                    None::<&str>,
                )?));
            }
            items.push(Box::new(MenuItem::with_id(
                app,
                FOCUS_START_ID,
                if stopped {
                    "Start anyway"
                } else {
                    "Start focus"
                },
                true,
                None::<&str>,
            )?));
        }
    }
    if offer_review {
        items.push(Box::new(MenuItem::with_id(
            app,
            REVIEW_ID,
            "Night review",
            true,
            None::<&str>,
        )?));
    }
    items.push(Box::new(PredefinedMenuItem::separator(app)?));
    if top.is_empty() {
        items.push(Box::new(MenuItem::with_id(
            app,
            "empty",
            "Nothing due today",
            false,
            None::<&str>,
        )?));
    } else {
        for task in &top {
            items.push(Box::new(CheckMenuItem::with_id(
                app,
                format!("{TASK_PREFIX}{}", task.id),
                short(&task.title),
                true,
                task.done,
                None::<&str>,
            )?));
        }
    }
    items.push(Box::new(PredefinedMenuItem::separator(app)?));
    items.push(Box::new(MenuItem::with_id(
        app,
        OPEN_ID,
        "Open Sirna",
        true,
        None::<&str>,
    )?));
    if let Some((raw_id, body, blocked)) = last {
        let text = if blocked {
            format!("Last: {} · changed since", short(&body))
        } else {
            format!("Last: {} · Undo", short(&body))
        };
        items.push(Box::new(MenuItem::with_id(
            app,
            format!("{UNDO_PREFIX}{raw_id}"),
            text,
            !blocked,
            None::<&str>,
        )?));
    }
    let places = CITIES
        .iter()
        .map(|(id, name)| {
            CheckMenuItem::with_id(
                app,
                format!("{CITY_PREFIX}{id}"),
                *name,
                true,
                city == *id,
                None::<&str>,
            )
        })
        .collect::<tauri::Result<Vec<_>>>()?;
    let place_refs: Vec<&dyn IsMenuItem<Wry>> = places
        .iter()
        .map(|item| item as &dyn IsMenuItem<Wry>)
        .collect();
    items.push(Box::new(Submenu::with_items(
        app,
        "Location",
        true,
        &place_refs,
    )?));
    items.push(Box::new(MenuItem::with_id(
        app,
        TEST_TOAST_ID,
        "Test notification",
        true,
        None::<&str>,
    )?));
    items.push(Box::new(PredefinedMenuItem::separator(app)?));
    items.push(Box::new(MenuItem::with_id(
        app,
        QUIT_ID,
        "Quit",
        true,
        None::<&str>,
    )?));

    let refs: Vec<&dyn IsMenuItem<Wry>> = items.iter().map(|item| item.as_ref()).collect();
    Menu::with_items(app, &refs)
}

/// Puts the focus countdown in the tooltip, or the capture key when idle.
pub fn refresh_tooltip(app: &AppHandle) {
    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        return;
    };
    let status = {
        let focus_state = app.state::<focus::FocusState>();
        let machine = focus_state.machine.lock();
        focus::status(&machine, clock::now_ms())
    };
    let text = focus_tooltip(&status).unwrap_or_else(|| {
        let key = app
            .state::<ActiveHotkey>()
            .0
            .lock()
            .as_ref()
            .map(|(_, label)| label.clone());
        tooltip(key.as_deref())
    });
    if let Err(error) = tray.set_tooltip(Some(text)) {
        log::warn!("could not update the tray tooltip: {error}");
    }
}

/// Rebuilds the menu from the database (after any data change).
pub fn rebuild(app: &AppHandle) {
    refresh_tooltip(app);
    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        return;
    };
    match build_menu(app) {
        Ok(menu) => {
            if let Err(error) = tray.set_menu(Some(menu)) {
                log::warn!("could not update the tray menu: {error}");
            }
        }
        Err(error) => log::warn!("could not build the tray menu: {error}"),
    }
}

fn undo_capture(app: &AppHandle, raw_id: i64) -> Result<usize, String> {
    let db = app.state::<Db>();
    let mut conn = db.write.lock();
    let txn = conn.transaction().map_err(|error| error.to_string())?;
    // Refuses, like Ctrl+Z, when you have changed the capture's records since.
    let undone = crate::commands::undo_capture_in(&txn, raw_id, clock::now_ms())?;
    txn.commit().map_err(|error| error.to_string())?;
    Ok(undone)
}

/// Writes prayer.city from the Location submenu (logged, so it shows in history).
fn set_city(app: &AppHandle, city: &str) -> Result<(), String> {
    if !CITIES.iter().any(|(id, _)| *id == city) {
        return Err(format!("unknown city {city}"));
    }
    let db = app.state::<Db>();
    let mut conn = db.write.lock();
    let txn = conn.transaction().map_err(|error| error.to_string())?;
    let mut values = serde_json::Map::new();
    values.insert(
        "value_json".into(),
        serde_json::Value::from(serde_json::Value::from(city).to_string()),
    );
    let op = crate::tx::Op::Upsert {
        table: "core_settings".into(),
        id: "prayer.city".into(),
        values,
    };
    crate::tx::apply_ops(&txn, "user", Some("tray"), &[op], clock::now_ms())
        .map_err(|error| error.to_string())?;
    txn.commit().map_err(|error| error.to_string())
}

fn on_menu(app: &AppHandle, id: &str) {
    if let Some(task_id) = id.strip_prefix(TASK_PREFIX) {
        let result = {
            let db = app.state::<Db>();
            let mut conn = db.write.lock();
            tasks::toggle_done(&mut conn, task_id, clock::now_ms())
        };
        if let Err(error) = result {
            log::warn!("could not tick the task: {error}");
        }
        changed(app, &["task_items"]);
        return;
    }
    if let Some(city) = id.strip_prefix(CITY_PREFIX) {
        if let Err(error) = set_city(app, city) {
            log::warn!("could not set the location: {error}");
        }
        changed(app, &["core_settings"]);
        return;
    }
    if let Some(raw_id) = id
        .strip_prefix(UNDO_PREFIX)
        .and_then(|raw| raw.parse::<i64>().ok())
    {
        if let Err(error) = undo_capture(app, raw_id) {
            log::warn!("could not undo the capture: {error}");
        }
        changed(app, &crate::commands::CAPTURE_TABLES);
        return;
    }
    match id {
        FOCUS_START_ID => {
            let block = {
                let db = app.state::<Db>();
                let conn = db.write.lock();
                current_focus_block(&conn, clock::now_ms())
            };
            // The sheet asks again past the hard stop or during a long break.
            windows::spawn_open_setup(app.clone(), block);
        }
        FOCUS_PAUSE_ID => {
            focus::dispatch(app, focus::Event::Pause);
        }
        FOCUS_RESUME_ID => {
            focus::dispatch(app, focus::Event::Resume);
        }
        FOCUS_STOP_ID => {
            focus::dispatch(app, focus::Event::Stop);
        }
        FOCUS_DISTRACTED_ID => {
            focus::dispatch(app, focus::Event::Distracted);
        }
        OPEN_ID => windows::spawn_open_main(app.clone()),
        REVIEW_ID => review::open(app),
        TEST_TOAST_ID => notify::show_check(app),
        QUIT_ID => {
            // Fold the WAL into sirna.db first, so a quit leaves one file
            // (what the restore steps in docs/smoke.md expect).
            if let Err(error) = app
                .state::<Db>()
                .write
                .lock()
                .execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
            {
                log::warn!("could not checkpoint before quitting: {error}");
            }
            app.exit(0)
        }
        _ => {}
    }
}

/// Tells open windows what changed; the data-changed listener rebuilds the menu.
fn changed(app: &AppHandle, tables: &[&str]) {
    if let Err(error) = app.emit("data-changed", tables) {
        log::warn!("could not emit data-changed: {error}");
    }
}

/// The menu opens on right-click only. A menu on left-click starts its own
/// modal loop on the first click, which swallows the second click of a
/// double-click, so the window would never open (Windows convention: double
/// click opens, right-click shows the menu, a single left-click does nothing).
const MENU_ON_LEFT_CLICK: bool = false;

/// A left double-click on the tray icon opens the main window.
fn opens_main(event: &TrayIconEvent) -> bool {
    matches!(
        event,
        TrayIconEvent::DoubleClick {
            button: MouseButton::Left,
            ..
        }
    )
}

pub fn create(app: &AppHandle, capture_key: Option<&str>) -> tauri::Result<()> {
    let icon = app
        .default_window_icon()
        .cloned()
        .ok_or_else(|| Error::AssetNotFound("default window icon".into()))?;
    let menu = build_menu(app)?;

    TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        .tooltip(tooltip(capture_key))
        .menu(&menu)
        .show_menu_on_left_click(MENU_ON_LEFT_CLICK)
        .on_menu_event(|app, event| on_menu(app, event.id().as_ref()))
        .on_tray_icon_event(|tray, event| {
            if opens_main(&event) {
                windows::spawn_open_main(tray.app_handle().clone());
            }
        })
        .build(app)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{MENU_ON_LEFT_CLICK, focus_tooltip, opens_main, short, tooltip};
    use crate::focus::{Kind, Status};
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconEvent};
    use tauri::{PhysicalPosition, Rect};

    #[test]
    fn a_left_double_click_opens_the_main_window() {
        let double = |button| TrayIconEvent::DoubleClick {
            id: "sirna".into(),
            position: PhysicalPosition::new(0.0, 0.0),
            rect: Rect::default(),
            button,
        };
        assert!(opens_main(&double(MouseButton::Left)));
        assert!(!opens_main(&double(MouseButton::Right)));
        let single = TrayIconEvent::Click {
            id: "sirna".into(),
            position: PhysicalPosition::new(0.0, 0.0),
            rect: Rect::default(),
            button: MouseButton::Left,
            button_state: MouseButtonState::Up,
        };
        assert!(!opens_main(&single));
    }

    #[test]
    fn the_menu_waits_for_a_right_click_so_double_click_reaches_the_icon() {
        // A left-click menu eats the second click of the double-click.
        const { assert!(!MENU_ON_LEFT_CLICK) };
        let right_up = TrayIconEvent::Click {
            id: "sirna".into(),
            position: PhysicalPosition::new(0.0, 0.0),
            rect: Rect::default(),
            button: MouseButton::Right,
            button_state: MouseButtonState::Up,
        };
        assert!(!opens_main(&right_up));
    }

    fn status(kind: Option<Kind>, remaining_ms: i64, paused: bool) -> Status {
        Status {
            kind,
            title: "Coding skills".into(),
            remaining_ms,
            planned_min: 25,
            paused,
            in_row: 0,
            block_id: None,
            distractions: 0,
            lanes: Vec::new(),
        }
    }

    #[test]
    fn focus_tooltip_counts_down_in_whole_minutes() {
        assert_eq!(
            focus_tooltip(&status(Some(Kind::Focus), 18 * 60_000 + 1, false)).as_deref(),
            Some("Focus · Coding skills · 19 min left")
        );
        assert_eq!(
            focus_tooltip(&status(Some(Kind::Break), 60_000, false)).as_deref(),
            Some("Break · Coding skills · 1 min left")
        );
        assert_eq!(
            focus_tooltip(&status(Some(Kind::Focus), 600_000, true)).as_deref(),
            Some("Paused · Coding skills · 10 min left")
        );
        assert_eq!(focus_tooltip(&status(None, 0, false)), None);
    }

    #[test]
    fn tooltip_names_the_capture_key() {
        assert_eq!(tooltip(Some("Ctrl+Alt+J")), "Sirna · Ctrl+Alt+J to capture");
    }

    #[test]
    fn tooltip_says_when_no_key_is_free() {
        assert!(tooltip(None).contains("no capture hotkey"));
    }

    #[test]
    fn long_menu_text_is_cut_with_an_ellipsis() {
        assert_eq!(short("short"), "short");
        let long = "a".repeat(60);
        assert_eq!(short(&long).chars().count(), 49);
        assert!(short(&long).ends_with('…'));
    }
}
