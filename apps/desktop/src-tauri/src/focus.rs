//! The focus timer (plan §3.6, §4.2): runs in Rust so it works with no window
//! open, and saves every change of state so sleep or a crash never loses a
//! session.
//!
//! `Machine` is pure: events in, effects out, time passed in. The runtime
//! below applies the effects (database rows, toasts) and wakes a thread at
//! the next deadline.

use std::collections::HashMap;
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
/// A run's length when none is given (plan v3: 30 min, Enter to start).
pub const RUN_MIN: i64 = 30;
/// A task done live teaches its time when at least this share of its effort
/// was spent while it was the only lane running.
pub const CLEAN_SHARE: f64 = 0.7;

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

/// A task in a run: a lane you start, pause and finish on its own (T-084).
#[derive(Debug, Clone, PartialEq)]
pub struct Lane {
    pub task_id: String,
    pub title: String,
    /// The task's area when it joined the run (a snapshot).
    pub area_id: Option<String>,
    pub area: Option<String>,
    pub position: i64,
    /// When its open span began; None while paused or not started.
    pub running_since: Option<i64>,
    pub done: bool,
    /// Lane time in spans already closed.
    pub closed_ms: i64,
}

impl Lane {
    /// Clock time the lane ran, shared or not.
    pub fn wall_ms(&self, now: i64) -> i64 {
        self.closed_ms + self.running_since.map_or(0, |since| (now - since).max(0))
    }

    fn stop_running(&mut self, at: i64) -> bool {
        match self.running_since.take() {
            Some(since) => {
                self.closed_ms += (at - since).max(0);
                true
            }
            None => false,
        }
    }
}

/// How a lane's span ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SpanEnd {
    Done,
    Pause,
}

impl SpanEnd {
    pub fn as_str(self) -> &'static str {
        match self {
            SpanEnd::Done => "done",
            SpanEnd::Pause => "pause",
        }
    }
}

/// A run's name when nothing else names it: its first task, "+N" for the rest.
pub fn run_title(lanes: &[Lane]) -> String {
    match lanes {
        [] => "Focus".into(),
        [only] => only.title.clone(),
        [first, rest @ ..] => format!("{} +{}", first.title, rest.len()),
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
    /// Distracted (+1) taps on this session; the card shows them.
    pub distractions: u32,
    /// The run's tasks, in order. Empty for a session with no task.
    pub lanes: Vec<Lane>,
    /// A break or "+5 min": the run it follows.
    pub run_of: Option<String>,
}

impl Session {
    pub fn ends_at(&self) -> i64 {
        self.started_at + self.planned_min * MINUTE_MS + self.paused_ms
    }

    pub fn remaining_ms(&self, now: i64) -> i64 {
        let reference = self.paused_at.unwrap_or(now);
        self.ends_at() - reference
    }

    /// Every lane stops at `at` (the focus part ended); the spans close in
    /// the database with the session (apply_db, Close).
    fn end_lanes(&mut self, at: i64) {
        for lane in &mut self.lanes {
            lane.stop_running(at);
        }
    }

    /// The first task stays on the row for queries written before runs, and
    /// names the run while nothing else (a block, an intent) does.
    fn follow_first_lane(&mut self, title_before: &str) {
        if self.block_id.is_some() {
            return;
        }
        if let Some(first) = self.lanes.iter().min_by_key(|lane| lane.position) {
            self.task_id = Some(first.task_id.clone());
            self.area_id.clone_from(&first.area_id);
        }
        if self.title == title_before {
            self.title = run_title(&self.lanes);
        }
    }

    /// The lanes as a break or "+5 min" carries them: nothing running.
    fn carried_lanes(&self, keep_time: bool) -> Vec<Lane> {
        self.lanes
            .iter()
            .map(|lane| Lane {
                running_since: None,
                closed_ms: if keep_time { lane.closed_ms } else { 0 },
                ..lane.clone()
            })
            .collect()
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
    /// The run's tasks (a block's task, or the tasks a run was started with).
    pub lanes: Vec<Lane>,
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
    /// Lane controls (T-084): only while a run's focus part is going.
    LaneStart {
        task_id: String,
    },
    LanePause {
        task_id: String,
    },
    LaneDone {
        task_id: String,
    },
    LaneAdd {
        lane: Lane,
    },
    LaneRemove {
        task_id: String,
    },
}

#[derive(Debug, Clone, PartialEq)]
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

#[derive(Debug, Clone, PartialEq)]
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
    SpanOpen {
        session_id: String,
        task_id: String,
        at: i64,
    },
    SpanClose {
        session_id: String,
        task_id: String,
        at: i64,
        end: SpanEnd,
    },
    LaneRemoved {
        session_id: String,
        task_id: String,
    },
    /// Marks the task done through the logged, undoable path (tasks.rs).
    TaskDone {
        session_id: String,
        task_id: String,
        at: i64,
    },
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
            Event::Distracted => match &mut self.current {
                Some(session) if session.kind == Kind::Focus => {
                    session.distractions += 1;
                    vec![Effect::AddDistraction {
                        id: session.id.clone(),
                    }]
                }
                _ => vec![],
            },
            Event::Extend { id } => self.extend(id, now),
            Event::LaneStart { .. }
            | Event::LanePause { .. }
            | Event::LaneDone { .. }
            | Event::LaneAdd { .. }
            | Event::LaneRemove { .. } => self.lane(event, now),
        }
    }

    fn lane(&mut self, event: Event, now: i64) -> Vec<Effect> {
        let Some(session) = self.current.as_mut() else {
            return vec![];
        };
        if session.kind != Kind::Focus {
            return vec![];
        }
        let session_id = session.id.clone();
        let find = |lanes: &[Lane], task_id: &str| lanes.iter().position(|l| l.task_id == task_id);
        match event {
            Event::LaneStart { task_id } => {
                let Some(index) = find(&session.lanes, &task_id) else {
                    return vec![];
                };
                let lane = &mut session.lanes[index];
                if lane.done || lane.running_since.is_some() {
                    return vec![];
                }
                lane.running_since = Some(now);
                vec![Effect::SpanOpen {
                    session_id,
                    task_id,
                    at: now,
                }]
            }
            Event::LanePause { task_id } => {
                let Some(index) = find(&session.lanes, &task_id) else {
                    return vec![];
                };
                if !session.lanes[index].stop_running(now) {
                    return vec![];
                }
                vec![Effect::SpanClose {
                    session_id,
                    task_id,
                    at: now,
                    end: SpanEnd::Pause,
                }]
            }
            Event::LaneDone { task_id } => {
                let Some(index) = find(&session.lanes, &task_id) else {
                    return vec![];
                };
                let lane = &mut session.lanes[index];
                if lane.done {
                    return vec![];
                }
                let mut effects = Vec::new();
                if lane.stop_running(now) {
                    effects.push(Effect::SpanClose {
                        session_id: session_id.clone(),
                        task_id: task_id.clone(),
                        at: now,
                        end: SpanEnd::Done,
                    });
                }
                lane.done = true;
                effects.push(Effect::TaskDone {
                    session_id,
                    task_id,
                    at: now,
                });
                effects
            }
            Event::LaneAdd { mut lane } => {
                if find(&session.lanes, &lane.task_id).is_some() {
                    return vec![];
                }
                let title_before = run_title(&session.lanes);
                lane.position = session.lanes.iter().map(|l| l.position).max().unwrap_or(0) + 1;
                lane.running_since = None;
                lane.closed_ms = 0;
                session.lanes.push(lane);
                session.follow_first_lane(&title_before);
                vec![Effect::Save(session.clone())]
            }
            Event::LaneRemove { task_id } => {
                let Some(index) = find(&session.lanes, &task_id) else {
                    return vec![];
                };
                // A finished task stays: it was done in this run.
                if session.lanes[index].done {
                    return vec![];
                }
                let title_before = run_title(&session.lanes);
                session.lanes.remove(index);
                session.follow_first_lane(&title_before);
                vec![
                    Effect::LaneRemoved {
                        session_id,
                        task_id,
                    },
                    Effect::Save(session.clone()),
                ]
            }
            _ => vec![],
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
        let mut session = Session {
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
            distractions: 0,
            lanes: context.lanes,
            run_of: None,
        };
        // The first open task's lane starts with the run.
        let opened = session
            .lanes
            .iter_mut()
            .find(|lane| !lane.done)
            .map(|lane| {
                lane.running_since = Some(now);
                lane.task_id.clone()
            });
        effects.push(Effect::Save(session.clone()));
        if let Some(task_id) = opened {
            effects.push(Effect::SpanOpen {
                session_id: session.id.clone(),
                task_id,
                at: now,
            });
        }
        self.current = Some(session);
        effects
    }

    fn tick(&mut self, now: i64) -> Vec<Effect> {
        let Some(mut session) = self.current.clone() else {
            return vec![];
        };
        if session.paused_at.is_some() || session.remaining_ms(now) > 0 {
            return vec![];
        }
        let ended = session.ends_at();
        session.end_lanes(ended);
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
                    distractions: 0,
                    lanes: session.carried_lanes(true),
                    run_of: session.run_of.clone().or_else(|| Some(session.id.clone())),
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
            Some(mut session) => {
                if session.kind == Kind::Focus {
                    self.last_focus_end = Some(now);
                }
                let mut effects = Vec::new();
                // An open pause is pause time, not focus: fold it in before closing.
                if let Some(paused_at) = session.paused_at.take() {
                    session.paused_ms += now - paused_at;
                    effects.push(Effect::Save(session.clone()));
                }
                session.end_lanes(now);
                effects.push(Effect::Close {
                    id: session.id,
                    at: now,
                    outcome: Outcome::Stopped,
                });
                effects
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
            distractions: 0,
            lanes: current.carried_lanes(false),
            run_of: current.run_of.clone(),
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
    pub distractions: u32,
    /// The run's lanes, in order (empty for a session with no task).
    pub lanes: Vec<LaneStatus>,
}

/// A lane as the widget, tray and sheet show it.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct LaneStatus {
    pub id: String,
    pub title: String,
    pub area_id: Option<String>,
    pub area: Option<String>,
    pub running: bool,
    pub done: bool,
    /// Clock minutes the lane ran so far, shared or not.
    pub wall_min: i64,
}

fn lane_status(lanes: &[Lane], now: i64) -> Vec<LaneStatus> {
    lanes
        .iter()
        .map(|lane| LaneStatus {
            id: lane.task_id.clone(),
            title: lane.title.clone(),
            area_id: lane.area_id.clone(),
            area: lane.area.clone(),
            running: lane.running_since.is_some(),
            done: lane.done,
            wall_min: lane.wall_ms(now) / MINUTE_MS,
        })
        .collect()
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
            distractions: session.distractions,
            lanes: lane_status(&session.lanes, now),
        },
        None => Status {
            kind: None,
            title: String::new(),
            remaining_ms: 0,
            planned_min: 0,
            paused: false,
            in_row: machine.in_row,
            block_id: None,
            distractions: 0,
            lanes: Vec::new(),
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
           (id, block_id, area_id, task_id, kind, started_at, planned_min, paused_at, paused_ms, extended, run_of)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
         ON CONFLICT (id) DO UPDATE SET planned_min = ?7, paused_at = ?8, paused_ms = ?9, extended = ?10,
           area_id = ?3, task_id = ?4",
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
            session.run_of,
        ],
    )?;
    // A break carries its run's lanes only in memory; the rows are the run's.
    if session.kind == Kind::Focus {
        for lane in &session.lanes {
            conn.execute(
                "INSERT OR IGNORE INTO focus_run_tasks (session_id, task_id, area_id, position)
                 VALUES (?1, ?2, ?3, ?4)",
                params![session.id, lane.task_id, lane.area_id, lane.position],
            )?;
        }
    }
    Ok(())
}

