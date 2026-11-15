//! A toast the evening before a bill is due (T-077; proposal 2.4), shown from
//! review time until the logical day ends, even with no window open. The
//! repeat rule and the "is it paid?" matching are the same as in
//! `src/features/money/regulars.ts` (`occurrences`, `dueItems`), so the toast
//! and the Money page agree.

use rusqlite::{Connection, params};
use serde_json::Value;
use tauri::AppHandle;

use crate::{clock, db::Db, notify, review, session, tasks};
use tauri::Manager;

/// The logical date the toast last showed.
const REMINDED_KEY: &str = "bills.reminded";
/// Money that goes up to this many days early still counts for the date.
const EARLY_DAYS: i64 = 7;
/// Late bills from the end of last month still take payments first.
const LOOK_BACK_DAYS: i64 = 10;

// --- Dates ------------------------------------------------------------------------

fn day_number(date: &str) -> Option<i64> {
    let mut parts = date.splitn(3, '-').map(str::parse::<i64>);
    let (year, month, day) = (
        parts.next()?.ok()?,
        parts.next()?.ok()?,
        parts.next()?.ok()?,
    );
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    Some(crate::ai::days_from_civil(year, month as u32, day as u32))
}

fn shift(date: &str, days: i64) -> String {
    day_number(date).map_or_else(|| date.to_string(), |n| tasks::civil_date(n + days))
}

fn days_in_month(year: i64, month: u32) -> i64 {
    let (next_year, next_month) = if month == 12 {
        (year + 1, 1)
    } else {
        (year, month + 1)
    };
    crate::ai::days_from_civil(next_year, next_month, 1)
        - crate::ai::days_from_civil(year, month, 1)
}

/// 1 = Monday … 7 = Sunday.
fn iso_weekday(day: i64) -> u8 {
    // 1970-01-01 was a Thursday (4).
    ((day + 3).rem_euclid(7) + 1) as u8
}

// --- The repeat rule ----------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
pub enum Rule {
    /// Monthly on a day; 31 means the last day in short months.
    Month(u32),
    /// Weekly on ISO weekdays.
    Week(Vec<u8>),
}

pub fn read_rule(json: &str) -> Option<Rule> {
    let value: Value = serde_json::from_str(json).ok()?;
    match value.get("every")?.as_str()? {
        "month" => Some(Rule::Month(
            u32::try_from(value.get("day")?.as_u64()?).ok()?,
        )),
        "week" => Some(Rule::Week(
            value
                .get("days")?
                .as_array()?
                .iter()
                .filter_map(|day| day.as_u64().and_then(|d| u8::try_from(d).ok()))
                .collect(),
        )),
        _ => None,
    }
}

/// Every date the rule falls on, from `from` to `to` (inclusive).
pub fn occurrences(rule: &Rule, from: &str, to: &str) -> Vec<String> {
    let (Some(start), Some(end)) = (day_number(from), day_number(to)) else {
        return Vec::new();
    };
    let mut dates = Vec::new();
    match rule {
        Rule::Month(day) => {
            let (mut year, mut month) = {
                let first = tasks::civil_date(start);
                (
                    first[0..4].parse::<i64>().unwrap_or(1970),
                    first[5..7].parse::<u32>().unwrap_or(1),
                )
            };
            while crate::ai::days_from_civil(year, month, 1) <= end {
                let last = days_in_month(year, month);
                let on = i64::from(*day).min(last).max(1);
                let n = crate::ai::days_from_civil(year, month, 1) + on - 1;
                if n >= start && n <= end {
                    dates.push(tasks::civil_date(n));
                }
                (year, month) = if month == 12 {
                    (year + 1, 1)
                } else {
                    (year, month + 1)
                };
            }
        }
        Rule::Week(days) => {
            for n in start..=end {
                if days.contains(&iso_weekday(n)) {
                    dates.push(tasks::civil_date(n));
                }
            }
        }
    }
    dates
}

// --- Bills and payments --------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct Bill {
    pub id: String,
    pub name: String,
    pub amount: i64,
    pub rule_json: String,
    pub category_id: Option<String>,
    /// The logical date you added it: earlier occurrences aren't asked about.
    pub since: String,
}

#[derive(Debug, Clone)]
pub struct Txn {
    pub regular_id: Option<String>,
    pub due_date: Option<String>,
    pub amount: i64,
    pub local_date: String,
    pub description: Option<String>,
    pub category_id: Option<String>,
}

