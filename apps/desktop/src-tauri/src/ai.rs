//! The AI gate (plan §7.1, §7.5; R-AI-02, R-AI-05, R-PLT-04). Every model
//! call goes through here:
//! - the Gemini key comes from Credential Manager and travels only in a
//!   request header, never in a URL, the log, the database or the webview;
//! - only `generativelanguage.googleapis.com` is ever called;
//! - one request per 7 s; a daily cap counted by the Pacific date the free
//!   tier resets on; 429s honour `RetryInfo`, else 2 retries with backoff;
//!   3 failed calls in a row → plain mode for 10 minutes;
//! - each request and reply is logged in `core_ai_calls` for 30 days.
//!
//! The webview builds the request body (TS task modules, T-037); Rust only
//! sends it. Nothing here runs in the background.

use std::sync::OnceLock;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use rusqlite::{Connection, params};
use serde::Serialize;
use serde_json::Value;

pub const HOST: &str = "generativelanguage.googleapis.com";
pub const KEY_NAME: &str = "gemini_api_key";
pub const PACE: Duration = Duration::from_secs(7);
pub const DEFAULT_DAILY_CAP: i64 = 15;
pub const DAILY_CAP_KEY: &str = "ai.daily_cap";
pub const MODEL_KEY: &str = "ai.model";
pub const KEEP_DAYS: i64 = 30;
const MAX_RETRIES: u32 = 2;
/// A RetryInfo delay longer than this is not waited out; the call fails.
const MAX_RETRY_WAIT: Duration = Duration::from_secs(20);
const PLAIN_AFTER_FAILURES: u32 = 3;
const PLAIN_FOR: Duration = Duration::from_secs(10 * 60);
const TIMEOUT: Duration = Duration::from_secs(30);
const DAY_MS: i64 = 86_400_000;

// --- Pure helpers ---------------------------------------------------------

/// A model id from the models list ("gemini-3.5-flash-lite"); nothing that
/// could change the path or the host.
pub fn valid_model(id: &str) -> bool {
    let id = id.strip_prefix("models/").unwrap_or(id);
    !id.is_empty()
        && id.len() <= 80
        && id.chars().next().is_some_and(|c| c.is_ascii_alphanumeric())
        && id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '-' | '.' | '_'))
}

pub fn generate_url(model: &str) -> String {
    let id = model.strip_prefix("models/").unwrap_or(model);
    format!("https://{HOST}/v1beta/models/{id}:generateContent")
}

pub fn models_url() -> String {
    format!("https://{HOST}/v1beta/models?pageSize=100")
}

/// The gate only ever calls the Gemini API host over HTTPS.
pub fn allowed_url(url: &str) -> bool {
    url.strip_prefix("https://")
        .and_then(|rest| rest.split('/').next())
        .is_some_and(|host| host == HOST)
}

/// Days since 1970-01-01 → (year, month, day), proleptic Gregorian.
fn civil(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (yoe + era * 400 + i64::from(month <= 2), month, day)
}

/// Day number of (year, month, day).
fn days_from_civil(year: i64, month: u32, day: u32) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let m = i64::from(month);
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + i64::from(day) - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// The nth Sunday (1-based) of a month, as a day number.
fn nth_sunday(year: i64, month: u32, n: i64) -> i64 {
    let first = days_from_civil(year, month, 1);
    // 1970-01-01 was a Thursday; Sunday = 0.
    let weekday = (first + 4).rem_euclid(7);
    first + (7 - weekday) % 7 + 7 * (n - 1)
}

/// US Pacific time: UTC−7 from the 2nd Sunday of March 02:00 to the 1st
/// Sunday of November 02:00 (local), else UTC−8.
pub fn pacific_offset_ms(now_ms: i64) -> i64 {
    let (year, _, _) = civil((now_ms - 8 * 3_600_000).div_euclid(DAY_MS));
    let start = nth_sunday(year, 3, 2) * DAY_MS + 10 * 3_600_000; // 02:00 PST = 10:00 UTC
    let end = nth_sunday(year, 11, 1) * DAY_MS + 9 * 3_600_000; // 02:00 PDT = 09:00 UTC
    if now_ms >= start && now_ms < end {
        -7 * 3_600_000
    } else {
        -8 * 3_600_000
    }
}

/// The date the free tier's daily quota is counted by.
pub fn pacific_date(now_ms: i64) -> String {
    let (year, month, day) = civil((now_ms + pacific_offset_ms(now_ms)).div_euclid(DAY_MS));
    format!("{year:04}-{month:02}-{day:02}")
}

