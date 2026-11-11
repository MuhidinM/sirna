//! The focus timer (plan §3.6, §4.2): runs in Rust so it works with no window
//! open, and saves every change of state so sleep or a crash never loses a
//! session.
//!
//! `Machine` is pure: events in, effects out, time passed in. The runtime
//! below applies the effects (database rows, toasts) and wakes a thread at
//! the next deadline.

use std::sync::Arc;
use std::time::Duration;

use parking_lot::{Condvar, Mutex};
use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::clock;
use crate::db::Db;
use crate::notify::{self, Button};

const MINUTE_MS: i64 = 60_000;
/// Sessions less than this apart count as "in a row".
pub const ROW_GAP_MS: i64 = 15 * MINUTE_MS;
/// Every 4th session in a row earns a long break.
pub const LONG_BREAK_EVERY: u32 = 4;
pub const LONG_BREAK_MIN: i64 = 20;
/// Starting focus earlier than this into a long break needs a second tap.
pub const LONG_BREAK_LOCK_MS: i64 = 10 * MINUTE_MS;
/// A session found this long past its end (the laptop slept) closes as interrupted.
pub const SLEEP_GRACE_MS: i64 = 30 * MINUTE_MS;
pub const EXTEND_MIN: i64 = 5;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    Focus,
    Break,
    LongBreak,
}

impl Kind {
    pub fn as_str(self) -> &'static str {
        match self {
            Kind::Focus => "focus",
            Kind::Break => "break",
            Kind::LongBreak => "long_break",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Session {
    pub id: String,
    pub kind: Kind,
    pub started_at: i64,
    pub planned_min: i64,
    pub paused_at: Option<i64>,
    pub paused_ms: i64,
    pub block_id: Option<String>,
    pub area_id: Option<String>,
    pub task_id: Option<String>,
    pub title: String,
    pub extended: bool,
    /// Break length to use after this focus session.
    pub break_min: i64,
}

impl Session {
    pub fn ends_at(&self) -> i64 {
        self.started_at + self.planned_min * MINUTE_MS + self.paused_ms
    }

    pub fn remaining_ms(&self, now: i64) -> i64 {
        let reference = self.paused_at.unwrap_or(now);
        self.ends_at() - reference
    }
}

/// What a focus session is about, from its block and area.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Context {
    pub block_id: Option<String>,
    pub area_id: Option<String>,
    pub task_id: Option<String>,
    pub title: String,
    pub focus_min: i64,
    pub break_min: i64,
}

#[derive(Debug, PartialEq)]
pub enum Event {
    Start {
        context: Context,
        force: bool,
        id: String,
    },
    Tick,
    Pause,
    Resume,
    Stop,
    Distracted,
    /// "+5 min, once": cut a short break and focus 5 more minutes.
    Extend {
        id: String,
    },
}

#[derive(Debug, PartialEq)]
pub enum Outcome {
    Completed,
    Stopped,
    Interrupted,
}

impl Outcome {
    pub fn as_str(&self) -> &'static str {
        match self {
            Outcome::Completed => "completed",
            Outcome::Stopped => "stopped",
            Outcome::Interrupted => "interrupted",
        }
    }
}

#[derive(Debug, PartialEq)]
pub enum Effect {
    /// Insert or update this session's row.
    Save(Session),
    Close {
        id: String,
        at: i64,
        outcome: Outcome,
    },
    AddDistraction {
        id: String,
    },
    BreakStarted {
        minutes: i64,
        long: bool,
        can_extend: bool,
    },
    BreakOver,
    /// Starting now would cut a long break short; ask again with force.
    NeedConfirm,
    AlreadyFocusing,
    /// Past the hard stop: starting needs a second tap (T-027).
    PastHardStop,
}

#[derive(Debug, Default)]
pub struct Machine {
    pub current: Option<Session>,
    /// Focus sessions completed in the current row.
    pub in_row: u32,
    pub last_focus_end: Option<i64>,
}

impl Machine {
    pub fn handle(&mut self, event: Event, now: i64) -> Vec<Effect> {
        match event {
            Event::Start { context, force, id } => self.start(context, force, id, now),
            Event::Tick => self.tick(now),
            Event::Pause => self.pause(now),
            Event::Resume => self.resume(now),
            Event::Stop => self.stop(now),
            Event::Distracted => match &self.current {
                Some(session) if session.kind == Kind::Focus => {
                    vec![Effect::AddDistraction {
                        id: session.id.clone(),
                    }]
                }
                _ => vec![],
            },
            Event::Extend { id } => self.extend(id, now),
        }
    }