/// The undo context of a task ticked done in a run's lane.
pub fn lane_context(session_id: &str) -> String {
    format!("lane:{session_id}")
}

/// Pieces of time where exactly one lane ran, per task: the "on its own"
/// part of a clean timing. Spans are clamped to the run.
fn solo_ms(spans: &[(String, i64, i64)], from: i64, to: i64) -> HashMap<String, i64> {
    let clamped: Vec<(&str, i64, i64)> = spans
        .iter()
        .map(|(task, start, end)| (task.as_str(), (*start).max(from), (*end).min(to)))
        .filter(|(_, start, end)| end > start)
        .collect();
    let mut points: Vec<i64> = clamped
        .iter()
        .flat_map(|(_, start, end)| [*start, *end])
        .collect();
    points.sort_unstable();
    points.dedup();
    let mut out: HashMap<String, i64> = HashMap::new();
    for piece in points.windows(2) {
        let (a, b) = (piece[0], piece[1]);
        let mut running: Vec<&str> = clamped
            .iter()
            .filter(|(_, start, end)| *start <= a && *end >= b)
            .map(|(task, _, _)| *task)
            .collect();
        running.sort_unstable();
        running.dedup();
        if let [only] = running.as_slice() {
            *out.entry((*only).to_string()).or_default() += b - a;
        }
    }
    out
}