/// `RetryInfo.retryDelay` ("34s", "1.5s") from a Google error body.
pub fn retry_delay(body: &str) -> Option<Duration> {
    let json: Value = serde_json::from_str(body).ok()?;
    json.pointer("/error/details")?
        .as_array()?
        .iter()
        .filter(|detail| {
            detail
                .get("@type")
                .and_then(Value::as_str)
                .is_some_and(|kind| kind.ends_with("google.rpc.RetryInfo"))
        })
        .find_map(|detail| detail.get("retryDelay")?.as_str())
        .and_then(|text| text.strip_suffix('s')?.parse::<f64>().ok())
        .filter(|seconds| seconds.is_finite() && *seconds >= 0.0)
        .map(Duration::from_secs_f64)
}

/// Takes the key out of any text that leaves the gate (errors, logs).
pub fn scrub(text: &str, key: &str) -> String {
    if key.len() < 8 {
        return text.to_string();
    }
    text.replace(key, "[key]")
}

/// Keeps a logged error short.
fn short(text: &str) -> String {
    let mut text = text.trim().to_string();
    if text.len() > 600 {
        let mut cut = 600;
        while !text.is_char_boundary(cut) {
            cut -= 1;
        }
        text.truncate(cut);
        text.push('…');
    }
    text
}

// --- Pacing and plain mode ------------------------------------------------

#[derive(Default)]
pub struct Gate {
    next_free: Option<Instant>,
    failures: u32,
    plain_until: Option<Instant>,
    /// Requests reserved but not logged yet, so calls made together can't
    /// pass the daily cap on the same stale count.
    in_flight: i64,
}

impl Gate {
    /// Reserves one request against today's count (`used` logged so far) and
    /// returns how long to wait before sending it. Err in plain mode or when
    /// the cap is reached. Every Ok must be followed by `release` once the
    /// request is logged.
    pub fn reserve(&mut self, now: Instant, used: i64, cap: i64) -> Result<Duration, Refusal> {
        if let Some(until) = self.plain_until {
            if now < until {
                return Err(Refusal::PlainMode((until - now).as_secs()));
            }
            self.plain_until = None;
        }
        if used + self.in_flight >= cap {
            return Err(Refusal::Budget(cap));
        }
        self.in_flight += 1;
        let at = self.next_free.map_or(now, |free| free.max(now));
        self.next_free = Some(at + PACE);
        Ok(at - now)
    }

    pub fn release(&mut self) {
        self.in_flight = (self.in_flight - 1).max(0);
    }

    pub fn succeeded(&mut self) {
        self.failures = 0;
    }

    pub fn failed(&mut self, now: Instant) {
        self.failures += 1;
        if self.failures >= PLAIN_AFTER_FAILURES {
            self.failures = 0;
            self.plain_until = Some(now + PLAIN_FOR);
        }
    }
}

/// Gives a reserved request back to the gate, whichever way the attempt ends.
struct Slot<'a>(&'a Mutex<Gate>);

impl Drop for Slot<'_> {
    fn drop(&mut self) {
        self.0.lock().release();
    }
}

fn gate() -> &'static Mutex<Gate> {
    static GATE: OnceLock<Mutex<Gate>> = OnceLock::new();
    GATE.get_or_init(|| Mutex::new(Gate::default()))
}

/// Why a call wasn't made or failed. The webview shows the template text for
/// every one of these (R-AI-01); the codes before ':' are stable.
#[derive(Debug, PartialEq)]
pub enum Refusal {
    NoKey,
    BadModel,
    Budget(i64),
    PlainMode(u64),
    RateLimited(u64),
    Http(u16, String),
    Network(String),
}

impl Refusal {
    pub fn code(&self) -> String {
        match self {
            Refusal::NoKey => "no-key".into(),
            Refusal::BadModel => "bad-model".into(),
            Refusal::Budget(cap) => format!("budget:{cap}"),
            Refusal::PlainMode(seconds) => format!("plain-mode:{seconds}"),
            Refusal::RateLimited(seconds) => format!("rate-limited:{seconds}"),
            Refusal::Http(status, message) => format!("http:{status}:{message}"),
            Refusal::Network(message) => format!("network:{message}"),
        }
    }
}

// --- Budget and log ---------------------------------------------------------