    fn start(&mut self, context: Context, force: bool, id: String, now: i64) -> Vec<Effect> {
        let mut effects = Vec::new();
        if let Some(current) = &self.current {
            match current.kind {
                Kind::Focus => return vec![Effect::AlreadyFocusing],
                Kind::LongBreak if !force && now - current.started_at < LONG_BREAK_LOCK_MS => {
                    return vec![Effect::NeedConfirm];
                }
                Kind::Break | Kind::LongBreak => {
                    effects.push(Effect::Close {
                        id: current.id.clone(),
                        at: now,
                        outcome: Outcome::Stopped,
                    });
                }
            }
        }
        if self.last_focus_end.is_none_or(|end| now - end > ROW_GAP_MS) {
            self.in_row = 0;
        }
        let session = Session {
            id,
            kind: Kind::Focus,
            started_at: now,
            planned_min: context.focus_min.max(1),
            paused_at: None,
            paused_ms: 0,
            block_id: context.block_id,
            area_id: context.area_id,
            task_id: context.task_id,
            title: context.title,
            extended: false,
            break_min: context.break_min.max(0),
        };
        effects.push(Effect::Save(session.clone()));
        self.current = Some(session);
        effects
    }

    fn tick(&mut self, now: i64) -> Vec<Effect> {
        let Some(session) = self.current.clone() else {
            return vec![];
        };
        if session.paused_at.is_some() || session.remaining_ms(now) > 0 {
            return vec![];
        }
        let ended = session.ends_at();
        match session.kind {
            Kind::Focus => {
                if now - ended > SLEEP_GRACE_MS {
                    // The laptop slept through it: close it, no break, row over.
                    self.current = None;
                    self.in_row = 0;
                    return vec![Effect::Close {
                        id: session.id,
                        at: ended,
                        outcome: Outcome::Interrupted,
                    }];
                }
                self.in_row += 1;
                self.last_focus_end = Some(ended);
                let long = self.in_row.is_multiple_of(LONG_BREAK_EVERY);
                let minutes = if long {
                    LONG_BREAK_MIN
                } else {
                    session.break_min
                };
                let mut effects = vec![Effect::Close {
                    id: session.id.clone(),
                    at: ended,
                    outcome: Outcome::Completed,
                }];
                if minutes == 0 {
                    self.current = None;
                    effects.push(Effect::BreakOver);
                    return effects;
                }
                let rest = Session {
                    id: format!("{}-break", session.id),
                    kind: if long { Kind::LongBreak } else { Kind::Break },
                    started_at: ended,
                    planned_min: minutes,
                    paused_at: None,
                    paused_ms: 0,
                    block_id: session.block_id.clone(),
                    area_id: session.area_id.clone(),
                    task_id: session.task_id.clone(),
                    title: session.title.clone(),
                    extended: session.extended,
                    break_min: session.break_min,
                };
                effects.push(Effect::Save(rest.clone()));
                effects.push(Effect::BreakStarted {
                    minutes,
                    long,
                    can_extend: !long && !session.extended,
                });
                self.current = Some(rest);
                effects
            }
            Kind::Break | Kind::LongBreak => {
                self.current = None;
                vec![
                    Effect::Close {
                        id: session.id,
                        at: ended,
                        outcome: Outcome::Completed,
                    },
                    Effect::BreakOver,
                ]
            }
        }
    }

    fn pause(&mut self, now: i64) -> Vec<Effect> {
        match &mut self.current {
            Some(session) if session.kind == Kind::Focus && session.paused_at.is_none() => {
                session.paused_at = Some(now);
                vec![Effect::Save(session.clone())]
            }
            _ => vec![],
        }
    }

    fn resume(&mut self, now: i64) -> Vec<Effect> {
        match &mut self.current {
            Some(session) if session.paused_at.is_some() => {
                let paused_at = session.paused_at.take().unwrap_or(now);
                session.paused_ms += now - paused_at;
                vec![Effect::Save(session.clone())]
            }
            _ => vec![],
        }
    }

