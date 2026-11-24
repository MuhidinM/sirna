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
/// As LATE_KEEP_DAYS in regulars.ts: how far back an unpaid date is still worked out.
const LATE_KEEP_DAYS: i64 = 31;

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

/// Dates you skipped, kept in rule_json next to the rule (readSkips in regulars.ts).
pub fn read_skips(json: &str) -> Vec<String> {
    serde_json::from_str::<Value>(json)
        .ok()
        .and_then(|value| {
            value.get("skip").and_then(Value::as_array).map(|dates| {
                dates
                    .iter()
                    .filter_map(|date| date.as_str().map(str::to_string))
                    .collect()
            })
        })
        .unwrap_or_default()
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
    /// Its currency (its account's); only entries in it settle it.
    pub currency: String,
}

#[derive(Debug, Clone)]
pub struct Txn {
    pub regular_id: Option<String>,
    pub due_date: Option<String>,
    pub amount: i64,
    pub local_date: String,
    pub description: Option<String>,
    pub category_id: Option<String>,
    pub currency: String,
}

/// An expense you typed that is this bill: its name in the words, or its
/// category and amount. Only in the bill's own currency: 15 birr is not $15.
fn pays_bill(bill: &Bill, txn: &Txn) -> bool {
    if txn.amount >= 0 || txn.currency != bill.currency {
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

/// The window for `tomorrow`, as `dueWindow` in regulars.ts: occurrences from
/// the start of the month before it (so late payments settle their own
/// month), entries from a week before that (so early ones count), to it.
/// Returns (occurrences from, entries from, to).
pub fn window(tomorrow: &str) -> (String, String, String) {
    // The Money page's window on the evening before (dueWindow(today) in regulars.ts).
    let today = shift(tomorrow, -1);
    let month_start = format!("{}-01", &today[..7.min(today.len())]);
    let last_month = format!("{}-01", &shift(&month_start, -1)[..7]);
    // Or further back, while an unpaid date is still kept (LATE_KEEP_DAYS).
    let keep = shift(&today, -LATE_KEEP_DAYS);
    let last_month = if keep < last_month { keep } else { last_month };
    let entries_from = shift(&last_month, -EARLY_DAYS);
    let month_end = shift(&format!("{}-01", &shift(&month_start, 31)[..7]), -1);
    let to = if tomorrow > month_end.as_str() {
        tomorrow.to_string()
    } else {
        month_end
    };
    (last_month, entries_from, to)
}

/// Same-day order, shared with regulars.ts: name ignoring case, then exactly, then id.
fn by_name(a: &Bill, b: &Bill) -> std::cmp::Ordering {
    a.name
        .to_lowercase()
        .cmp(&b.name.to_lowercase())
        .then_with(|| a.name.cmp(&b.name))
        .then_with(|| a.id.cmp(&b.id))
}

/// Bills due on `tomorrow` that aren't paid yet, with what is left of each.
/// The matching is `dueItems` in regulars.ts: an entry that fits counts for
/// each bill's due date nearest to it (from EARLY_DAYS before it until that
/// bill's next date); between bills, one named exactly goes first, then the
/// oldest date; what is left over catches up the oldest open date it could pay.
pub fn due_tomorrow(bills: &[Bill], txns: &[Txn], tomorrow: &str) -> Vec<(String, i64)> {
    struct Item<'a> {
        bill: &'a Bill,
        date: String,
        next: Option<String>,
        done: i64,
    }
    let (from, _, to) = window(tomorrow);
    let until = shift(&to, EARLY_DAYS);
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
        let skipped = read_skips(&bill.rule_json);
        let dates: Vec<String> = occurrences(&rule, &start, &until)
            .into_iter()
            .filter(|date| !skipped.contains(date))
            .collect();
        for (index, date) in dates.iter().enumerate() {
            let done = txns
                .iter()
                .filter(|txn| {
                    txn.regular_id.as_deref() == Some(bill.id.as_str())
                        && txn.due_date.as_deref() == Some(date.as_str())
                })
                .map(|txn| txn.amount.abs())
                .sum();
            items.push(Item {
                bill,
                date: date.clone(),
                next: dates.get(index + 1).cloned(),
                done,
            });
        }
    }
    items.sort_by(|a, b| a.date.cmp(&b.date).then_with(|| by_name(a.bill, b.bill)));
    let open = |item: &Item| (item.bill.amount - item.done).max(0);
    let gap = |a: &str, b: &str| match (day_number(a), day_number(b)) {
        (Some(x), Some(y)) => (y - x).abs(),
        _ => i64::MAX,
    };

    let mut free: Vec<&Txn> = txns.iter().filter(|txn| txn.regular_id.is_none()).collect();
    free.sort_by(|a, b| a.local_date.cmp(&b.local_date));
    for txn in free {
        let day = txn.local_date.as_str();
        let candidates: Vec<usize> = (0..items.len())
            .filter(|&i| {
                shift(&items[i].date, -EARLY_DAYS).as_str() <= day && pays_bill(items[i].bill, txn)
            })
            .collect();
        // Each bill's own date for it: the nearest one, up to that bill's next date.
        let mut own: Vec<usize> = Vec::new();
        for &i in &candidates {
            if items[i].next.as_deref().is_some_and(|next| day >= next) {
                continue;
            }
            match own
                .iter()
                .position(|&j| items[j].bill.id == items[i].bill.id)
            {
                Some(at) if gap(day, &items[i].date) < gap(day, &items[own[at]].date) => {
                    own[at] = i
                }
                Some(_) => {}
                None => own.push(i),
            }
        }
        // Between bills: one named exactly, then the oldest date. Anything left
        // over catches up the oldest open dates.
        let words = txn
            .description
            .as_deref()
            .unwrap_or("")
            .trim()
            .to_lowercase();
        let named =
            |i: usize| !words.is_empty() && items[i].bill.name.trim().to_lowercase() == words;
        own.sort_by(|&a, &b| {
            named(b)
                .cmp(&named(a))
                .then_with(|| items[a].date.cmp(&items[b].date))
                .then_with(|| by_name(items[a].bill, items[b].bill))
        });
        let order: Vec<usize> = own
            .iter()
            .copied()
            .chain(candidates.iter().copied().filter(|i| !own.contains(i)))
            .collect();
        let mut amount = txn.amount.abs();
        for i in order {
            if amount == 0 {
                break;
            }
            let take = open(&items[i]).min(amount);
            items[i].done += take;
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

/// A row's currency, as rowCurrencySql in currency.ts: its own when not birr, else its account's.
macro_rules! row_currency {
    ($row:literal) => {
        concat!(
            "CASE WHEN ",
            $row,
            ".currency <> 'ETB' THEN ",
            $row,
            ".currency ELSE COALESCE(acc.currency, 'ETB') END"
        )
    };
}

const BILLS_SQL: &str = concat!(
    "SELECT r.id, r.name, r.amount_minor, r.rule_json, r.category_id, r.created_at, ",
    row_currency!("r"),
    " FROM money_regulars r LEFT JOIN money_accounts acc ON acc.id = r.account
     WHERE r.deleted_at IS NULL AND r.active = 1 AND r.kind = 'bill'"
);

/// The same rows as REGULAR_TXNS_SQL in regulars.ts.
const TXNS_SQL: &str = concat!(
    "SELECT t.regular_id, t.due_date, t.amount_minor, t.local_date, t.description, t.category_id, ",
    row_currency!("t"),
    " FROM money_txns t LEFT JOIN money_accounts acc ON acc.id = t.account
     WHERE t.deleted_at IS NULL AND t.transfer_id IS NULL
       AND ((t.regular_id IS NOT NULL AND t.due_date >= ?1 AND t.due_date <= ?2)
         OR (t.regular_id IS NULL AND t.local_date >= ?1 AND t.local_date <= ?2))
     ORDER BY t.local_date, t.rowid"
);

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
                currency: row.get(6)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    if bills.is_empty() {
        return Ok(Vec::new());
    }
    let (_, entries_from, to) = window(tomorrow);
    let txns = conn
        .prepare(TXNS_SQL)?
        .query_map(params![entries_from, to], |row| {
            Ok(Txn {
                regular_id: row.get(0)?,
                due_date: row.get(1)?,
                amount: row.get(2)?,
                local_date: row.get(3)?,
                description: row.get(4)?,
                category_id: row.get(5)?,
                currency: row.get(6)?,
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
            currency: "ETB".into(),
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
            currency: "ETB".into(),
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
        // Added long ago, with November never recorded (second review).
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
    fn a_payment_counts_for_the_nearest_date() {
        let bills = [bill(
            "net",
            "Internet",
            120_000,
            r#"{"every":"month","day":25}"#,
        )];
        // November's 25th went unpaid; Dec 20 is nearest to Dec 25, so that is paid.
        let txns = [spend("2026-12-20", 120_000, "internet")];
        assert_eq!(due_tomorrow(&bills, &txns, "2026-12-25"), []);
        // Paid 10 days late: too early for December's date, so it is November's.
        assert_eq!(
            due_tomorrow(
                &bills,
                &[spend("2026-12-05", 120_000, "internet")],
                "2026-12-25"
            ),
            [("Internet".to_string(), 120_000)]
        );
    }

    /// The same cases as review.test.ts (leftovers review).
    #[test]
    fn early_payments_and_late_rent_land_on_the_right_month() {
        let internet = bill("net", "Internet", 120_000, r#"{"every":"month","day":25}"#);
        let txns = [
            spend("2026-11-20", 120_000, "internet"),
            spend("2026-12-20", 120_000, "internet"),
        ];
        assert_eq!(due_tomorrow(&[internet], &txns, "2026-12-25"), []);

        let rent = [bill(
            "rent",
            "Rent",
            600_000,
            r#"{"every":"month","day":1}"#,
        )];
        // November never recorded: a payment on Nov 29 is December's.
        assert_eq!(
            due_tomorrow(&rent, &[spend("2026-11-29", 600_000, "rent")], "2026-12-01"),
            []
        );
        // 11 days late is November's, so December's is still to pay.
        assert_eq!(
            due_tomorrow(&rent, &[spend("2026-11-12", 600_000, "rent")], "2026-12-01"),
            [("Rent".to_string(), 600_000)]
        );
        // Always on the 28th, a few days ahead: no toast, at the window's edge too.
        let ahead: Vec<Txn> = ["2026-09-28", "2026-10-28", "2026-11-28"]
            .iter()
            .map(|d| spend(d, 600_000, "rent"))
            .collect();
        assert_eq!(due_tomorrow(&rent, &ahead, "2026-12-01"), []);
        assert_eq!(due_tomorrow(&rent, &ahead[..2], "2026-11-01"), []);
    }

    #[test]
    fn same_day_bills_take_payments_in_the_same_order_as_typescript() {
        let mut iddir = bill("iddir", "iddir", 20_000, r#"{"every":"month","day":5}"#);
        let mut net = bill("net", "Internet", 20_000, r#"{"every":"month","day":5}"#);
        iddir.category_id = Some("cat_utilities".into());
        net.category_id = Some("cat_utilities".into());
        iddir.since = "2026-12-01".into();
        net.since = "2026-12-01".into();
        let unlabelled = Txn {
            category_id: Some("cat_utilities".into()),
            description: None,
            ..spend("2026-12-03", 20_000, "")
        };
        // "iddir" sorts before "Internet" ignoring case, so it is the one paid.
        assert_eq!(
            due_tomorrow(&[net, iddir], &[unlabelled], "2026-12-05"),
            [("Internet".to_string(), 20_000)]
        );
    }

    #[test]
    fn bills_with_the_same_name_go_by_id() {
        let mut a = bill("iddir_a", "Iddir", 20_000, r#"{"every":"month","day":5}"#);
        let mut b = bill("iddir_b", "Iddir", 30_000, r#"{"every":"month","day":5}"#);
        a.since = "2026-12-01".into();
        b.since = "2026-12-01".into();
        assert_eq!(
            due_tomorrow(
                &[b, a],
                &[spend("2026-12-03", 20_000, "iddir")],
                "2026-12-05"
            ),
            [("Iddir".to_string(), 30_000)]
        );
    }

    /// The same cases as review.test.ts (third review).
    #[test]
    fn overlapping_names_and_later_payments() {
        let mut phone = bill("phone", "Phone", 30_000, r#"{"every":"month","day":1}"#);
        let mut mom = bill("mom", "Mom phone", 30_000, r#"{"every":"month","day":15}"#);
        phone.since = "2026-11-01".into();
        mom.since = "2026-11-01".into();
        // "phone" on Nov 9 is the Phone bill's, so Mom phone is still due on the 15th.
        assert_eq!(
            due_tomorrow(
                &[phone, mom],
                &[spend("2026-11-09", 30_000, "phone")],
                "2026-11-15"
            ),
            [("Mom phone".to_string(), 30_000)]
        );
        // Entries dated later in the month count, as on the Money page.
        let rent = bill("rent", "Rent", 600_000, r#"{"every":"month","day":20}"#);
        assert_eq!(
            due_tomorrow(
                &[rent],
                &[spend("2026-11-22", 600_000, "rent")],
                "2026-11-20"
            ),
            []
        );
        assert_eq!(window("2026-11-20").2, "2026-11-30");
        assert_eq!(window("2028-02-29").2, "2028-02-29");
        // On a month's last day, tomorrow (the 1st) is included, as on the Money page.
        assert_eq!(
            window("2026-12-01"),
            (
                "2026-10-01".into(),
                "2026-09-24".into(),
                "2026-12-01".into()
            )
        );
        assert_eq!(window("2027-01-01").2, "2027-01-01");
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

    #[test]
    fn a_skipped_date_is_not_asked_about() {
        let iddir = bill(
            "iddir",
            "Iddir",
            20_000,
            r#"{"every":"month","day":24,"skip":["2026-11-24"]}"#,
        );
        assert_eq!(read_skips(&iddir.rule_json), ["2026-11-24"]);
        assert_eq!(
            due_tomorrow(std::slice::from_ref(&iddir), &[], "2026-11-24"),
            []
        );
        assert_eq!(
            due_tomorrow(&[iddir], &[], "2026-12-24"),
            [("Iddir".to_string(), 20_000)]
        );
    }

    #[test]
    fn birr_does_not_settle_a_dollar_bill() {
        let mut conn = Connection::open_in_memory().expect("open");
        db::configure(&conn).expect("pragmas");
        migrate::run(&mut conn, migrate::MIGRATIONS, 0).expect("migrate");
        conn.execute_batch(
            "INSERT INTO money_regulars (id, kind, name, amount_minor, rule_json, account, created_at, updated_at)
               VALUES ('figma', 'bill', 'Figma', 1500, '{\"every\":\"month\",\"day\":26}', 'wise', 0, 0);
             INSERT INTO money_txns (id, account, occurred_at, local_date, amount_minor, description, created_at, updated_at)
               VALUES ('t', 'cash', 0, '2026-11-24', -1500, 'figma', 0, 0);",
        )
        .expect("insert");
        assert_eq!(
            load(&conn, "2026-11-26").expect("load"),
            [("Figma".to_string(), 1500)]
        );
        conn.execute(
            "INSERT INTO money_txns (id, account, occurred_at, local_date, amount_minor, description, created_at, updated_at)
             VALUES ('u', 'wise', 0, '2026-11-24', -1500, 'figma', 0, 0)",
            [],
        )
        .expect("insert");
        assert_eq!(load(&conn, "2026-11-26").expect("load"), []);
    }
}