/// Requests sent on a quota day (each HTTP attempt counts).
pub fn used_on(conn: &Connection, quota_day: &str) -> i64 {
    conn.query_row(
        "SELECT count(*) FROM core_ai_calls WHERE quota_day = ?1 AND task != 'models'",
        [quota_day],
        |row| row.get(0),
    )
    .unwrap_or(0)
}

pub fn daily_cap(conn: &Connection) -> i64 {
    conn.query_row(
        "SELECT value_json FROM core_settings WHERE key = ?1",
        [DAILY_CAP_KEY],
        |row| row.get::<_, String>(0),
    )
    .ok()
    .and_then(|json| json.trim().parse::<i64>().ok())
    .filter(|cap| *cap >= 0)
    .unwrap_or(DEFAULT_DAILY_CAP)
}

pub struct CallRow<'a> {
    pub task: &'a str,
    pub model: &'a str,
    pub prompt_version: Option<&'a str>,
    pub started_at: i64,
    pub latency_ms: i64,
    pub tokens_in: Option<i64>,
    pub tokens_out: Option<i64>,
    pub status: &'a str,
    pub http_status: Option<u16>,
    pub error: Option<String>,
    pub request: &'a str,
    pub response: Option<String>,
}

/// Logs one request and drops rows older than 30 days.
pub fn log_call(conn: &Connection, row: &CallRow<'_>) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO core_ai_calls (task, model, prompt_version, started_at, latency_ms, quota_day,
           tokens_in, tokens_out, status, http_status, error, request_redacted, response_text)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
        params![
            row.task,
            row.model,
            row.prompt_version,
            row.started_at,
            row.latency_ms,
            pacific_date(row.started_at),
            row.tokens_in,
            row.tokens_out,
            row.status,
            row.http_status,
            row.error,
            row.request,
            row.response,
        ],
    )?;
    conn.execute(
        "DELETE FROM core_ai_calls WHERE started_at < ?1",
        [row.started_at - KEEP_DAYS * DAY_MS],
    )?;
    Ok(())
}

// --- Sending ----------------------------------------------------------------

#[derive(Debug, Serialize, PartialEq)]
pub struct Reply {
    /// The model's text (the JSON the task asked for).
    pub text: String,
    pub tokens_in: Option<i64>,
    pub tokens_out: Option<i64>,
    pub latency_ms: i64,
}

/// The first candidate's text and the token counts from a generateContent reply.
pub fn read_reply(body: &Value) -> Option<(String, Option<i64>, Option<i64>)> {
    let parts = body.pointer("/candidates/0/content/parts")?.as_array()?;
    let text: String = parts
        .iter()
        .filter_map(|part| part.get("text").and_then(Value::as_str))
        .collect();
    let tokens = |name: &str| {
        body.pointer(&format!("/usageMetadata/{name}"))
            .and_then(Value::as_i64)
    };
    Some((
        text,
        tokens("promptTokenCount"),
        tokens("candidatesTokenCount"),
    ))
}

/// One HTTP attempt's outcome.
pub enum Attempt {
    Ok(Value),
    Status(u16, String),
    Network(String),
}

/// No redirects (a redirect would carry the key header to another host) and
/// HTTPS only.
fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout(TIMEOUT)
        .redirects(0)
        .https_only(true)
        .build()
}

/// Sends one request. The key goes in `x-goog-api-key`, never in the URL.
fn post(url: &str, key: &str, body: &Value) -> Attempt {
    if !allowed_url(url) {
        return Attempt::Network("blocked host".into());
    }
    let agent = agent();
    match agent
        .post(url)
        .set("x-goog-api-key", key)
        .set("content-type", "application/json")
        .send_json(body.clone())
    {
        Ok(response) => match response.into_json::<Value>() {
            Ok(json) => Attempt::Ok(json),
            Err(error) => Attempt::Network(scrub(&error.to_string(), key)),
        },
        Err(ureq::Error::Status(status, response)) => Attempt::Status(
            status,
            scrub(&response.into_string().unwrap_or_default(), key),
        ),
        Err(error) => Attempt::Network(scrub(&error.to_string(), key)),
    }
}

fn get(url: &str, key: &str) -> Attempt {
    if !allowed_url(url) {
        return Attempt::Network("blocked host".into());
    }
    let agent = agent();
    match agent.get(url).set("x-goog-api-key", key).call() {
        Ok(response) => match response.into_json::<Value>() {
            Ok(json) => Attempt::Ok(json),
            Err(error) => Attempt::Network(scrub(&error.to_string(), key)),
        },
        Err(ureq::Error::Status(status, response)) => Attempt::Status(
            status,
            scrub(&response.into_string().unwrap_or_default(), key),
        ),
        Err(error) => Attempt::Network(scrub(&error.to_string(), key)),
    }
}