/// When a run closes: each task's effort (its share, v_focus_share), its
/// wall minutes, and whether it is a clean timing (done live, with at least
/// CLEAN_SHARE of its effort spent while it was the only lane running).
pub fn finish_run(conn: &Connection, session_id: &str) -> rusqlite::Result<()> {
    let tasks: Vec<(String, Option<String>)> = conn
        .prepare("SELECT task_id, result FROM focus_run_tasks WHERE session_id = ?1")?
        .query_map([session_id], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<Result<_, _>>()?;
    if tasks.is_empty() {
        return Ok(());
    }
    let (started, ended, paused_ms): (i64, Option<i64>, i64) = conn.query_row(
        "SELECT started_at, ended_at, paused_ms FROM focus_sessions WHERE id = ?1",
        [session_id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    )?;
    let Some(ended) = ended else {
        return Ok(());
    };
    let wall = ended - started;
    // Shares are scaled to focus time (pauses out), as the view does.
    let scale = if wall > 0 {
        (wall - paused_ms).max(0) as f64 / wall as f64
    } else {
        0.0
    };
    let spans: Vec<(String, i64, i64)> = conn
        .prepare(
            "SELECT task_id, start_at, end_at FROM focus_lane_spans
             WHERE session_id = ?1 AND end_at IS NOT NULL",
        )?
        .query_map([session_id], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })?
        .collect::<Result<_, _>>()?;
    let solo = solo_ms(&spans, started, ended);
    for (task_id, result) in tasks {
        let wall_ms: i64 = spans
            .iter()
            .filter(|(task, _, _)| *task == task_id)
            .map(|(_, start, end)| ((*end).min(ended) - (*start).max(started)).max(0))
            .sum();
        let effort: f64 = conn.query_row(
            "SELECT COALESCE(SUM(minutes), 0) FROM v_focus_share WHERE session_id = ?1 AND task_id = ?2",
            params![session_id, task_id],
            |row| row.get(0),
        )?;
        let solo_min = solo.get(&task_id).copied().unwrap_or(0) as f64 * scale / 60_000.0;
        let clean = result.as_deref() == Some("done")
            && effort > 0.0
            && solo_min + 1e-9 >= CLEAN_SHARE * effort;
        conn.execute(
            "UPDATE focus_run_tasks SET effort_min = ?3, wall_min = ?4, clean = ?5
             WHERE session_id = ?1 AND task_id = ?2",
            params![
                session_id,
                task_id,
                effort,
                (wall_ms + MINUTE_MS / 2) / MINUTE_MS,
                i64::from(clean)
            ],
        )?;
    }
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
                // The focus part is over: every lane still running stops with it.
                conn.execute(
                    "UPDATE focus_lane_spans SET end_at = MAX(start_at, ?2), end_kind = 'run_end'
                     WHERE session_id = ?1 AND end_at IS NULL",
                    params![id, at],
                )?;
                finish_run(conn, id)?;
            }
            Effect::SpanOpen {
                session_id,
                task_id,
                at,
            } => {
                conn.execute(
                    "INSERT INTO focus_lane_spans (session_id, task_id, start_at) VALUES (?1, ?2, ?3)",
                    params![session_id, task_id, at],
                )?;
            }
            Effect::SpanClose {
                session_id,
                task_id,
                at,
                end,
            } => {
                conn.execute(
                    "UPDATE focus_lane_spans SET end_at = MAX(start_at, ?3), end_kind = ?4
                     WHERE session_id = ?1 AND task_id = ?2 AND end_at IS NULL",
                    params![session_id, task_id, at, end.as_str()],
                )?;
            }
            Effect::LaneRemoved {
                session_id,
                task_id,
            } => {
                conn.execute(
                    "DELETE FROM focus_lane_spans WHERE session_id = ?1 AND task_id = ?2",
                    params![session_id, task_id],
                )?;
                conn.execute(
                    "DELETE FROM focus_run_tasks WHERE session_id = ?1 AND task_id = ?2",
                    params![session_id, task_id],
                )?;
            }
            Effect::TaskDone {
                session_id,
                task_id,
                at,
            } => {
                conn.execute(
                    "UPDATE focus_run_tasks SET result = 'done' WHERE session_id = ?1 AND task_id = ?2",
                    params![session_id, task_id],
                )?;
                if let Err(error) =
                    crate::tasks::mark_done_in(conn, task_id, &lane_context(session_id), *at)
                {
                    log::error!("could not mark the lane's task done: {error}");
                }
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
                    lanes: Vec::new(),
                })
            },
        )
        .optional()?;
    let Some(mut context) = row else {
        return Ok(plain());
    };
    // A block's task is the run's only lane (none for a block with no task).
    if let Some(task_id) = context.task_id.clone() {
        context.lanes = lane_for(conn, &task_id, 1)?.into_iter().collect();
    }
    Ok(context)
}

/// A task as a lane: its title and area now, nothing run yet. None when the
/// task is gone.
pub fn lane_for(conn: &Connection, task_id: &str, position: i64) -> rusqlite::Result<Option<Lane>> {
    conn.query_row(
        "SELECT t.title, t.area_id, a.name, t.status = 'done'
         FROM task_items AS t LEFT JOIN area_items AS a ON a.id = t.area_id
         WHERE t.id = ?1 AND t.deleted_at IS NULL",
        [task_id],
        |row| {
            Ok(Lane {
                task_id: task_id.to_string(),
                title: row.get(0)?,
                area_id: row.get(1)?,
                area: row.get(2)?,
                position,
                running_since: None,
                done: row.get(3)?,
                closed_ms: 0,
            })
        },
    )
    .optional()
}

/// A run of tasks (T-084): its lanes in the order given (unknown, deleted and
/// repeated ids left out), its first task's area and break, `minutes` long
/// (RUN_MIN when not given). No lanes: Ok(None).
pub fn context_for_run(
    conn: &Connection,
    task_ids: &[String],
    minutes: Option<i64>,
) -> rusqlite::Result<Option<Context>> {
    let mut lanes: Vec<Lane> = Vec::new();
    for task_id in task_ids {
        if lanes.iter().any(|lane| &lane.task_id == task_id) {
            continue;
        }
        let position = i64::try_from(lanes.len()).unwrap_or(i64::MAX - 1) + 1;
        if let Some(lane) = lane_for(conn, task_id, position)? {
            lanes.push(lane);
        }
    }
    let Some(first) = lanes.first() else {
        return Ok(None);
    };
    let break_min: i64 = match &first.area_id {
        Some(area) => conn
            .query_row(
                "SELECT break_min FROM area_items WHERE id = ?1",
                [area],
                |row| row.get(0),
            )
            .optional()?
            .unwrap_or(5),
        None => 5,
    };
    Ok(Some(Context {
        block_id: None,
        area_id: first.area_id.clone(),
        task_id: Some(first.task_id.clone()),
        title: run_title(&lanes),
        focus_min: minutes.unwrap_or(RUN_MIN).max(1),
        break_min,
        lanes,
    }))
}

/// A session tied to nothing: 25 minutes, a 5-minute break.
fn plain() -> Context {
    Context {
        title: "Focus".into(),
        focus_min: 25,
        break_min: 5,
        ..Context::default()
    }
}

/// A session for an area with no block (spec §1 rule 7): its time counts
/// for the area, with the area's lengths.
pub fn context_for_area(conn: &Connection, area_id: &str) -> rusqlite::Result<Context> {
    let row = conn
        .query_row(
            "SELECT name, focus_min, break_min FROM area_items WHERE id = ?1 AND deleted_at IS NULL",
            [area_id],
            |row| {
                Ok(Context {
                    area_id: Some(area_id.to_string()),
                    title: row.get(0)?,
                    focus_min: row.get(1)?,
                    break_min: row.get(2)?,
                    ..Context::default()
                })
            },
        )
        .optional()?;
    Ok(row.unwrap_or_else(plain))
}

/// What a session is for: a block wins over an area; neither is a plain one.
pub fn context_for_target(
    conn: &Connection,
    block_id: Option<&str>,
    area_id: Option<&str>,
) -> rusqlite::Result<Context> {
    match (block_id, area_id) {
        (Some(_), _) | (None, None) => context_for(conn, block_id),
        (None, Some(area_id)) => context_for_area(conn, area_id),
    }
}

/// A block on today's board, as the set-up sheet offers it.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct DayBlock {
    pub id: String,
    pub title: String,
    pub start_at: i64,
    pub end_at: i64,
    pub kind: String,
    pub area_id: Option<String>,
}

/// Today's blocks (logical day), skipped and moved ones left out.
pub fn today_blocks(conn: &Connection, now: i64) -> rusqlite::Result<Vec<DayBlock>> {
    let (date, _) = crate::tasks::logical_day(now);
    let mut statement = conn.prepare(
        "SELECT id, title, start_at, end_at, kind, area_id FROM day_blocks
         WHERE logical_date = ?1 AND deleted_at IS NULL AND status NOT IN ('skipped', 'moved')
         ORDER BY start_at, end_at, title",
    )?;
    statement
        .query_map([date], |row| {
            Ok(DayBlock {
                id: row.get(0)?,
                title: row.get(1)?,
                start_at: row.get(2)?,
                end_at: row.get(3)?,
                kind: row.get(4)?,
                area_id: row.get(5)?,
            })
        })?
        .collect()
}

/// An area the sheet offers ("an area" in spec §1 rule 7).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AreaChoice {
    pub id: String,
    pub name: String,
}

/// Active areas in planning order.
pub fn area_choices(conn: &Connection) -> rusqlite::Result<Vec<AreaChoice>> {
    let mut statement = conn.prepare(
        "SELECT id, name FROM area_items WHERE active = 1 AND deleted_at IS NULL
         ORDER BY priority_rank, name",
    )?;
    statement
        .query_map([], |row| {
            Ok(AreaChoice {
                id: row.get(0)?,
                name: row.get(1)?,
            })
        })?
        .collect()
}