/// An expense you typed that is this bill: its name in the words, or its category and amount.
fn pays_bill(bill: &Bill, txn: &Txn) -> bool {
    if txn.amount >= 0 {
        return false;
    }
    let name = bill.name.trim().to_lowercase();
    let words = txn
        .description
        .as_deref()
        .unwrap_or("")
        .trim()
        .to_lowercase();
    if !name.is_empty() && !words.is_empty() && (words.contains(&name) || name.contains(&words)) {
        return true;
    }
    bill.category_id.is_some() && txn.category_id == bill.category_id && -txn.amount == bill.amount
}

/// The window to load for `tomorrow`: from a little before its month, to it.
pub fn window(tomorrow: &str) -> (String, String) {
    let month_start = format!("{}-01", &tomorrow[..7.min(tomorrow.len())]);
    (shift(&month_start, -LOOK_BACK_DAYS), tomorrow.to_string())
}

/// Bills due on `tomorrow` that aren't paid yet, with what is left of each.
/// Payments are handed out in date order to the oldest open date they fit,
/// as on the Money page, so paying last month's late rent doesn't count for
/// tomorrow's.
pub fn due_tomorrow(bills: &[Bill], txns: &[Txn], tomorrow: &str) -> Vec<(String, i64)> {
    struct Item<'a> {
        bill: &'a Bill,
        date: String,
        done: i64,
    }
    let (from, to) = window(tomorrow);
    let mut items: Vec<Item> = Vec::new();
    for bill in bills {
        let Some(rule) = read_rule(&bill.rule_json) else {
            continue;
        };
        let start = if bill.since > from {
            bill.since.clone()
        } else {
            from.clone()
        };
        for date in occurrences(&rule, &start, &to) {
            let done = txns
                .iter()
                .filter(|txn| {
                    txn.regular_id.as_deref() == Some(bill.id.as_str())
                        && txn.due_date.as_deref() == Some(date.as_str())
                })
                .map(|txn| txn.amount.abs())
                .sum();
            items.push(Item { bill, date, done });
        }
    }
    items.sort_by(|a, b| {
        a.date
            .cmp(&b.date)
            .then_with(|| a.bill.name.cmp(&b.bill.name))
    });
    let open = |item: &Item| (item.bill.amount - item.done).max(0);

    let mut free: Vec<&Txn> = txns.iter().filter(|txn| txn.regular_id.is_none()).collect();
    free.sort_by(|a, b| a.local_date.cmp(&b.local_date));
    for txn in free {
        let mut amount = txn.amount.abs();
        let latest = shift(&txn.local_date, EARLY_DAYS);
        for item in &mut items {
            if amount == 0 {
                break;
            }
            if item.date > latest || open(item) == 0 || !pays_bill(item.bill, txn) {
                continue;
            }
            let take = open(item).min(amount);
            item.done += take;
            amount -= take;
        }
    }

    items
        .iter()
        .filter(|item| item.date == tomorrow && open(item) > 0)
        .map(|item| (item.bill.name.clone(), open(item)))
        .collect()
}

/// "6,000 ETB", "1,250.50 ETB".
pub fn format_amount(santim: i64) -> String {
    let sign = if santim < 0 { "-" } else { "" };
    let abs = santim.unsigned_abs();
    let birr = (abs / 100).to_string();
    let mut grouped = String::new();
    for (index, digit) in birr.chars().enumerate() {
        if index > 0 && (birr.len() - index).is_multiple_of(3) {
            grouped.push(',');
        }
        grouped.push(digit);
    }
    let rest = abs % 100;
    let fraction = if rest == 0 {
        String::new()
    } else {
        format!(".{rest:02}")
    };
    format!("{sign}{grouped}{fraction} ETB")
}

pub fn toast_text(due: &[(String, i64)]) -> String {
    due.iter()
        .map(|(name, left)| format!("{name} {}", format_amount(*left)))
        .collect::<Vec<_>>()
        .join(" · ")
}

// --- Reading -----------------------------------------------------------------------

const BILLS_SQL: &str = "SELECT id, name, amount_minor, rule_json, category_id, created_at
     FROM money_regulars WHERE deleted_at IS NULL AND active = 1 AND kind = 'bill'";

/// The same rows as REGULAR_TXNS_SQL in regulars.ts.
const TXNS_SQL: &str =
    "SELECT regular_id, due_date, amount_minor, local_date, description, category_id
     FROM money_txns
     WHERE deleted_at IS NULL AND transfer_id IS NULL
       AND ((regular_id IS NOT NULL AND due_date >= ?1 AND due_date <= ?2)
         OR (regular_id IS NULL AND local_date >= ?1 AND local_date <= ?2))";