/// Google's own error message, if the body has one.
fn error_message(body: &str) -> String {
    serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|json| json.pointer("/error/message")?.as_str().map(str::to_string))
        .unwrap_or_else(|| body.to_string())
}

pub struct Request<'a> {
    pub task: &'a str,
    pub model: &'a str,
    pub prompt_version: Option<&'a str>,
    pub body: &'a Value,
}

/// Everything the gate needs from the app, so the loop can be tested
/// without the network, the clock or Credential Manager.
pub trait Env {
    fn key(&self) -> Option<String>;
    fn now_ms(&self) -> i64;
    fn sleep(&self, duration: Duration);
    fn send(&self, url: &str, key: &str, body: &Value) -> Attempt;
    fn with_db<T>(&self, run: impl FnOnce(&Connection) -> T) -> T;
}

/// The whole gate: key, model check, budget, pacing, retries, log.
pub fn send(env: &impl Env, gate: &Mutex<Gate>, request: &Request<'_>) -> Result<Reply, Refusal> {
    let key = env
        .key()
        .filter(|key| !key.trim().is_empty())
        .ok_or(Refusal::NoKey)?;
    if !valid_model(request.model) {
        return Err(Refusal::BadModel);
    }
    let url = generate_url(request.model);
    let logged = request.body.to_string();
    let mut attempt = 0;
    loop {
        let (used, cap) =
            env.with_db(|conn| (used_on(conn, &pacific_date(env.now_ms())), daily_cap(conn)));
        let wait = gate.lock().reserve(Instant::now(), used, cap)?;
        // Released when this attempt is over (logged, so `used` counts it).
        let _slot = Slot(gate);
        if !wait.is_zero() {
            env.sleep(wait);
        }
        let started = env.now_ms();
        let outcome = env.send(&url, &key, request.body);
        let latency_ms = env.now_ms() - started;
        let row = |status: &'static str,
                   http: Option<u16>,
                   error: Option<String>,
                   response: Option<String>,
                   tokens: (Option<i64>, Option<i64>)| CallRow {
            task: request.task,
            model: request.model,
            prompt_version: request.prompt_version,
            started_at: started,
            latency_ms,
            tokens_in: tokens.0,
            tokens_out: tokens.1,
            status,
            http_status: http,
            error,
            request: &logged,
            response,
        };
        let (retry_after, refusal) = match outcome {
            Attempt::Ok(json) => {
                let Some((text, tokens_in, tokens_out)) = read_reply(&json) else {
                    let message = short(&scrub(&json.to_string(), &key));
                    env.with_db(|conn| {
                        log_call(
                            conn,
                            &row(
                                "error",
                                Some(200),
                                Some("no text in reply".into()),
                                Some(message.clone()),
                                (None, None),
                            ),
                        )
                    })
                    .unwrap_or_else(|error| log::warn!("could not log an AI call: {error}"));
                    gate.lock().failed(Instant::now());
                    return Err(Refusal::Http(200, "no text in reply".into()));
                };
                env.with_db(|conn| {
                    log_call(
                        conn,
                        &row(
                            "ok",
                            Some(200),
                            None,
                            Some(scrub(&text, &key)),
                            (tokens_in, tokens_out),
                        ),
                    )
                })
                .unwrap_or_else(|error| log::warn!("could not log an AI call: {error}"));
                gate.lock().succeeded();
                return Ok(Reply {
                    text,
                    tokens_in,
                    tokens_out,
                    latency_ms,
                });
            }
            Attempt::Status(429, body) => {
                let delay = retry_delay(&body);
                env.with_db(|conn| {
                    log_call(
                        conn,
                        &row(
                            "rate_limited",
                            Some(429),
                            Some(short(&error_message(&body))),
                            None,
                            (None, None),
                        ),
                    )
                })
                .unwrap_or_else(|error| log::warn!("could not log an AI call: {error}"));
                let seconds = delay.map_or(0, |d| d.as_secs());
                (
                    delay.or(Some(backoff(attempt))),
                    Refusal::RateLimited(seconds),
                )
            }
            Attempt::Status(status, body) => {
                let message = short(&error_message(&body));
                env.with_db(|conn| {
                    log_call(
                        conn,
                        &row(
                            "error",
                            Some(status),
                            Some(message.clone()),
                            None,
                            (None, None),
                        ),
                    )
                })
                .unwrap_or_else(|error| log::warn!("could not log an AI call: {error}"));
                // Client errors (bad model, bad schema, bad key) don't get better on retry.
                let retry = (500..600).contains(&status).then(|| backoff(attempt));
                (retry, Refusal::Http(status, message))
            }
            Attempt::Network(message) => {
                let message = short(&message);
                env.with_db(|conn| {
                    log_call(
                        conn,
                        &row("error", None, Some(message.clone()), None, (None, None)),
                    )
                })
                .unwrap_or_else(|error| log::warn!("could not log an AI call: {error}"));
                (Some(backoff(attempt)), Refusal::Network(message))
            }
        };
        match retry_after {
            Some(delay) if attempt < MAX_RETRIES && delay <= MAX_RETRY_WAIT => {
                attempt += 1;
                env.sleep(delay);
            }
            _ => {
                gate.lock().failed(Instant::now());
                return Err(refusal);
            }
        }
    }
}