/// The undo context of a block added by "Other…".
pub fn other_context(block_id: &str) -> String {
    format!("focus:{block_id}")
}

/// "Other…" on the sheet: adds a neutral block at `now` for `minutes`, through
/// the allowlisted tx ops so it is logged and can be undone. Returns its id.
pub fn add_other_block(
    conn: &Connection,
    title: &str,
    minutes: i64,
    now: i64,
) -> Result<String, crate::tx::TxError> {
    let id = new_id(now).replacen("fs-", "fb-", 1);
    let (date, _) = crate::tasks::logical_day(now);
    let mut values = serde_json::Map::new();
    values.insert("logical_date".into(), date.into());
    values.insert("start_at".into(), now.into());
    values.insert("end_at".into(), (now + minutes.max(1) * MINUTE_MS).into());
    values.insert("kind".into(), "area".into());
    values.insert("area_id".into(), serde_json::Value::Null);
    values.insert("title".into(), title.trim().into());
    values.insert("source".into(), "user".into());
    let ops = [crate::tx::Op::Insert {
        table: "day_blocks".into(),
        id: id.clone(),
        values,
    }];
    let txn = conn
        .unchecked_transaction()
        .map_err(|error| crate::tx::TxError::Sql(error.to_string()))?;
    crate::tx::apply_ops(&txn, "user", Some(&other_context(&id)), &ops, now)?;
    txn.commit()
        .map_err(|error| crate::tx::TxError::Sql(error.to_string()))?;
    Ok(id)
}

/// Takes back a block "Other…" added when its session did not start.
pub fn remove_other_block(conn: &Connection, block_id: &str, now: i64) {
    if let Err(error) = crate::tx::undo_context(conn, "user", &other_context(block_id), now) {
        log::warn!("could not take back the focus block: {error}");
    }
}