    fn stop(&mut self, now: i64) -> Vec<Effect> {
        match self.current.take() {
            Some(session) => {
                if session.kind == Kind::Focus {
                    self.last_focus_end = Some(now);
                }
                vec![Effect::Close {
                    id: session.id,
                    at: now,
                    outcome: Outcome::Stopped,
                }]
            }
            None => vec![],
        }
    }

    fn extend(&mut self, id: String, now: i64) -> Vec<Effect> {
        let Some(current) = self.current.clone() else {
            return vec![];
        };
        if current.kind != Kind::Break || current.extended {
            return vec![];
        }
        let focus = Session {
            id,
            kind: Kind::Focus,
            started_at: now,
            planned_min: EXTEND_MIN,
            paused_at: None,
            paused_ms: 0,
            block_id: current.block_id.clone(),
            area_id: current.area_id.clone(),
            task_id: current.task_id.clone(),
            title: current.title.clone(),
            extended: true,
            break_min: current.break_min,
        };
        // The extra minutes don't count as another session in the row.
        self.in_row = self.in_row.saturating_sub(1);
        self.current = Some(focus.clone());
        vec![
            Effect::Close {
                id: current.id,
                at: now,
                outcome: Outcome::Stopped,
            },
            Effect::Save(focus),
        ]
    }
}

// ---------------------------------------------------------------------------
// Runtime: database, toasts, and the thread that wakes at the next deadline.
// ---------------------------------------------------------------------------

/// What the UI and tray show.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Status {
    pub kind: Option<Kind>,
    pub title: String,
    pub remaining_ms: i64,
    pub planned_min: i64,
    pub paused: bool,
    pub in_row: u32,
    pub block_id: Option<String>,
}

pub fn status(machine: &Machine, now: i64) -> Status {
    match &machine.current {
        Some(session) => Status {
            kind: Some(session.kind),
            title: session.title.clone(),
            remaining_ms: session.remaining_ms(now).max(0),
            planned_min: session.planned_min,
            paused: session.paused_at.is_some(),
            in_row: machine.in_row,
            block_id: session.block_id.clone(),
        },
        None => Status {
            kind: None,
            title: String::new(),
            remaining_ms: 0,
            planned_min: 0,
            paused: false,
            in_row: machine.in_row,
            block_id: None,
        },
    }
}

#[derive(Default)]
pub struct Focus {
    pub machine: Mutex<Machine>,
    wake: Condvar,
}

pub type FocusState = Arc<Focus>;

/// A new session id: time + a counter (sortable, unique within the process).
pub fn new_id(now: i64) -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    format!(
        "fs-{now:013}-{:04}",
        COUNTER.fetch_add(1, Ordering::Relaxed) % 10_000
    )
}

fn save(conn: &Connection, session: &Session) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO focus_sessions
           (id, block_id, area_id, task_id, kind, started_at, planned_min, paused_at, paused_ms, extended)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
         ON CONFLICT (id) DO UPDATE SET planned_min = ?7, paused_at = ?8, paused_ms = ?9, extended = ?10",
        params![
            session.id,
            session.block_id,
            session.area_id,
            session.task_id,
            session.kind.as_str(),
            session.started_at,
            session.planned_min,
            session.paused_at,
            session.paused_ms,
            i64::from(session.extended),
        ],
    )?;
    Ok(())
}

fn apply_db(conn: &Connection, effects: &[Effect]) -> rusqlite::Result<()> {
    for effect in effects {
        match effect {
            Effect::Save(session) => save(conn, session)?,
            Effect::Close { id, at, outcome } => {
                conn.execute(
                    "UPDATE focus_sessions SET ended_at = ?2, outcome = ?3, paused_at = NULL WHERE id = ?1",
                    params![id, at, outcome.as_str()],
                )?;
            }
            Effect::AddDistraction { id } => {
                conn.execute(
                    "UPDATE focus_sessions SET distractions = distractions + 1 WHERE id = ?1",
                    [id],
                )?;
            }
            _ => {}
        }
    }
    Ok(())
}

