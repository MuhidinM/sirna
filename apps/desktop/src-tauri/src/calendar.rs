//! Google Calendar through its secret iCal address (plan Appendix A; R-CAL-01).
//! Rust only fetches: the address is a secret kept in Credential Manager and
//! never leaves Rust; the feed text goes to the page, which parses it (TS,
//! ical.js) into fixed blocks. Read-only: nothing is ever sent back.
//!
//! Failures come back as stable codes the page shows in words:
//! `no-link`, `link_revoked` (401/404), `bad_payload`, `offline`, `bad_link`.

use std::time::Duration;

pub const LINK_NAME: &str = "ical_url";
const TIMEOUT: Duration = Duration::from_secs(30);
/// A personal calendar feed is far smaller; anything bigger is refused.
const MAX_BYTES: u64 = 8 * 1024 * 1024;
const MAX_REDIRECTS: usize = 3;
/// Hosts a Google secret iCal address lives on.
const HOSTS: [&str; 2] = ["calendar.google.com", "www.google.com"];

/// HTTPS on a Google calendar host, with a path; nothing else is fetched.
pub fn allowed_link(link: &str) -> bool {
    link.strip_prefix("https://")
        .and_then(|rest| rest.split_once('/'))
        .is_some_and(|(host, path)| HOSTS.contains(&host) && !path.is_empty())
}

/// What a fetch gave: the feed text, or why not.
#[derive(Debug, PartialEq)]
pub enum Fetched {
    Feed(String),
    Code(&'static str),
}

/// Checks a response: a calendar (by type or by its first line), not an error page.
pub fn check_payload(content_type: &str, body: &str) -> Fetched {
    let calendar_type = content_type
        .to_ascii_lowercase()
        .starts_with("text/calendar");
    let looks_right = body
        .trim_start_matches('\u{feff}')
        .trim_start()
        .starts_with("BEGIN:VCALENDAR");
    if looks_right
        && (calendar_type || content_type.is_empty() || content_type.starts_with("text/"))
    {
        Fetched::Feed(body.to_string())
    } else {
        Fetched::Code("bad_payload")
    }
}

pub fn status_code(status: u16) -> &'static str {
    match status {
        401 | 403 | 404 | 410 => "link_revoked",
        _ => "offline",
    }
}

/// Fetches the feed. The address never reaches a log or an error message.
pub fn fetch() -> Fetched {
    let Ok(link) = crate::secrets::get(LINK_NAME) else {
        return Fetched::Code("no-link");
    };
    let link = link.trim().to_string();
    if link.is_empty() {
        return Fetched::Code("no-link");
    }
    if !allowed_link(&link) {
        return Fetched::Code("bad_link");
    }
    let agent = ureq::AgentBuilder::new()
        .timeout(TIMEOUT)
        .redirects(0)
        .https_only(true)
        .build();
    // Google moves old www.google.com addresses to calendar.google.com.
    // Redirects are followed by hand so every hop is checked against the list.
    let mut url = link;
    for _ in 0..=MAX_REDIRECTS {
        match agent.get(&url).call() {
            Ok(response) if (300..400).contains(&response.status()) => {
                match response
                    .header("location")
                    .and_then(|to| next_hop(&url, to))
                {
                    Some(to) if allowed_link(&to) => url = to,
                    _ => return Fetched::Code("bad_link"),
                }
            }
            Ok(response) => {
                let content_type = response.content_type().to_string();
                let mut body = String::new();
                use std::io::Read;
                return match response
                    .into_reader()
                    .take(MAX_BYTES + 1)
                    .read_to_string(&mut body)
                {
                    Ok(read) if (read as u64) <= MAX_BYTES => check_payload(&content_type, &body),
                    Ok(_) => Fetched::Code("bad_payload"),
                    Err(_) => Fetched::Code("offline"),
                };
            }
            Err(ureq::Error::Status(status, _)) => return Fetched::Code(status_code(status)),
            Err(_) => return Fetched::Code("offline"),
        }
    }
    Fetched::Code("bad_link")
}

/// Where a redirect goes: an absolute https address, or a path on the same host.
pub fn next_hop(from: &str, location: &str) -> Option<String> {
    if location.starts_with("https://") {
        return Some(location.to_string());
    }
    if location.starts_with('/') && !location.starts_with("//") {
        let rest = from.strip_prefix("https://")?;
        let host = rest.split('/').next()?;
        return Some(format!("https://{host}{location}"));
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_google_calendar_links_over_https() {
        assert!(allowed_link(
            "https://calendar.google.com/calendar/ical/me%40gmail.com/private-abc/basic.ics"
        ));
        assert!(!allowed_link(
            "http://calendar.google.com/calendar/ical/x/basic.ics"
        ));
        assert!(!allowed_link("https://calendar.google.com.evil.com/x.ics"));
        assert!(!allowed_link("https://example.com/basic.ics"));
        assert!(!allowed_link("https://calendar.google.com/"));
        assert!(!allowed_link("calendar.google.com/x"));
    }

    #[test]
    fn checks_the_payload() {
        let feed = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n";
        assert_eq!(
            check_payload("text/calendar; charset=UTF-8", feed),
            Fetched::Feed(feed.into())
        );
        assert_eq!(
            check_payload("text/calendar", &format!("\u{feff}{feed}")),
            Fetched::Feed(format!("\u{feff}{feed}"))
        );
        assert_eq!(
            check_payload("text/html", "<html>Sign in</html>"),
            Fetched::Code("bad_payload")
        );
        assert_eq!(
            check_payload("application/json", feed),
            Fetched::Code("bad_payload")
        );
    }

    #[test]
    fn follows_only_checked_redirects() {
        let from = "https://www.google.com/calendar/ical/x/basic.ics";
        assert_eq!(
            next_hop(
                from,
                "https://calendar.google.com/calendar/ical/x/basic.ics"
            )
            .as_deref(),
            Some("https://calendar.google.com/calendar/ical/x/basic.ics")
        );
        assert_eq!(
            next_hop(from, "/calendar/ical/y/basic.ics").as_deref(),
            Some("https://www.google.com/calendar/ical/y/basic.ics")
        );
        assert_eq!(next_hop(from, "//evil.com/x"), None);
        assert_eq!(next_hop(from, "http://calendar.google.com/x"), None);
        assert!(!allowed_link(
            &next_hop(from, "https://evil.com/x.ics").unwrap_or_default()
        ));
    }

    #[test]
    fn maps_statuses() {
        assert_eq!(status_code(404), "link_revoked");
        assert_eq!(status_code(401), "link_revoked");
        assert_eq!(status_code(503), "offline");
    }
}