/// Loads the open session (if any) and the current row after a restart.
pub fn restore(conn: &Connection, now: i64) -> rusqlite::Result<Machine> {
    let open = conn
        .query_row(
            "SELECT s.id, s.kind, s.started_at, s.planned_min, s.paused_at, s.paused_ms, s.block_id,
                    s.area_id, s.task_id, s.extended,
                    COALESCE(f.intent_text, b.title), COALESCE(a.break_min, 5),
                    s.distractions, s.run_of, COALESCE(a.name, 'Focus')
             FROM focus_sessions AS s
             LEFT JOIN day_blocks AS b ON b.id = s.block_id
             LEFT JOIN area_items AS a ON a.id = s.area_id
             -- A break carries its session's intent as its title (break id = session id + '-break').
             LEFT JOIN focus_sessions AS f ON f.id = replace(s.id, '-break', '') AND f.kind = 'focus'
             WHERE s.ended_at IS NULL ORDER BY s.started_at DESC LIMIT 1",
            [],
            |row| {
                let kind = match row.get::<_, String>(1)?.as_str() {
                    "break" => Kind::Break,
                    "long_break" => Kind::LongBreak,
                    _ => Kind::Focus,
                };
                let named: Option<String> = row.get(10)?;
                let area_name: String = row.get(14)?;
                Ok((
                    Session {
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
                        title: area_name,
                        break_min: row.get(11)?,
                        distractions: row.get(12)?,
                        lanes: Vec::new(),
                        run_of: row.get(13)?,
                    },
                    named,
                ))
            },
        )
        .optional()?;
    // The lanes: a run's own; a break's are its run's, with nothing running.
    let open = match open {
        Some((mut session, named)) => {
            session.lanes = match (session.kind, &session.run_of) {
                (Kind::Focus, _) => load_lanes(conn, &session.id, true)?,
                (_, Some(run)) => load_lanes(conn, run, false)?,
                _ => Vec::new(),
            };
            match named {
                Some(title) => session.title = title,
                None if !session.lanes.is_empty() => session.title = run_title(&session.lanes),
                None => {}
            }
            Some(session)
        }
        None => None,
    };
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

/// A run's lanes from the database, in order. `live`: with their open span
/// and the time they ran (a break shows its run's lanes without them).
fn load_lanes(conn: &Connection, session_id: &str, live: bool) -> rusqlite::Result<Vec<Lane>> {
    let mut statement = conn.prepare(
        "SELECT r.task_id, t.title, r.area_id, a.name, r.position,
                COALESCE(r.result = 'done', 0) OR t.status = 'done',
                (SELECT MIN(p.start_at) FROM focus_lane_spans AS p
                 WHERE p.session_id = r.session_id AND p.task_id = r.task_id AND p.end_at IS NULL),
                (SELECT COALESCE(SUM(p.end_at - p.start_at), 0) FROM focus_lane_spans AS p
                 WHERE p.session_id = r.session_id AND p.task_id = r.task_id AND p.end_at IS NOT NULL)
         FROM focus_run_tasks AS r
         JOIN task_items AS t ON t.id = r.task_id
         LEFT JOIN area_items AS a ON a.id = r.area_id
         WHERE r.session_id = ?1
         ORDER BY r.position",
    )?;
    statement
        .query_map([session_id], |row| {
            Ok(Lane {
                task_id: row.get(0)?,
                title: row.get(1)?,
                area_id: row.get(2)?,
                area: row.get(3)?,
                position: row.get(4)?,
                done: row.get(5)?,
                running_since: if live { row.get(6)? } else { None },
                closed_ms: if live { row.get(7)? } else { 0 },
            })
        })?
        .collect()
}

/// Tables a set of effects wrote, for "data-changed".
fn changed_tables(effects: &[Effect]) -> Vec<&'static str> {
    let mut tables = Vec::new();
    let mut add = |table: &'static str| {
        if !tables.contains(&table) {
            tables.push(table);
        }
    };
    for effect in effects {
        match effect {
            Effect::Save(_) | Effect::Close { .. } | Effect::AddDistraction { .. } => {
                add("focus_sessions");
                add("focus_run_tasks");
                add("focus_lane_spans");
            }
            Effect::SpanOpen { .. } | Effect::SpanClose { .. } | Effect::LaneRemoved { .. } => {
                add("focus_run_tasks");
                add("focus_lane_spans");
            }
            Effect::TaskDone { .. } => {
                add("focus_run_tasks");
                add("task_items");
            }
            _ => {}
        }
    }
    tables
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
    let changed_session = effects
        .iter()
        .any(|effect| matches!(effect, Effect::Save(_) | Effect::Close { .. }));
    // Toasts wait for Do not disturb to be restored (a break toast must not
    // land while it is on). Switching it can take a moment, so both run off
    // the calling thread (the tray menu and commands must stay responsive).
    let toasts: Vec<Effect> = effects
        .iter()
        .filter(|effect| matches!(effect, Effect::BreakStarted { .. } | Effect::BreakOver))
        .cloned()
        .collect();
    if changed_session || !toasts.is_empty() {
        let handle = app.clone();
        std::thread::spawn(move || {
            if changed_session {
                sync_dnd(&handle);
            }
            for effect in &toasts {
                show_toast(&handle, effect);
            }
        });
    }
    let tables = changed_tables(&effects);
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
    if !tables.is_empty() {
        let _ = app.emit("focus-changed", ());
        let _ = app.emit("data-changed", tables);
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
            let intent = open_intent(&app.state::<Db>().write.lock());
            let mut buttons: Vec<Button> = Vec::new();
            if intent.is_some() {
                buttons.push(Button {
                    label: "Yes",
                    action: "done:yes",
                });
                buttons.push(Button {
                    label: "Partly",
                    action: "done:partly",
                });
                buttons.push(Button {
                    label: "No",
                    action: "done:no",
                });
            }
            if *can_extend {
                buttons.push(Button {
                    label: "+5 min work, once",
                    action: "extend",
                });
            }
            let body = match &intent {
                Some((_, text)) => format!("Done with: {text}? {body}"),
                None => body.to_string(),
            };
            let intent_id = intent.map(|(id, _)| id);
            notify::show(app, &title, &body, &buttons, move |action| {
                match action.as_deref() {
                    Some("extend") => {
                        let id = new_id(clock::now_ms());
                        dispatch(&handle, Event::Extend { id });
                    }
                    Some(answer) => {
                        if let (Some(id), Some(done)) = (&intent_id, answer.strip_prefix("done:")) {
                            answer_intent(&handle, id, done);
                        }
                    }
                    None => {}
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
                        let (block, area) = last_target_of(&handle);
                        start_for(&handle, block.as_deref(), area.as_deref(), false);
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

/// Do not disturb follows the timer: on during focus, restored otherwise.
pub fn sync_dnd(app: &AppHandle) {
    crate::dnd::sync(app, || {
        let focus = app.state::<FocusState>();
        let machine = focus.machine.lock();
        machine
            .current
            .as_ref()
            .is_some_and(|session| session.kind == Kind::Focus)
    });
}

/// "This session I will…": shown as the session's title and stored on its row.
pub fn set_intent(app: &AppHandle, intent: &str) {
    let focus = app.state::<FocusState>();
    let id = {
        let mut machine = focus.machine.lock();
        match machine.current.as_mut() {
            Some(session) if session.kind == Kind::Focus => {
                session.title = intent.to_string();
                Some(session.id.clone())
            }
            _ => None,
        }
    };
    let Some(id) = id else { return };
    let db = app.state::<Db>();
    if let Err(error) = db.write.lock().execute(
        "UPDATE focus_sessions SET intent_text = ?1 WHERE id = ?2",
        rusqlite::params![intent, id],
    ) {
        log::warn!("could not save the session intent: {error}");
    }
    let _ = app.emit("focus-changed", ());
}

/// The intent of the focus session that just ended, if it has one and it is
/// still unanswered. Only that one session: an older unanswered intent is
/// never asked about later (it would be judged on the wrong work).
pub fn open_intent(conn: &Connection) -> Option<(String, String)> {
    conn.query_row(
        "SELECT id, intent_text FROM (
           SELECT id, intent_text, intent_done FROM focus_sessions
           WHERE kind = 'focus' AND ended_at IS NOT NULL
           ORDER BY ended_at DESC LIMIT 1
         ) WHERE intent_text IS NOT NULL AND intent_done IS NULL",
        [],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )
    .ok()
}

fn answer_intent(app: &AppHandle, id: &str, answer: &str) {
    let db = app.state::<Db>();
    if let Err(error) = db.write.lock().execute(
        "UPDATE focus_sessions SET intent_done = ?1 WHERE id = ?2 AND intent_done IS NULL",
        rusqlite::params![answer, id],
    ) {
        log::warn!("could not save the intent answer: {error}");
    }
    let _ = app.emit("data-changed", ["focus_sessions"]);
}

/// What the last focus session was for (its block, else its area), so the
/// next round after a break counts for the same thing (spec §1 rule 7).
pub fn last_target(conn: &Connection) -> (Option<String>, Option<String>) {
    conn.query_row(
        "SELECT block_id, area_id FROM focus_sessions WHERE kind = 'focus'
         ORDER BY started_at DESC LIMIT 1",
        [],
        |row| {
            let block: Option<String> = row.get(0)?;
            let area: Option<String> = row.get(1)?;
            Ok(match block {
                Some(block) => (Some(block), None),
                None => (None, area),
            })
        },
    )
    .unwrap_or((None, None))
}

fn last_target_of(app: &AppHandle) -> (Option<String>, Option<String>) {
    let db = app.state::<Db>();
    let conn = db.write.lock();
    last_target(&conn)
}

/// Starts a session for a block (or a plain 25-minute one).
pub fn start_with_block(app: &AppHandle, block_id: Option<String>, force: bool) -> Vec<Effect> {
    start_for(app, block_id.as_deref(), None, force)
}

/// Starts a session for a block, an area with no block, or nothing.
pub fn start_for(
    app: &AppHandle,
    block_id: Option<&str>,
    area_id: Option<&str>,
    force: bool,
) -> Vec<Effect> {
    let context = {
        let db = app.state::<Db>();
        let conn = db.write.lock();
        context_for_target(&conn, block_id, area_id)
    };
    match context {
        Ok(context) => start_context(app, context, force),
        Err(error) => {
            log::error!("could not read the block for focus: {error}");
            vec![]
        }
    }
}

/// Starts a session for a context: the hard stop, the machine, the cap.
fn start_context(app: &AppHandle, context: Context, force: bool) -> Vec<Effect> {
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

/// Starts a run of tasks (T-084); the first task's lane starts at once.
pub fn start_run(
    app: &AppHandle,
    task_ids: &[String],
    minutes: Option<i64>,
    force: bool,
) -> Result<Vec<Effect>, String> {
    let context = {
        let db = app.state::<Db>();
        let conn = db.write.lock();
        context_for_run(&conn, task_ids, minutes).map_err(|error| error.to_string())?
    };
    let context = context.ok_or_else(|| "Pick at least one task for the run.".to_string())?;
    Ok(start_context(app, context, force))
}

/// "+ Add" on a running run: the task joins as a lane, not started.
pub fn add_lane(app: &AppHandle, task_id: &str) -> Result<(), String> {
    let lane = {
        let db = app.state::<Db>();
        let conn = db.write.lock();
        lane_for(&conn, task_id, 0).map_err(|error| error.to_string())?
    };
    let lane = lane.ok_or_else(|| "That task is gone.".to_string())?;
    dispatch(app, Event::LaneAdd { lane });
    Ok(())
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
            lanes: Vec::new(),
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
    fn stopping_while_paused_keeps_the_pause_out_of_focus_time() {
        let mut m = Machine::default();
        start(&mut m, T0, 1);
        m.handle(Event::Pause, T0 + minutes(5));
        let effects = m.handle(Event::Stop, T0 + minutes(50));
        assert!(
            effects.iter().any(|e| matches!(
                e,
                Effect::Save(s) if s.paused_ms == minutes(45) && s.paused_at.is_none()
            )),
            "{effects:?}"
        );
        assert_eq!(
            effects.last(),
            Some(&Effect::Close {
                id: "s1".into(),
                at: T0 + minutes(50),
                outcome: Outcome::Stopped
            })
        );
    }

    #[test]
    fn counts_distractions_on_the_session() {
        let mut m = Machine::default();
        start(&mut m, T0, 1);
        assert_eq!(status(&m, T0).distractions, 0);
        m.handle(Event::Distracted, T0 + 1);
        m.handle(Event::Distracted, T0 + 2);
        assert_eq!(status(&m, T0 + 3).distractions, 2);
        m.handle(Event::Stop, T0 + 4);
        assert_eq!(status(&m, T0 + 5).distractions, 0);
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

    fn start_plain(machine: &mut Machine, now: i64) -> Vec<Effect> {
        machine.handle(
            Event::Start {
                context: plain(),
                force: false,
                id: "s1".into(),
            },
            now,
        )
    }

    #[test]
    fn a_session_stopped_while_paused_counts_only_the_time_before_the_pause() {
        let conn = conn();
        let mut m = Machine::default();
        apply_db(&conn, &start_plain(&mut m, T0)).expect("start");
        apply_db(&conn, &m.handle(Event::Pause, T0 + minutes(5))).expect("pause");
        apply_db(&conn, &m.handle(Event::Stop, T0 + minutes(50))).expect("stop");
        let (focus, paused_at): (i64, Option<i64>) = conn
            .query_row(
                "SELECT (ended_at - started_at - paused_ms) / 60000, paused_at FROM focus_sessions WHERE id = 's1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .expect("row");
        assert_eq!((focus, paused_at), (5, None));
    }

    #[test]
    fn the_distraction_count_survives_a_restart() {
        let conn = conn();
        let mut m = Machine::default();
        apply_db(&conn, &start_plain(&mut m, T0)).expect("start");
        apply_db(&conn, &m.handle(Event::Distracted, T0 + 1)).expect("one");
        apply_db(&conn, &m.handle(Event::Distracted, T0 + 2)).expect("two");
        let restored = restore(&conn, T0 + minutes(1)).expect("restore");
        assert_eq!(status(&restored, T0 + minutes(1)).distractions, 2);
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

    fn ended(conn: &Connection, id: &str, ended_at: i64, intent: Option<&str>) {
        conn.execute(
            "INSERT INTO focus_sessions (id, kind, started_at, planned_min, ended_at, outcome, intent_text)
             VALUES (?1, 'focus', ?2, 25, ?3, 'completed', ?4)",
            params![id, ended_at - minutes(25), ended_at, intent],
        )
        .expect("session");
    }

    #[test]
    fn asks_only_about_the_session_that_just_ended() {
        let conn = conn();
        ended(&conn, "a", T0, Some("finish the login form"));
        assert_eq!(
            open_intent(&conn),
            Some(("a".into(), "finish the login form".into()))
        );
        // A later session without an intent: the old, unanswered one is not asked again.
        ended(&conn, "b", T0 + minutes(40), None);
        assert_eq!(open_intent(&conn), None);
    }

    #[test]
    fn an_answered_intent_is_not_asked_again() {
        let conn = conn();
        ended(&conn, "a", T0, Some("write tests"));
        conn.execute(
            "UPDATE focus_sessions SET intent_done = 'yes' WHERE id = 'a'",
            [],
        )
        .expect("answer");
        assert_eq!(open_intent(&conn), None);
    }

    #[test]
    fn the_intent_survives_a_restart_as_the_title() {
        let conn = conn();
        conn.execute(
            "INSERT INTO focus_sessions (id, kind, started_at, planned_min, intent_text)
             VALUES ('s1', 'focus', ?1, 25, 'outline the post')",
            [T0],
        )
        .expect("session");
        let restored = restore(&conn, T0 + minutes(5)).expect("restore");
        assert_eq!(
            restored.current.map(|s| s.title),
            Some("outline the post".into())
        );
    }

    #[test]
    fn an_area_session_takes_the_areas_name_and_lengths() {
        let conn = conn();
        let context = context_for_target(&conn, None, Some("coding")).expect("area");
        assert_eq!(context.block_id, None);
        assert_eq!(context.area_id.as_deref(), Some("coding"));
        assert_eq!(
            (context.title.as_str(), context.focus_min, context.break_min),
            ("Coding skills", 50, 10)
        );
        // An unknown area is a plain session.
        let unknown = context_for_target(&conn, None, Some("nope")).expect("plain");
        assert_eq!((unknown.area_id, unknown.focus_min), (None, 25));
        assert_eq!(
            context_for_target(&conn, None, None).expect("plain").title,
            "Focus"
        );
    }

    #[test]
    fn a_block_wins_over_an_area() {
        let conn = conn();
        conn.execute_batch(
            "INSERT INTO day_blocks (id, logical_date, start_at, end_at, kind, area_id, title, created_at, updated_at)
             VALUES ('b1', '2026-11-11', 0, 1, 'fixed', NULL, 'Lunch', 0, 0);",
        )
        .expect("block");
        let context = context_for_target(&conn, Some("b1"), Some("coding")).expect("block");
        assert_eq!(
            (
                context.block_id.as_deref(),
                context.area_id,
                context.title.as_str()
            ),
            (Some("b1"), None, "Lunch")
        );
    }

    #[test]
    fn the_next_round_after_a_break_counts_for_the_same_block_or_area() {
        let conn = conn();
        assert_eq!(last_target(&conn), (None, None));
        conn.execute(
            "INSERT INTO focus_sessions (id, area_id, kind, started_at, planned_min)
             VALUES ('s1', 'quran', 'focus', ?1, 20)",
            [T0],
        )
        .expect("area session");
        assert_eq!(last_target(&conn), (None, Some("quran".into())));
        conn.execute_batch(
            "INSERT INTO day_blocks (id, logical_date, start_at, end_at, kind, area_id, title, created_at, updated_at)
             VALUES ('b1', '2026-11-11', 0, 1, 'area', 'coding', 'Coding skills', 0, 0);",
        )
        .expect("block");
        conn.execute(
            "INSERT INTO focus_sessions (id, block_id, area_id, kind, started_at, planned_min)
             VALUES ('s2', 'b1', 'coding', 'focus', ?1, 50)",
            [T0 + minutes(30)],
        )
        .expect("block session");
        assert_eq!(last_target(&conn), (Some("b1".into()), None));
    }

    #[test]
    fn an_area_session_keeps_its_area_name_after_a_restart() {
        let conn = conn();
        conn.execute(
            "INSERT INTO focus_sessions (id, area_id, kind, started_at, planned_min)
             VALUES ('s1', 'quran', 'focus', ?1, 20)",
            [T0],
        )
        .expect("session");
        let restored = restore(&conn, T0 + minutes(5)).expect("restore");
        assert_eq!(restored.current.map(|s| s.title), Some("Quran".into()));
    }

    #[test]
    fn the_sheet_lists_todays_blocks_and_active_areas() {
        let conn = conn();
        conn.execute_batch(
            "INSERT INTO day_blocks (id, logical_date, start_at, end_at, kind, area_id, title, status, created_at, updated_at)
             VALUES ('late', '2026-11-11', 20, 30, 'area', 'coding', 'Coding skills', 'planned', 0, 0),
                    ('early', '2026-11-11', 10, 20, 'fixed', NULL, 'Lunch', 'planned', 0, 0),
                    ('skip', '2026-11-11', 5, 9, 'area', 'gym', 'Gym', 'skipped', 0, 0),
                    ('other-day', '2026-11-12', 10, 20, 'area', 'gym', 'Gym', 'planned', 0, 0);
             UPDATE area_items SET active = 0 WHERE id = 'jobb';",
        )
        .expect("blocks");
        let ids: Vec<String> = today_blocks(&conn, T0)
            .expect("blocks")
            .into_iter()
            .map(|block| block.id)
            .collect();
        assert_eq!(ids, ["early", "late"]);
        let areas = area_choices(&conn).expect("areas");
        assert_eq!(areas.first().map(|a| a.id.as_str()), Some("joba"));
        assert!(areas.iter().all(|a| a.id != "jobb"));
    }

    #[test]
    fn other_adds_an_undoable_block_now_for_the_session_length() {
        let conn = conn();
        let id = add_other_block(&conn, "  Read a book ", 25, T0).expect("add");
        let (date, start, end, kind, area, title, source): (
            String,
            i64,
            i64,
            String,
            Option<String>,
            String,
            String,
        ) = conn
            .query_row(
                "SELECT logical_date, start_at, end_at, kind, area_id, title, source
                 FROM day_blocks WHERE id = ?1 AND deleted_at IS NULL",
                [&id],
                |r| {
                    Ok((
                        r.get(0)?,
                        r.get(1)?,
                        r.get(2)?,
                        r.get(3)?,
                        r.get(4)?,
                        r.get(5)?,
                        r.get(6)?,
                    ))
                },
            )
            .expect("block");
        assert_eq!(
            (
                date.as_str(),
                start,
                end,
                kind.as_str(),
                area,
                title.as_str(),
                source.as_str()
            ),
            (
                "2026-11-11",
                T0,
                T0 + minutes(25),
                "area",
                None,
                "Read a book",
                "user"
            )
        );
        // The session ties to it.
        let context = context_for(&conn, Some(&id)).expect("context");
        assert_eq!(context.title, "Read a book");

        remove_other_block(&conn, &id, T0 + 1);
        let live: i64 = conn
            .query_row(
                "SELECT count(*) FROM day_blocks WHERE id = ?1 AND deleted_at IS NULL",
                [&id],
                |r| r.get(0),
            )
            .expect("count");
        assert_eq!(live, 0);
    }

    // --- Runs with lanes (T-084) ------------------------------------------------

    fn run_db() -> Connection {
        let conn = conn();
        conn.execute_batch(
            "INSERT INTO task_items (id, title, area_id, created_at, updated_at) VALUES
               ('a', 'Login bug', 'joba', 0, 0),
               ('b', 'Invoice export', 'jobb', 0, 0),
               ('c', 'Kifiya application', 'jobhunt', 0, 0);",
        )
        .expect("tasks");
        conn
    }

    /// Runs an event and saves its effects, like dispatch does.
    fn step(conn: &Connection, m: &mut Machine, event: Event, at: i64) -> Vec<Effect> {
        let effects = m.handle(event, at);
        apply_db(conn, &effects).expect("save");
        effects
    }

    fn start_run(conn: &Connection, m: &mut Machine, ids: &[&str], minutes: i64) {
        let ids: Vec<String> = ids.iter().map(|id| (*id).to_string()).collect();
        let context = context_for_run(conn, &ids, Some(minutes))
            .expect("context")
            .expect("lanes");
        step(
            conn,
            m,
            Event::Start {
                context,
                force: false,
                id: "r1".into(),
            },
            T0,
        );
    }

    fn lane(task_id: &str) -> Event {
        Event::LaneStart {
            task_id: task_id.into(),
        }
    }

    fn run_rows(conn: &Connection) -> Vec<(String, Option<String>, f64, i64, i64)> {
        conn.prepare(
            "SELECT task_id, result, effort_min, wall_min, clean FROM focus_run_tasks
             WHERE session_id = 'r1' ORDER BY position",
        )
        .expect("prepare")
        .query_map([], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
        })
        .expect("query")
        .collect::<Result<_, _>>()
        .expect("rows")
    }

    #[test]
    fn a_run_starts_with_its_first_lane_running_and_names_itself() {
        let conn = run_db();
        let mut m = Machine::default();
        start_run(&conn, &mut m, &["a", "b", "a", "nope"], 30);
        let status = status(&m, T0 + minutes(5));
        assert_eq!(status.title, "Login bug +1");
        assert_eq!(status.planned_min, 30);
        let lanes: Vec<(&str, bool, i64)> = status
            .lanes
            .iter()
            .map(|l| (l.id.as_str(), l.running, l.wall_min))
            .collect();
        assert_eq!(lanes, [("a", true, 5), ("b", false, 0)]);
        assert_eq!(status.lanes[0].area.as_deref(), Some("Job A"));
        // The row keeps the first task for old queries; one span is open.
        let (task, area): (String, String) = conn
            .query_row(
                "SELECT task_id, area_id FROM focus_sessions WHERE id = 'r1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .expect("row");
        assert_eq!((task.as_str(), area.as_str()), ("a", "joba"));
        let open: i64 = conn
            .query_row(
                "SELECT count(*) FROM focus_lane_spans WHERE end_at IS NULL",
                [],
                |r| r.get(0),
            )
            .expect("spans");
        assert_eq!(open, 1);
        assert_eq!(
            context_for_run(&conn, &["nope".into()], None).expect("none"),
            None
        );
    }

    #[test]
    fn lanes_start_pause_finish_join_and_leave() {
        let conn = run_db();
        let mut m = Machine::default();
        start_run(&conn, &mut m, &["a", "b"], 30);
        step(&conn, &mut m, lane("b"), T0 + minutes(5));
        // Starting a running lane again does nothing.
        assert!(m.handle(lane("b"), T0 + minutes(6)).is_empty());
        let done = step(
            &conn,
            &mut m,
            Event::LaneDone {
                task_id: "b".into(),
            },
            T0 + minutes(15),
        );
        assert!(done.contains(&Effect::SpanClose {
            session_id: "r1".into(),
            task_id: "b".into(),
            at: T0 + minutes(15),
            end: SpanEnd::Done
        }));
        // A done lane can't start again or leave the run.
        assert!(m.handle(lane("b"), T0 + minutes(16)).is_empty());
        assert!(
            m.handle(
                Event::LaneRemove {
                    task_id: "b".into()
                },
                T0 + minutes(16)
            )
            .is_empty()
        );
        step(
            &conn,
            &mut m,
            Event::LanePause {
                task_id: "a".into(),
            },
            T0 + minutes(20),
        );
        let added = lane_for(&conn, "c", 0).expect("c").expect("lane");
        step(
            &conn,
            &mut m,
            Event::LaneAdd {
                lane: added.clone(),
            },
            T0 + minutes(20),
        );
        assert!(
            m.handle(Event::LaneAdd { lane: added }, T0 + minutes(20))
                .is_empty(),
            "a task joins once"
        );
        step(&conn, &mut m, lane("c"), T0 + minutes(21));
        step(
            &conn,
            &mut m,
            Event::LaneRemove {
                task_id: "c".into(),
            },
            T0 + minutes(22),
        );
        let s = status(&m, T0 + minutes(22));
        let lanes: Vec<(&str, bool, bool, i64)> = s
            .lanes
            .iter()
            .map(|l| (l.id.as_str(), l.running, l.done, l.wall_min))
            .collect();
        assert_eq!(lanes, [("a", false, false, 20), ("b", false, true, 10)]);
        // c left without a trace; b is done through the logged path.
        let c_rows: i64 = conn
            .query_row(
                "SELECT (SELECT count(*) FROM focus_run_tasks WHERE task_id = 'c')
                      + (SELECT count(*) FROM focus_lane_spans WHERE task_id = 'c')",
                [],
                |r| r.get(0),
            )
            .expect("c");
        assert_eq!(c_rows, 0);
        let (status_b, context): (String, String) = conn
            .query_row(
                "SELECT t.status, a.context FROM task_items t
                 JOIN core_activity a ON a.entity_id = t.id AND a.entity_type = 'task_items'
                 WHERE t.id = 'b'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .expect("b");
        assert_eq!((status_b.as_str(), context.as_str()), ("done", "lane:r1"));
        crate::tx::undo_context(&conn, "user", "lane:r1", T0 + minutes(23)).expect("undo");
        let undone: String = conn
            .query_row("SELECT status FROM task_items WHERE id = 'b'", [], |r| {
                r.get(0)
            })
            .expect("status");
        assert_eq!(undone, "todo");
    }

    #[test]
    fn the_runs_end_closes_every_open_span_and_works_out_effort_and_clean() {
        let conn = run_db();
        let mut m = Machine::default();
        start_run(&conn, &mut m, &["a", "b", "c"], 30);
        // a alone 0-15; a and b 15-20; a done at 20; b alone 20-30; c never runs.
        step(&conn, &mut m, lane("b"), T0 + minutes(15));
        step(
            &conn,
            &mut m,
            Event::LaneDone {
                task_id: "a".into(),
            },
            T0 + minutes(20),
        );
        let effects = step(&conn, &mut m, Event::Tick, T0 + minutes(30));
        assert!(
            effects
                .iter()
                .any(|e| matches!(e, Effect::BreakStarted { .. }))
        );
        let kinds: Vec<(String, Option<String>)> = conn
            .prepare("SELECT task_id, end_kind FROM focus_lane_spans ORDER BY id")
            .expect("prepare")
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .expect("query")
            .collect::<Result<_, _>>()
            .expect("rows");
        assert_eq!(
            kinds,
            [
                ("a".into(), Some("done".into())),
                ("b".into(), Some("run_end".into()))
            ]
        );
        let rows = run_rows(&conn);
        let effort: f64 = rows.iter().map(|r| r.2).sum();
        assert!((effort - 30.0).abs() < 1e-6, "{rows:?}");
        let a = &rows[0];
        assert!((a.2 - 17.5).abs() < 1e-6);
        assert_eq!((a.1.as_deref(), a.3, a.4), (Some("done"), 20, 1));
        let b = &rows[1];
        assert!((b.2 - 12.5).abs() < 1e-6);
        assert_eq!(
            (b.1.as_deref(), b.3, b.4),
            (None, 15, 0),
            "not done: not clean"
        );
        let c = &rows[2];
        assert_eq!((c.2, c.3, c.4), (0.0, 0, 0));
        // The break shows the run's lanes, none running.
        let s = status(&m, T0 + minutes(31));
        assert_eq!(s.kind, Some(Kind::Break));
        assert!(s.lanes.iter().all(|l| !l.running));
    }

    #[test]
    fn a_task_done_while_sharing_most_of_its_time_is_not_clean() {
        let conn = run_db();
        let mut m = Machine::default();
        start_run(&conn, &mut m, &["a", "b"], 20);
        step(&conn, &mut m, lane("b"), T0);
        step(
            &conn,
            &mut m,
            Event::LaneDone {
                task_id: "b".into(),
            },
            T0 + minutes(10),
        );
        step(&conn, &mut m, Event::Stop, T0 + minutes(12));
        // b: 0-10 shared with a = 5 min effort, 0 alone.
        let rows = run_rows(&conn);
        assert!((rows[1].2 - 5.0).abs() < 1e-6);
        assert_eq!((rows[1].1.as_deref(), rows[1].4), (Some("done"), 0));
        // Stop closed a's span at the stop.
        let end: i64 = conn
            .query_row(
                "SELECT end_at FROM focus_lane_spans WHERE task_id = 'a'",
                [],
                |r| r.get(0),
            )
            .expect("end");
        assert_eq!(end, T0 + minutes(12));
    }

    #[test]
    fn a_run_slept_through_closes_its_spans_at_its_end() {
        let conn = run_db();
        let mut m = Machine::default();
        start_run(&conn, &mut m, &["a"], 25);
        step(&conn, &mut m, Event::Tick, T0 + minutes(25 + 31));
        let (end, kind): (i64, String) = conn
            .query_row(
                "SELECT end_at, end_kind FROM focus_lane_spans WHERE task_id = 'a'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .expect("span");
        assert_eq!((end, kind.as_str()), (T0 + minutes(25), "run_end"));
        assert_eq!(run_rows(&conn)[0].3, 25);
    }

    #[test]
    fn a_restart_keeps_the_lanes_their_time_and_what_is_done() {
        let conn = run_db();
        let mut m = Machine::default();
        start_run(&conn, &mut m, &["a", "b", "c"], 30);
        step(&conn, &mut m, lane("b"), T0 + minutes(2));
        step(
            &conn,
            &mut m,
            Event::LanePause {
                task_id: "a".into(),
            },
            T0 + minutes(4),
        );
        step(
            &conn,
            &mut m,
            Event::LaneDone {
                task_id: "c".into(),
            },
            T0 + minutes(5),
        );
        let restored = restore(&conn, T0 + minutes(10)).expect("restore");
        assert_eq!(
            status(&restored, T0 + minutes(10)),
            status(&m, T0 + minutes(10))
        );
        let session = restored.current.expect("session");
        assert_eq!(session.title, "Login bug +2");
        assert_eq!(session.lanes, m.current.expect("live").lanes);
        // And the lanes keep working after the restart.
        let mut restored = restore(&conn, T0 + minutes(10)).expect("again");
        step(&conn, &mut restored, Event::Tick, T0 + minutes(30));
        let effort: f64 = run_rows(&conn).iter().map(|r| r.2).sum();
        assert!((effort - 30.0).abs() < 1e-6);
        // A break restored after a restart shows the run's lanes, none running.
        let on_break = restore(&conn, T0 + minutes(31)).expect("break");
        let s = status(&on_break, T0 + minutes(31));
        assert_eq!(s.kind, Some(Kind::Break));
        assert_eq!(s.lanes.len(), 3);
        assert!(s.lanes.iter().all(|l| !l.running));
        assert!(s.lanes[2].done);
    }

    #[test]
    fn lanes_wait_while_on_a_break_and_plus_five_carries_them() {
        let conn = run_db();
        let mut m = Machine::default();
        start_run(&conn, &mut m, &["a", "b"], 25);
        step(&conn, &mut m, Event::Tick, T0 + minutes(25));
        assert!(m.handle(lane("b"), T0 + minutes(26)).is_empty());
        step(
            &conn,
            &mut m,
            Event::Extend { id: "x1".into() },
            T0 + minutes(26),
        );
        let session = m.current.clone().expect("extension");
        assert_eq!(session.run_of.as_deref(), Some("r1"));
        assert_eq!(session.lanes.len(), 2);
        step(&conn, &mut m, lane("b"), T0 + minutes(27));
        step(&conn, &mut m, Event::Tick, T0 + minutes(31));
        let effort: f64 = conn
            .query_row(
                "SELECT SUM(effort_min) FROM focus_run_tasks WHERE session_id = 'x1'",
                [],
                |r| r.get(0),
            )
            .expect("effort");
        assert!((effort - 5.0).abs() < 1e-6);
    }

    #[test]
    fn a_block_session_is_a_run_of_its_task_and_an_area_session_has_none() {
        let conn = run_db();
        conn.execute_batch(
            "INSERT INTO day_blocks (id, logical_date, start_at, end_at, kind, area_id, task_id, title, created_at, updated_at)
             VALUES ('b1', '2026-11-11', 0, 1, 'area', 'joba', 'a', 'Login bug', 0, 0),
                    ('b2', '2026-11-11', 0, 1, 'area', 'coding', NULL, 'Coding skills', 0, 0);",
        )
        .expect("blocks");
        let block = context_for(&conn, Some("b1")).expect("block");
        assert_eq!(
            block
                .lanes
                .iter()
                .map(|l| l.task_id.as_str())
                .collect::<Vec<_>>(),
            ["a"]
        );
        assert!(
            context_for(&conn, Some("b2"))
                .expect("no task")
                .lanes
                .is_empty()
        );
        assert!(
            context_for_target(&conn, None, Some("coding"))
                .expect("area")
                .lanes
                .is_empty()
        );
        let mut m = Machine::default();
        step(
            &conn,
            &mut m,
            Event::Start {
                context: block,
                force: false,
                id: "r1".into(),
            },
            T0,
        );
        step(&conn, &mut m, Event::Stop, T0 + minutes(20));
        let rows = run_rows(&conn);
        assert_eq!(rows.len(), 1);
        assert!((rows[0].2 - 20.0).abs() < 1e-6);
        assert_eq!(m.current, None);
    }

    #[test]
    fn solo_time_counts_only_pieces_with_one_lane_running() {
        let spans = vec![
            ("a".to_string(), 0, 30),
            ("b".to_string(), 10, 20),
            ("c".to_string(), 25, 50),
        ];
        let solo = solo_ms(&spans, 0, 40);
        assert_eq!(solo.get("a"), Some(&15));
        assert_eq!(solo.get("b"), None);
        assert_eq!(solo.get("c"), Some(&10));
    }
}