/// The context for a session: the block's area, task and title, and the
/// area's session and break lengths (25/5 when there is no block).
pub fn context_for(conn: &Connection, block_id: Option<&str>) -> rusqlite::Result<Context> {
    let Some(block_id) = block_id else {
        return Ok(Context {
            title: "Focus".into(),
            focus_min: 25,
            break_min: 5,
            ..Context::default()
        });
    };
    let row = conn
        .query_row(
            "SELECT b.area_id, b.task_id, b.title, COALESCE(a.focus_min, 25), COALESCE(a.break_min, 5)
             FROM day_blocks AS b LEFT JOIN area_items AS a ON a.id = b.area_id
             WHERE b.id = ?1",
            [block_id],
            |row| {
                Ok(Context {
                    block_id: Some(block_id.to_string()),
                    area_id: row.get(0)?,
                    task_id: row.get(1)?,
                    title: row.get(2)?,
                    focus_min: row.get(3)?,
                    break_min: row.get(4)?,
                })
            },
        )
        .optional()?;
    Ok(row.unwrap_or(Context {
        title: "Focus".into(),
        focus_min: 25,
        break_min: 5,
        ..Context::default()
    }))
}

/// Loads the open session (if any) and the current row after a restart.
pub fn restore(conn: &Connection, now: i64) -> rusqlite::Result<Machine> {
    let open = conn
        .query_row(
            "SELECT s.id, s.kind, s.started_at, s.planned_min, s.paused_at, s.paused_ms, s.block_id,
                    s.area_id, s.task_id, s.extended, COALESCE(b.title, 'Focus'), COALESCE(a.break_min, 5)
             FROM focus_sessions AS s
             LEFT JOIN day_blocks AS b ON b.id = s.block_id
             LEFT JOIN area_items AS a ON a.id = s.area_id
             WHERE s.ended_at IS NULL ORDER BY s.started_at DESC LIMIT 1",
            [],
            |row| {
                let kind = match row.get::<_, String>(1)?.as_str() {
                    "break" => Kind::Break,
                    "long_break" => Kind::LongBreak,
                    _ => Kind::Focus,
                };
                Ok(Session {
                    id: row.get(0)?,
                    kind,
                    started_at: row.get(2)?,
                    planned_min: row.get(3)?,
                    paused_at: row.get(4)?,
                    paused_ms: row.get(5)?,
                    block_id: row.get(6)?,
                    area_id: row.get(7)?,
                    task_id: row.get(8)?,
                    extended: row.get::<_, i64>(9)? == 1,
                    title: row.get(10)?,
                    break_min: row.get(11)?,
                })
            },
        )
        .optional()?;
    // The row: completed focus sessions, each starting within the gap of the previous end.
    let mut statement = conn.prepare(
        "SELECT started_at, ended_at FROM focus_sessions
         WHERE kind = 'focus' AND outcome = 'completed' AND ended_at > ?1 ORDER BY started_at DESC LIMIT 8",
    )?;
    let recent: Vec<(i64, i64)> = statement
        .query_map([now - 6 * 60 * MINUTE_MS], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })?
        .collect::<Result<_, _>>()?;
    let mut in_row = 0;
    let mut previous_start = now;
    for (started, ended) in &recent {
        if previous_start - ended > ROW_GAP_MS {
            break;
        }
        in_row += 1;
        previous_start = *started;
    }
    Ok(Machine {
        current: open,
        in_row,
        last_focus_end: recent.first().map(|(_, ended)| *ended),
    })
}

/// Runs an event through the machine, saves, shows toasts, and wakes the timer thread.
pub fn dispatch(app: &AppHandle, event: Event) -> Vec<Effect> {
    let now = clock::now_ms();
    let focus = app.state::<FocusState>();
    let effects = {
        let mut machine = focus.machine.lock();
        let effects = machine.handle(event, now);
        let db = app.state::<Db>();
        let conn = db.write.lock();
        if let Err(error) = apply_db(&conn, &effects) {
            log::error!("could not save the focus session: {error}");
        }
        effects
    };
    focus.wake.notify_all();
    for effect in &effects {
        show_toast(app, effect);
    }
    let changed = effects.iter().any(|effect| {
        matches!(
            effect,
            Effect::Save(_) | Effect::Close { .. } | Effect::AddDistraction { .. }
        )
    });
    let completed = effects.iter().any(|effect| {
        matches!(
            effect,
            Effect::Close {
                outcome: Outcome::Completed,
                ..
            }
        )
    });
    if completed {
        crate::guard::after_complete(app);
    }
    if changed {
        let _ = app.emit("focus-changed", ());
        let _ = app.emit("data-changed", ["focus_sessions"]);
    }
    effects
}