pub fn load(conn: &Connection, tomorrow: &str) -> rusqlite::Result<Vec<(String, i64)>> {
    let bills = conn
        .prepare(BILLS_SQL)?
        .query_map([], |row| {
            Ok(Bill {
                id: row.get(0)?,
                name: row.get(1)?,
                amount: row.get(2)?,
                rule_json: row.get(3)?,
                category_id: row.get(4)?,
                since: tasks::logical_day(row.get::<_, i64>(5)?).0,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    if bills.is_empty() {
        return Ok(Vec::new());
    }
    let (from, to) = window(tomorrow);
    let txns = conn
        .prepare(TXNS_SQL)?
        .query_map(params![from, to], |row| {
            Ok(Txn {
                regular_id: row.get(0)?,
                due_date: row.get(1)?,
                amount: row.get(2)?,
                local_date: row.get(3)?,
                description: row.get(4)?,
                category_id: row.get(5)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(due_tomorrow(&bills, &txns, tomorrow))
}

// --- The toast ----------------------------------------------------------------------

/// Called once a minute while the session is unlocked, and at unlock.
pub fn tick(app: &AppHandle) {
    let now = clock::now_ms();
    let (today, _) = tasks::logical_day(now);
    let due = {
        let db = app.state::<Db>();
        let conn = db.write.lock();
        let review_min = review::minutes_setting(&conn, "day.review", review::DEFAULT_REVIEW_MIN);
        let evening = review::logical_minutes(session::local_minutes(now))
            >= review::logical_minutes(review_min);
        if !evening
            || crate::db::setting_string(&conn, REMINDED_KEY).as_deref() == Some(today.as_str())
        {
            return;
        }
        match load(&conn, &shift(&today, 1)) {
            Ok(due) => due,
            Err(error) => {
                log::warn!("could not check tomorrow's bills: {error}");
                return;
            }
        }
    };
    if due.is_empty() {
        return;
    }
    review::upsert(
        &mut app.state::<Db>().write.lock(),
        "core_settings",
        REMINDED_KEY,
        "value_json",
        Value::from(format!("\"{today}\"")),
    );
    let handle = app.clone();
    let buttons = [notify::Button {
        label: "Open Money",
        action: "open",
    }];
    let title = if due.len() == 1 {
        "A bill is due tomorrow"
    } else {
        "Bills due tomorrow"
    };
    if let Err(error) = notify::show(app, title, &toast_text(&due), &buttons, move |_| {
        review::open_screen(&handle, "money");
    }) {
        log::error!("could not show the bill toast: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{db, migrate};

    fn bill(id: &str, name: &str, amount: i64, rule: &str) -> Bill {
        Bill {
            id: id.into(),
            name: name.into(),
            amount,
            rule_json: rule.into(),
            category_id: Some("cat_housing".into()),
            since: "2026-01-01".into(),
        }
    }

    fn spend(date: &str, amount: i64, what: &str) -> Txn {
        Txn {
            regular_id: None,
            due_date: None,
            amount: -amount,
            local_date: date.into(),
            description: Some(what.into()),
            category_id: Some("cat_food".into()),
        }
    }

    /// The cases from regulars.test.ts ("falls on the right dates…").
    #[test]
    fn rule_dates_match_typescript() {
        let month31 = read_rule(r#"{"every":"month","day":31}"#).expect("rule");
        assert_eq!(
            occurrences(&month31, "2027-01-15", "2027-04-30"),
            ["2027-01-31", "2027-02-28", "2027-03-31", "2027-04-30"]
        );
        let month10 = read_rule(r#"{"every":"month","day":10}"#).expect("rule");
        assert_eq!(
            occurrences(&month10, "2026-11-11", "2026-12-31"),
            ["2026-12-10"]
        );
        // 2026-11-16 is a Monday.
        let week = read_rule(r#"{"every":"week","days":[1,4]}"#).expect("rule");
        assert_eq!(
            occurrences(&week, "2026-11-16", "2026-11-26"),
            ["2026-11-16", "2026-11-19", "2026-11-23", "2026-11-26"]
        );
        assert_eq!(
            occurrences(
                &read_rule(r#"{"every":"month","day":29}"#).expect("rule"),
                "2028-02-01",
                "2028-02-29"
            ),
            ["2028-02-29"]
        );
        assert_eq!(read_rule("not json"), None);
        assert_eq!(read_rule(r#"{"every":"year"}"#), None);
    }

    #[test]
    fn lists_unpaid_bills_due_tomorrow() {
        let bills = [
            bill("rent", "Rent", 600_000, r#"{"every":"month","day":1}"#),
            bill("net", "Internet", 120_000, r#"{"every":"month","day":5}"#),
        ];
        assert_eq!(
            due_tomorrow(&bills, &[], "2026-12-01"),
            [("Rent".to_string(), 600_000)]
        );
        assert_eq!(due_tomorrow(&bills, &[], "2026-12-02"), []);
    }

    #[test]
    fn paid_ones_are_left_out() {
        let bills = [bill(
            "rent",
            "Rent",
            600_000,
            r#"{"every":"month","day":1}"#,
        )];
        // Marked as paying that date.
        let marked = Txn {
            regular_id: Some("rent".into()),
            due_date: Some("2026-12-01".into()),
            ..spend("2026-11-28", 600_000, "Rent")
        };
        assert_eq!(due_tomorrow(&bills, &[marked], "2026-12-01"), []);
        // Typed early: "paid rent 6000" two days before.
        assert_eq!(
            due_tomorrow(
                &bills,
                &[spend("2026-11-29", 600_000, "paid rent")],
                "2026-12-01"
            ),
            []
        );
        // Half paid: the rest is still due.
        assert_eq!(
            due_tomorrow(
                &bills,
                &[spend("2026-11-29", 200_000, "rent")],
                "2026-12-01"
            ),
            [("Rent".to_string(), 400_000)]
        );
        // Too early to count (more than 7 days before).
        assert_eq!(
            due_tomorrow(
                &bills,
                &[spend("2026-11-20", 600_000, "rent")],
                "2026-12-01"
            ),
            [("Rent".to_string(), 600_000)]
        );
    }

    #[test]
    fn paying_a_late_bill_does_not_count_for_tomorrow() {
        let bills = [bill(
            "net",
            "Internet",
            120_000,
            r#"{"every":"month","day":25}"#,
        )];
        // November's 25th went unpaid; one payment on Dec 20 settles that first.
        let txns = [spend("2026-12-20", 120_000, "internet")];
        assert_eq!(
            due_tomorrow(&bills, &txns, "2026-12-25"),
            [("Internet".to_string(), 120_000)]
        );
        // A bill added after November's date only asks about December.
        let added = Bill {
            since: "2026-12-01".into(),
            ..bills[0].clone()
        };
        assert_eq!(due_tomorrow(&[added], &txns, "2026-12-25"), []);
    }

    #[test]
    fn formats_birr_like_the_window() {
        assert_eq!(format_amount(600_000), "6,000 ETB");
        assert_eq!(format_amount(125_050), "1,250.50 ETB");
        assert_eq!(format_amount(12_345_600), "123,456 ETB");
        assert_eq!(format_amount(5), "0.05 ETB");
        assert_eq!(
            toast_text(&[("Rent".into(), 600_000), ("Internet".into(), 120_000)]),
            "Rent 6,000 ETB · Internet 1,200 ETB"
        );
    }

    #[test]
    fn loads_from_the_database() {
        let mut conn = Connection::open_in_memory().expect("open");
        db::configure(&conn).expect("pragmas");
        migrate::run(&mut conn, migrate::MIGRATIONS, 0).expect("migrate");
        conn.execute_batch(
            "INSERT INTO money_regulars (id, kind, name, amount_minor, rule_json, account, created_at, updated_at)
               VALUES ('rent', 'bill', 'Rent', 600000, '{\"every\":\"month\",\"day\":1}', 'cbo', 0, 0),
                      ('pay', 'pay', 'Job A', 1800000, '{\"every\":\"month\",\"day\":1}', 'cbo', 0, 0),
                      ('old', 'bill', 'Gym', 50000, '{\"every\":\"month\",\"day\":1}', 'cash', 0, 0);
             UPDATE money_regulars SET active = 0 WHERE id = 'old';",
        )
        .expect("insert");
        assert_eq!(
            load(&conn, "2026-12-01").expect("load"),
            [("Rent".to_string(), 600_000)]
        );
        conn.execute(
            "INSERT INTO money_txns (id, account, occurred_at, local_date, amount_minor, description, created_at, updated_at)
             VALUES ('t', 'cbo', 0, '2026-11-30', -600000, 'rent', 0, 0)",
            [],
        )
        .expect("insert");
        assert_eq!(load(&conn, "2026-12-01").expect("load"), []);
    }
}