fn backoff(attempt: u32) -> Duration {
    Duration::from_secs(2u64.pow(attempt + 1)) // 2 s, then 4 s
}

/// Model ids that can generate content, for picking at key entry (T-037).
pub fn read_models(body: &Value) -> Vec<Model> {
    body.get("models")
        .and_then(Value::as_array)
        .map(|models| {
            models
                .iter()
                .filter(|model| {
                    model
                        .get("supportedGenerationMethods")
                        .and_then(Value::as_array)
                        .is_some_and(|methods| methods.iter().any(|m| m == "generateContent"))
                })
                .filter_map(|model| {
                    let name = model.get("name")?.as_str()?;
                    let id = name.strip_prefix("models/").unwrap_or(name);
                    valid_model(id).then(|| Model {
                        id: id.to_string(),
                        label: model
                            .get("displayName")
                            .and_then(Value::as_str)
                            .unwrap_or(id)
                            .to_string(),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

#[derive(Debug, Serialize, PartialEq)]
pub struct Model {
    pub id: String,
    pub label: String,
}

// --- The app's environment --------------------------------------------------

pub struct AppEnv<'a> {
    pub db: &'a crate::db::Db,
}

impl Env for AppEnv<'_> {
    fn key(&self) -> Option<String> {
        crate::secrets::get(KEY_NAME).ok()
    }
    fn now_ms(&self) -> i64 {
        crate::clock::now_ms()
    }
    fn sleep(&self, duration: Duration) {
        std::thread::sleep(duration);
    }
    fn send(&self, url: &str, key: &str, body: &Value) -> Attempt {
        post(url, key, body)
    }
    fn with_db<T>(&self, run: impl FnOnce(&Connection) -> T) -> T {
        run(&self.db.write.lock())
    }
}

pub fn send_now(db: &crate::db::Db, request: &Request<'_>) -> Result<Reply, Refusal> {
    send(&AppEnv { db }, gate(), request)
}

/// Lists models (no budget: it isn't a generate call, but it is logged).
pub fn list_models(db: &crate::db::Db) -> Result<Vec<Model>, Refusal> {
    let key = crate::secrets::get(KEY_NAME)
        .ok()
        .filter(|key| !key.trim().is_empty())
        .ok_or(Refusal::NoKey)?;
    let started = crate::clock::now_ms();
    let outcome = get(&models_url(), &key);
    let latency_ms = crate::clock::now_ms() - started;
    let (status, http, error, result) = match outcome {
        Attempt::Ok(json) => ("ok", Some(200), None, Ok(read_models(&json))),
        Attempt::Status(status, body) => {
            let message = short(&error_message(&body));
            (
                "error",
                Some(status),
                Some(message.clone()),
                Err(Refusal::Http(status, message)),
            )
        }
        Attempt::Network(message) => (
            "error",
            None,
            Some(short(&message)),
            Err(Refusal::Network(message)),
        ),
    };
    let row = CallRow {
        task: "models",
        model: "-",
        prompt_version: None,
        started_at: started,
        latency_ms,
        tokens_in: None,
        tokens_out: None,
        status,
        http_status: http,
        error,
        request: "GET models",
        response: None,
    };
    if let Err(error) = log_call(&db.write.lock(), &row) {
        log::warn!("could not log an AI call: {error}");
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    const KEY: &str = "AIzaTEST-secret-key-123456";

    fn utc(text: &str) -> i64 {
        // "2026-11-11T09:00" in UTC
        let (date, time) = text.split_once('T').unwrap();
        let parts: Vec<i64> = date.split('-').map(|p| p.parse().unwrap()).collect();
        let (h, m) = time.split_once(':').unwrap();
        days_from_civil(parts[0], parts[1] as u32, parts[2] as u32) * DAY_MS
            + h.parse::<i64>().unwrap() * 3_600_000
            + m.parse::<i64>().unwrap() * 60_000
    }

    #[test]
    fn pacific_dates_follow_us_summer_time() {
        // Winter: midnight Pacific is 08:00 UTC (11:00 in Addis).
        assert_eq!(pacific_date(utc("2026-11-11T07:59")), "2026-11-10");
        assert_eq!(pacific_date(utc("2026-11-11T08:00")), "2026-11-11");
        // Summer: midnight Pacific is 07:00 UTC (10:00 in Addis).
        assert_eq!(pacific_date(utc("2026-07-01T06:59")), "2026-06-30");
        assert_eq!(pacific_date(utc("2026-07-01T07:00")), "2026-07-01");
        // 2026: summer time 8 Mar 10:00 UTC to 1 Nov 09:00 UTC.
        assert_eq!(pacific_offset_ms(utc("2026-03-08T09:59")), -8 * 3_600_000);
        assert_eq!(pacific_offset_ms(utc("2026-03-08T10:00")), -7 * 3_600_000);
        assert_eq!(pacific_offset_ms(utc("2026-11-01T08:59")), -7 * 3_600_000);
        assert_eq!(pacific_offset_ms(utc("2026-11-01T09:00")), -8 * 3_600_000);
        assert_eq!(civil(days_from_civil(2028, 2, 29)), (2028, 2, 29));
    }

    #[test]
    fn only_the_gemini_host_and_plain_model_ids() {
        assert!(allowed_url(&generate_url("gemini-3.5-flash-lite")));
        assert!(allowed_url(&models_url()));
        assert!(!allowed_url(
            "https://generativelanguage.googleapis.com.evil.com/x"
        ));
        assert!(!allowed_url("http://generativelanguage.googleapis.com/x"));
        assert!(!allowed_url("https://example.com/"));
        assert!(valid_model("gemini-3.5-flash-lite"));
        assert!(valid_model("models/gemini-3.1-flash-lite"));
        for bad in ["", "../x", "a/b", "x?key=1", "Gemini", "a b", "-x"] {
            assert!(!valid_model(bad), "{bad}");
        }
        assert_eq!(
            generate_url("models/gemini-3.5-flash-lite"),
            "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent"
        );
    }

    #[test]
    fn reads_retry_info() {
        let body = r#"{"error":{"code":429,"status":"RESOURCE_EXHAUSTED","details":[
            {"@type":"type.googleapis.com/google.rpc.QuotaFailure"},
            {"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay":"34s"}]}}"#;
        assert_eq!(retry_delay(body), Some(Duration::from_secs(34)));
        assert_eq!(
            retry_delay(
                r#"{"error":{"details":[{"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay":"1.5s"}]}}"#
            ),
            Some(Duration::from_millis(1500))
        );
        assert_eq!(retry_delay("{}"), None);
        assert_eq!(retry_delay("not json"), None);
    }

    #[test]
    fn paces_and_goes_plain_after_three_failures() {
        let mut gate = Gate::default();
        let t0 = Instant::now();
        assert_eq!(gate.reserve(t0, 0, 99), Ok(Duration::ZERO));
        assert_eq!(gate.reserve(t0, 0, 99), Ok(PACE));
        assert_eq!(
            gate.reserve(t0 + Duration::from_secs(20), 0, 99),
            Ok(Duration::ZERO)
        );
        gate.failed(t0);
        gate.failed(t0);
        gate.succeeded();
        gate.failed(t0);
        gate.failed(t0);
        assert!(
            gate.reserve(t0, 0, 99).is_ok(),
            "a success in between resets the count"
        );
        gate.failed(t0);
        assert!(matches!(
            gate.reserve(t0, 0, 99),
            Err(Refusal::PlainMode(_))
        ));
        assert!(gate.reserve(t0 + PLAIN_FOR, 0, 99).is_ok());
    }

    #[test]
    fn calls_made_together_share_the_cap() {
        let mut gate = Gate::default();
        let t0 = Instant::now();
        // 14 of 15 used: the first call gets the last request, the second gets none.
        assert!(gate.reserve(t0, 14, 15).is_ok());
        assert_eq!(gate.reserve(t0, 14, 15), Err(Refusal::Budget(15)));
        // Once the first is logged (used = 15) and released, still none left.
        gate.release();
        assert_eq!(gate.reserve(t0, 15, 15), Err(Refusal::Budget(15)));
        gate.release();
        gate.release();
        assert!(
            gate.reserve(t0, 0, 15).is_ok(),
            "release never goes below zero"
        );
    }

    struct FakeEnv {
        key: Option<String>,
        replies: RefCell<Vec<Attempt>>,
        sent: RefCell<Vec<(String, String)>>,
        slept: RefCell<Vec<Duration>>,
        conn: Connection,
        now: i64,
    }

    impl FakeEnv {
        fn new(key: Option<&str>, replies: Vec<Attempt>) -> Self {
            let mut conn = Connection::open_in_memory().unwrap();
            crate::db::configure(&conn).unwrap();
            crate::migrate::run(&mut conn, crate::migrate::MIGRATIONS, 0).unwrap();
            Self {
                key: key.map(str::to_string),
                replies: RefCell::new(replies.into_iter().rev().collect()),
                sent: RefCell::default(),
                slept: RefCell::default(),
                conn,
                now: utc("2026-11-11T09:00"),
            }
        }
    }

    impl Env for FakeEnv {
        fn key(&self) -> Option<String> {
            self.key.clone()
        }
        fn now_ms(&self) -> i64 {
            self.now
        }
        fn sleep(&self, duration: Duration) {
            self.slept.borrow_mut().push(duration);
        }
        fn send(&self, url: &str, key: &str, body: &Value) -> Attempt {
            self.sent
                .borrow_mut()
                .push((url.to_string(), format!("{key}|{body}")));
            self.replies
                .borrow_mut()
                .pop()
                .unwrap_or(Attempt::Network("no reply".into()))
        }
        fn with_db<T>(&self, run: impl FnOnce(&Connection) -> T) -> T {
            run(&self.conn)
        }
    }

    fn ok_reply(text: &str) -> Attempt {
        Attempt::Ok(serde_json::json!({
            "candidates": [{"content": {"parts": [{"text": text}]}}],
            "usageMetadata": {"promptTokenCount": 120, "candidatesTokenCount": 30}
        }))
    }

    fn request(body: &Value) -> Request<'_> {
        Request {
            task: "timing",
            model: "gemini-3.5-flash-lite",
            prompt_version: Some("timing@1"),
            body,
        }
    }

    fn dump(conn: &Connection) -> String {
        let mut statement = conn.prepare("SELECT * FROM core_ai_calls").unwrap();
        let columns = statement.column_count();
        let rows = statement
            .query_map([], |row| {
                Ok((0..columns)
                    .map(|i| format!("{:?}", row.get::<_, rusqlite::types::Value>(i).unwrap()))
                    .collect::<Vec<_>>()
                    .join("|"))
            })
            .unwrap();
        rows.map(Result::unwrap).collect::<Vec<_>>().join("\n")
    }

    #[test]
    fn sends_once_and_logs_without_the_key() {
        let env = FakeEnv::new(Some(KEY), vec![ok_reply(r#"{"reasons":["ok"]}"#)]);
        let body = serde_json::json!({"contents": [{"parts": [{"text": "facts"}]}]});
        let gate = Mutex::new(Gate::default());
        let reply = send(&env, &gate, &request(&body)).unwrap();
        assert_eq!(reply.text, r#"{"reasons":["ok"]}"#);
        assert_eq!((reply.tokens_in, reply.tokens_out), (Some(120), Some(30)));
        let sent = env.sent.borrow();
        assert_eq!(sent.len(), 1);
        assert!(!sent[0].0.contains(KEY), "the key never goes in the URL");
        let log = dump(&env.conn);
        assert!(log.contains("timing@1") && log.contains("\"ok\""), "{log}");
        assert!(!log.contains(KEY), "the key never reaches the database");
        assert!(
            !format!("{reply:?}").contains(KEY),
            "nor the reply to the webview"
        );
    }

    #[test]
    fn refuses_without_a_key_or_with_a_bad_model() {
        let body = Value::Null;
        let gate = Mutex::new(Gate::default());
        assert_eq!(
            send(&FakeEnv::new(None, vec![]), &gate, &request(&body)),
            Err(Refusal::NoKey)
        );
        assert_eq!(
            send(&FakeEnv::new(Some(" "), vec![]), &gate, &request(&body)),
            Err(Refusal::NoKey)
        );
        let bad = Request {
            model: "../oops",
            ..request(&body)
        };
        assert_eq!(
            send(&FakeEnv::new(Some(KEY), vec![]), &gate, &bad),
            Err(Refusal::BadModel)
        );
    }

    #[test]
    fn stops_at_the_daily_cap() {
        let env = FakeEnv::new(Some(KEY), vec![ok_reply("a"), ok_reply("b")]);
        env.conn
            .execute("INSERT INTO core_settings (key, value_json, updated_at) VALUES ('ai.daily_cap', '1', 0)", [])
            .unwrap();
        let body = Value::Null;
        let gate = Mutex::new(Gate::default());
        assert!(send(&env, &gate, &request(&body)).is_ok());
        assert_eq!(send(&env, &gate, &request(&body)), Err(Refusal::Budget(1)));
        assert_eq!(env.sent.borrow().len(), 1);
    }

    #[test]
    fn honours_retry_info_then_gives_up() {
        let limited = || {
            Attempt::Status(
                429,
                r#"{"error":{"message":"quota","details":[{"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay":"3s"}]}}"#.into(),
            )
        };
        let env = FakeEnv::new(Some(KEY), vec![limited(), ok_reply("fine")]);
        let body = Value::Null;
        let gate = Mutex::new(Gate::default());
        assert_eq!(send(&env, &gate, &request(&body)).unwrap().text, "fine");
        assert!(env.slept.borrow().contains(&Duration::from_secs(3)));

        let env = FakeEnv::new(
            Some(KEY),
            vec![limited(), limited(), limited(), ok_reply("late")],
        );
        let gate = Mutex::new(Gate::default());
        assert_eq!(
            send(&env, &gate, &request(&body)),
            Err(Refusal::RateLimited(3))
        );
        assert_eq!(env.sent.borrow().len(), 3, "one try and 2 retries");
    }

    #[test]
    fn does_not_retry_client_errors_and_scrubs_echoed_keys() {
        let echoed = format!(r#"{{"error":{{"message":"API key {KEY} not valid"}}}}"#);
        let env = FakeEnv::new(Some(KEY), vec![Attempt::Status(400, scrub(&echoed, KEY))]);
        let body = Value::Null;
        let gate = Mutex::new(Gate::default());
        let refusal = send(&env, &gate, &request(&body)).unwrap_err();
        assert_eq!(env.sent.borrow().len(), 1);
        assert!(!refusal.code().contains(KEY));
        assert!(
            refusal
                .code()
                .starts_with("http:400:API key [key] not valid")
        );
        assert!(!dump(&env.conn).contains(KEY));
    }

    #[test]
    fn retries_server_errors_with_backoff() {
        let env = FakeEnv::new(
            Some(KEY),
            vec![Attempt::Status(503, "{}".into()), ok_reply("up")],
        );
        let body = Value::Null;
        let gate = Mutex::new(Gate::default());
        assert_eq!(send(&env, &gate, &request(&body)).unwrap().text, "up");
        assert!(env.slept.borrow().contains(&Duration::from_secs(2)));
    }

    #[test]
    fn keeps_thirty_days_of_calls() {
        let env = FakeEnv::new(Some(KEY), vec![]);
        let row = |at: i64| CallRow {
            task: "brief",
            model: "m",
            prompt_version: None,
            started_at: at,
            latency_ms: 1,
            tokens_in: None,
            tokens_out: None,
            status: "ok",
            http_status: Some(200),
            error: None,
            request: "{}",
            response: None,
        };
        log_call(&env.conn, &row(env.now - 31 * DAY_MS)).unwrap();
        log_call(&env.conn, &row(env.now)).unwrap();
        let count: i64 = env
            .conn
            .query_row("SELECT count(*) FROM core_ai_calls", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn lists_generate_models_only() {
        let body = serde_json::json!({"models": [
            {"name": "models/gemini-3.5-flash-lite", "displayName": "Gemini 3.5 Flash-Lite", "supportedGenerationMethods": ["generateContent", "countTokens"]},
            {"name": "models/text-embedding-9", "supportedGenerationMethods": ["embedContent"]},
            {"name": "models/../evil", "supportedGenerationMethods": ["generateContent"]}
        ]});
        assert_eq!(
            read_models(&body),
            vec![Model {
                id: "gemini-3.5-flash-lite".into(),
                label: "Gemini 3.5 Flash-Lite".into()
            }]
        );
    }
}