fn show_toast(app: &AppHandle, effect: &Effect) {
    let result = match effect {
        Effect::BreakStarted {
            minutes,
            long,
            can_extend,
        } => {
            let handle = app.clone();
            let title = if *long {
                format!("Long break · {minutes} min")
            } else {
                format!("Break · {minutes} min")
            };
            let body = if *long {
                "Four sessions done. Walk around, drink water, rest your eyes."
            } else {
                "Stand up, drink water, look away from the screen."
            };
            let extend = [Button {
                label: "+5 min work, once",
                action: "extend",
            }];
            let buttons: &[Button] = if *can_extend { &extend } else { &[] };
            notify::show(app, &title, body, buttons, move |action| {
                if action.as_deref() == Some("extend") {
                    let id = new_id(clock::now_ms());
                    dispatch(&handle, Event::Extend { id });
                }
            })
        }
        Effect::BreakOver => {
            let handle = app.clone();
            notify::show(
                app,
                "Break over",
                "Start the next session?",
                &[
                    Button {
                        label: "Start",
                        action: "start",
                    },
                    Button {
                        label: "Done for now",
                        action: "done",
                    },
                ],
                move |action| {
                    if action.as_deref() == Some("start") {
                        start_with_block(&handle, last_block(&handle), false);
                    }
                },
            )
        }
        _ => Ok(()),
    };
    if let Err(error) = result {
        log::warn!("could not show a focus toast: {error}");
    }
}

fn last_block(app: &AppHandle) -> Option<String> {
    let db = app.state::<Db>();
    let conn = db.write.lock();
    conn.query_row(
        "SELECT block_id FROM focus_sessions WHERE kind = 'focus' ORDER BY started_at DESC LIMIT 1",
        [],
        |row| row.get::<_, Option<String>>(0),
    )
    .ok()
    .flatten()
}

/// Starts a session for a block (or a plain 25-minute one).
pub fn start_with_block(app: &AppHandle, block_id: Option<String>, force: bool) -> Vec<Effect> {
    let context = {
        let db = app.state::<Db>();
        let conn = db.write.lock();
        context_for(&conn, block_id.as_deref())
    };
    match context {
        Ok(context) => {
            let now = clock::now_ms();
            if !force && crate::guard::stopped_now(&app.state::<Db>().write.lock(), now) {
                return vec![Effect::PastHardStop];
            }
            let id = new_id(now);
            let effects = dispatch(
                app,
                Event::Start {
                    context,
                    force,
                    id: id.clone(),
                },
            );
            if effects
                .iter()
                .any(|e| matches!(e, Effect::Save(s) if s.id == id))
            {
                crate::guard::after_start(app, &id);
            }
            effects
        }
        Err(error) => {
            log::error!("could not read the block for focus: {error}");
            vec![]
        }
    }
}

/// Restores the timer after a restart. Call `run` once the state is managed.
pub fn restore_state(app: &AppHandle) -> FocusState {
    let machine = {
        let db = app.state::<Db>();
        let conn = db.write.lock();
        restore(&conn, clock::now_ms()).unwrap_or_else(|error| {
            log::error!("could not restore the focus timer: {error}");
            Machine::default()
        })
    };
    Arc::new(Focus {
        machine: Mutex::new(machine),
        wake: Condvar::new(),
    })
}

/// Starts the thread that ticks at each deadline (and each minute, for the countdown).
pub fn run(app: &AppHandle, state: FocusState) {
    let thread_state = state;
    let handle = app.clone();
    let spawned = std::thread::Builder::new()
        .name("sirna-focus".into())
        .spawn(move || {
            loop {
                // Sleep until the session's end (or a minute, to refresh the countdown), or until poked.
                {
                    let mut machine = thread_state.machine.lock();
                    let wait_ms = match &machine.current {
                        Some(session) if session.paused_at.is_none() => {
                            session.remaining_ms(clock::now_ms()).clamp(200, MINUTE_MS)
                        }
                        _ => MINUTE_MS,
                    };
                    thread_state.wake.wait_for(
                        &mut machine,
                        Duration::from_millis(u64::try_from(wait_ms).unwrap_or(60_000)),
                    );
                }
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    dispatch(&handle, Event::Tick);
                    let _ = handle.emit("focus-tick", ());
                }));
                if result.is_err() {
                    log::error!("the focus tick panicked; it will run again");
                }
            }
        });
    if let Err(error) = spawned {
        log::error!("could not start the focus timer: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{db, migrate};

    const T0: i64 = 1_794_387_600_000; // 2026-11-11 12:00 Addis

    fn context() -> Context {
        Context {
            block_id: Some("b1".into()),
            area_id: Some("coding".into()),
            task_id: None,
            title: "Coding".into(),
            focus_min: 25,
            break_min: 5,
        }
    }

    fn start(machine: &mut Machine, now: i64, n: u32) -> Vec<Effect> {
        machine.handle(
            Event::Start {
                context: context(),
                force: false,
                id: format!("s{n}"),
            },
            now,
        )
    }

    fn minutes(n: i64) -> i64 {
        n * MINUTE_MS
    }

    #[test]
    fn a_session_ends_with_a_short_break() {
        let mut m = Machine::default();
        start(&mut m, T0, 1);
        assert!(m.handle(Event::Tick, T0 + minutes(24)).is_empty());
        let effects = m.handle(Event::Tick, T0 + minutes(25));
        assert!(effects.contains(&Effect::BreakStarted {
            minutes: 5,
            long: false,
            can_extend: true
        }));
        assert_eq!(m.current.as_ref().map(|s| s.kind), Some(Kind::Break));
        let effects = m.handle(Event::Tick, T0 + minutes(30));
        assert!(effects.contains(&Effect::BreakOver));
        assert!(m.current.is_none());
    }

    #[test]
    fn the_fourth_session_in_a_row_gets_a_long_break() {
        let mut m = Machine::default();
        let mut now = T0;
        for n in 1..=4 {
            start(&mut m, now, n);
            now += minutes(25);
            let effects = m.handle(Event::Tick, now);
            let long = n == 4;
            assert!(
                effects
                    .iter()
                    .any(|e| matches!(e, Effect::BreakStarted { long: l, .. } if *l == long)),
                "session {n}"
            );
            now += minutes(if long { 20 } else { 5 });
            m.handle(Event::Tick, now);
        }
    }

    #[test]
    fn a_gap_of_more_than_15_minutes_starts_a_new_row() {
        let mut m = Machine::default();
        let mut now = T0;
        for n in 1..=3 {
            start(&mut m, now, n);
            now += minutes(25);
            m.handle(Event::Tick, now);
            now += minutes(5);
            m.handle(Event::Tick, now);
        }
        now += minutes(60);
        start(&mut m, now, 4);
        now += minutes(25);
        let effects = m.handle(Event::Tick, now);
        assert!(effects.contains(&Effect::BreakStarted {
            minutes: 5,
            long: false,
            can_extend: true
        }));
    }

    #[test]
    fn starting_early_in_a_long_break_needs_a_second_tap() {
        let mut m = Machine {
            in_row: 3,
            last_focus_end: Some(T0),
            ..Machine::default()
        };
        start(&mut m, T0, 1);
        m.handle(Event::Tick, T0 + minutes(25));
        assert_eq!(m.current.as_ref().map(|s| s.kind), Some(Kind::LongBreak));
        assert_eq!(
            start(&mut m, T0 + minutes(30), 2),
            vec![Effect::NeedConfirm]
        );
        let forced = m.handle(
            Event::Start {
                context: context(),
                force: true,
                id: "s3".into(),
            },
            T0 + minutes(30),
        );
        assert!(
            forced
                .iter()
                .any(|e| matches!(e, Effect::Save(s) if s.kind == Kind::Focus))
        );
        // After 10 minutes of the long break, no confirm is needed.
        let mut m2 = Machine {
            in_row: 3,
            last_focus_end: Some(T0),
            ..Machine::default()
        };
        start(&mut m2, T0, 1);
        m2.handle(Event::Tick, T0 + minutes(25));
        assert!(
            start(&mut m2, T0 + minutes(36), 2)
                .iter()
                .any(|e| matches!(e, Effect::Save(_)))
        );
    }

    #[test]
    fn a_session_found_long_after_its_end_closes_as_interrupted() {
        let mut m = Machine::default();
        start(&mut m, T0, 1);
        let effects = m.handle(Event::Tick, T0 + minutes(25 + 31));
        assert_eq!(
            effects,
            vec![Effect::Close {
                id: "s1".into(),
                at: T0 + minutes(25),
                outcome: Outcome::Interrupted
            }]
        );
        assert!(m.current.is_none());
        assert_eq!(m.in_row, 0);
    }

    #[test]
    fn pausing_moves_the_end() {
        let mut m = Machine::default();
        start(&mut m, T0, 1);
        m.handle(Event::Pause, T0 + minutes(10));
        assert!(
            m.handle(Event::Tick, T0 + minutes(40)).is_empty(),
            "no tick while paused"
        );
        m.handle(Event::Resume, T0 + minutes(15));
        assert_eq!(
            m.current.as_ref().map(|s| s.ends_at()),
            Some(T0 + minutes(30))
        );
    }

    #[test]
    fn stop_and_distracted_and_double_start() {
        let mut m = Machine::default();
        start(&mut m, T0, 1);
        assert_eq!(start(&mut m, T0 + 1, 2), vec![Effect::AlreadyFocusing]);
        assert_eq!(
            m.handle(Event::Distracted, T0 + 2),
            vec![Effect::AddDistraction { id: "s1".into() }]
        );
        assert_eq!(
            m.handle(Event::Stop, T0 + 3),
            vec![Effect::Close {
                id: "s1".into(),
                at: T0 + 3,
                outcome: Outcome::Stopped
            }]
        );
        assert!(m.current.is_none());
    }

    #[test]
    fn extend_once_from_a_short_break() {
        let mut m = Machine::default();
        start(&mut m, T0, 1);
        m.handle(Event::Tick, T0 + minutes(25));
        let effects = m.handle(Event::Extend { id: "x1".into() }, T0 + minutes(26));
        assert!(
            effects
                .iter()
                .any(|e| matches!(e, Effect::Save(s) if s.planned_min == EXTEND_MIN && s.extended))
        );
        // The extension ends in a break that can't be extended again.
        let effects = m.handle(Event::Tick, T0 + minutes(31));
        assert!(effects.contains(&Effect::BreakStarted {
            minutes: 5,
            long: false,
            can_extend: false
        }));
        assert!(
            m.handle(Event::Extend { id: "x2".into() }, T0 + minutes(32))
                .is_empty()
        );
    }

    fn conn() -> Connection {
        let mut conn = Connection::open_in_memory().expect("open");
        db::configure(&conn).expect("pragmas");
        migrate::run(&mut conn, migrate::MIGRATIONS, 0).expect("migrate");
        conn
    }

    #[test]
    fn sessions_are_saved_and_restored_after_a_restart() {
        let conn = conn();
        let mut m = Machine::default();
        let effects = m.handle(
            Event::Start {
                context: Context {
                    title: "Focus".into(),
                    focus_min: 25,
                    break_min: 5,
                    ..Context::default()
                },
                force: false,
                id: "s1".into(),
            },
            T0,
        );
        apply_db(&conn, &effects).expect("save");
        let restored = restore(&conn, T0 + minutes(10)).expect("restore");
        assert_eq!(
            restored.current.as_ref().map(|s| (s.id.as_str(), s.kind)),
            Some(("s1", Kind::Focus))
        );

        let mut restored = restored;
        let effects = restored.handle(Event::Tick, T0 + minutes(25));
        apply_db(&conn, &effects).expect("save");
        let outcome: String = conn
            .query_row(
                "SELECT outcome FROM focus_sessions WHERE id = 's1'",
                [],
                |r| r.get(0),
            )
            .expect("outcome");
        assert_eq!(outcome, "completed");
        assert_eq!(restore(&conn, T0 + minutes(26)).expect("row").in_row, 1);
    }

    #[test]
    fn a_session_uses_its_areas_lengths() {
        let conn = conn();
        conn.execute_batch(
            "INSERT INTO day_blocks (id, logical_date, start_at, end_at, kind, area_id, title, created_at, updated_at)
             VALUES ('b1', '2026-11-11', 0, 1, 'area', 'coding', 'Coding skills', 0, 0);",
        )
        .expect("block");
        let context = context_for(&conn, Some("b1")).expect("context");
        assert_eq!(
            (context.focus_min, context.break_min, context.title.as_str()),
            (50, 10, "Coding skills")
        );
        assert_eq!(context_for(&conn, None).expect("plain").focus_min, 25);
    }
}
