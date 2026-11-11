//! Focus kits and the set-up sheet (plan §3.6a). When a session starts fresh
//! (tray, block toast, nudge, Today) a small sheet shows the area's kit: an
//! intent line, a checklist, what opens and what gets minimized. Enter starts
//! the timer and applies the kit. Apps are only minimized, never closed.

use parking_lot::Mutex;
use rusqlite::{Connection, OptionalExtension};
use serde::Serialize;

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct Kit {
    pub open: Vec<String>,
    pub minimize: Vec<String>,
    pub checklist: Vec<String>,
}

/// The block the open sheet is for (None = a plain session).
#[derive(Default)]
pub struct PendingSetup(pub Mutex<Option<Option<String>>>);

fn list(json: &str) -> Vec<String> {
    serde_json::from_str::<Vec<String>>(json)
        .unwrap_or_default()
        .into_iter()
        .map(|item| item.trim().to_string())
        .filter(|item| !item.is_empty())
        .collect()
}

/// The kit for an area; an area without one (or no area) gets an empty kit.
pub fn load(conn: &Connection, area_id: Option<&str>) -> Kit {
    let Some(area_id) = area_id else {
        return Kit::default();
    };
    conn.query_row(
        "SELECT open_json, minimize_json, checklist_json FROM focus_kits WHERE area_id = ?1",
        [area_id],
        |row| {
            Ok(Kit {
                open: list(&row.get::<_, String>(0)?),
                minimize: list(&row.get::<_, String>(1)?),
                checklist: list(&row.get::<_, String>(2)?),
            })
        },
    )
    .optional()
    .ok()
    .flatten()
    .unwrap_or_default()
}

/// "Telegram.exe", "telegram" and a full path all name the same program.
pub fn program_key(name: &str) -> String {
    let file = name.rsplit(['\\', '/']).next().unwrap_or(name).trim();
    let lower = file.to_lowercase();
    lower.strip_suffix(".exe").unwrap_or(&lower).to_string()
}

/// What to do with one "open" entry.
#[derive(Debug, PartialEq)]
pub enum Target {
    /// A URL, file or folder, opened with its default program.
    Item(String),
    /// A program with arguments: `code D:\Projects\sirna`.
    Command { program: String, args: String },
}

/// URLs and existing paths open as they are. Anything else is a command line:
/// a quoted program (`"C:\Program Files\X\x.exe" --flag`), else the longest
/// leading part that is an existing path (`C:\Program Files\X\x.exe --flag`),
/// else the first word (`code D:\Projects\sirna`).
pub fn target(entry: &str, exists: impl Fn(&str) -> bool) -> Target {
    let entry = entry.trim();
    let lower = entry.to_lowercase();
    if lower.starts_with("http://") || lower.starts_with("https://") || exists(entry) {
        return Target::Item(entry.to_string());
    }
    let command = |program: &str, args: &str| {
        let args = args.trim();
        if args.is_empty() {
            Target::Item(program.to_string())
        } else {
            Target::Command {
                program: program.to_string(),
                args: args.to_string(),
            }
        }
    };
    if let Some(rest) = entry.strip_prefix('"')
        && let Some((program, args)) = rest.split_once('"')
    {
        return command(program, args);
    }
    let breaks: Vec<usize> = entry
        .char_indices()
        .filter(|(_, c)| c.is_whitespace())
        .map(|(i, _)| i)
        .collect();
    for &at in breaks.iter().rev() {
        if exists(&entry[..at]) {
            return command(&entry[..at], &entry[at..]);
        }
    }
    match entry.split_once(char::is_whitespace) {
        Some((program, args)) => command(program, args),
        None => Target::Item(entry.to_string()),
    }
}

/// Minimizes the listed programs, then opens the work, so a window the kit
/// opens or brings forward (a URL in an already-open browser) stays visible.
/// Returns how many windows were minimized, for the log.
pub fn apply(kit: &Kit) -> usize {
    let keys: Vec<String> = kit.minimize.iter().map(|name| program_key(name)).collect();
    let minimized = if keys.is_empty() {
        0
    } else {
        platform::minimize(&keys)
    };
    for entry in &kit.open {
        let target = target(entry, |path| std::path::Path::new(path).exists());
        if let Err(error) = platform::open(&target) {
            log::warn!("focus kit: could not open {entry}: {error}");
        }
    }
    minimized
}

#[cfg(windows)]
mod platform {
    use super::{Target, program_key};
    use windows_sys::Win32::Foundation::{CloseHandle, HWND, LPARAM};
    use windows_sys::Win32::System::Threading::{
        GetCurrentProcessId, OpenProcess, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
        QueryFullProcessImageNameW,
    };
    use windows_sys::Win32::UI::Shell::ShellExecuteW;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GW_OWNER, GWL_EXSTYLE, GetClassNameW, GetWindow, GetWindowLongPtrW,
        GetWindowThreadProcessId, IsIconic, IsWindowVisible, SW_MINIMIZE, SW_SHOWNORMAL,
        ShowWindow, WS_EX_APPWINDOW, WS_EX_TOOLWINDOW,
    };

    /// Shell windows that live in explorer.exe next to File Explorer windows.
    const SHELL_CLASSES: [&str; 4] = [
        "Shell_TrayWnd",
        "Shell_SecondaryTrayWnd",
        "Progman",
        "WorkerW",
    ];

    /// Only ordinary app windows: not tool windows, not owned pop-ups, and never
    /// the taskbar or desktop (minimizing "explorer" must leave those alone).
    ///
    /// SAFETY: `hwnd` must be a window handle from EnumWindows.
    unsafe fn is_app_window(hwnd: HWND) -> bool {
        // SAFETY: plain queries on a valid window handle; the class buffer size is passed in.
        unsafe {
            let ex_style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32;
            if ex_style & WS_EX_TOOLWINDOW != 0 {
                return false;
            }
            if !GetWindow(hwnd, GW_OWNER).is_null() && ex_style & WS_EX_APPWINDOW == 0 {
                return false;
            }
            let mut class = [0u16; 64];
            let length = GetClassNameW(hwnd, class.as_mut_ptr(), class.len() as i32);
            let class = String::from_utf16_lossy(&class[..length.max(0) as usize]);
            !SHELL_CLASSES.contains(&class.as_str())
        }
    }

    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(std::iter::once(0)).collect()
    }

    pub fn open(target: &Target) -> Result<(), String> {
        let (file, args) = match target {
            Target::Item(item) => (wide(item), None),
            Target::Command { program, args } => (wide(program), Some(wide(args))),
        };
        let verb = wide("open");
        // SAFETY: all strings are NUL-terminated and outlive the call.
        let result = unsafe {
            ShellExecuteW(
                std::ptr::null_mut(),
                verb.as_ptr(),
                file.as_ptr(),
                args.as_ref().map_or(std::ptr::null(), |a| a.as_ptr()),
                std::ptr::null(),
                SW_SHOWNORMAL,
            )
        };
        // ShellExecute returns a value above 32 on success.
        if result as isize > 32 {
            Ok(())
        } else {
            Err(format!("ShellExecute returned {}", result as isize))
        }
    }

    fn process_key(pid: u32) -> Option<String> {
        // SAFETY: the handle is checked and closed; the buffer size is passed in.
        unsafe {
            let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if handle.is_null() {
                return None;
            }
            let mut buffer = [0u16; 1024];
            let mut size = buffer.len() as u32;
            let ok = QueryFullProcessImageNameW(
                handle,
                PROCESS_NAME_WIN32,
                buffer.as_mut_ptr(),
                &mut size,
            );
            CloseHandle(handle);
            (ok != 0).then(|| program_key(&String::from_utf16_lossy(&buffer[..size as usize])))
        }
    }

    struct Search<'a> {
        keys: &'a [String],
        own_pid: u32,
        windows: Vec<HWND>,
    }

    unsafe extern "system" fn visit(hwnd: HWND, lparam: LPARAM) -> i32 {
        // SAFETY: lparam is the &mut Search passed to EnumWindows below.
        let search = unsafe { &mut *(lparam as *mut Search) };
        // SAFETY: plain queries on a window handle Windows gave us.
        unsafe {
            if IsWindowVisible(hwnd) == 0 || IsIconic(hwnd) != 0 || !is_app_window(hwnd) {
                return 1;
            }
            let mut pid = 0u32;
            GetWindowThreadProcessId(hwnd, &mut pid);
            if pid == 0 || pid == search.own_pid {
                return 1;
            }
            if process_key(pid).is_some_and(|key| search.keys.contains(&key)) {
                search.windows.push(hwnd);
            }
        }
        1
    }

    pub fn minimize(keys: &[String]) -> usize {
        let mut search = Search {
            keys,
            // SAFETY: no arguments.
            own_pid: unsafe { GetCurrentProcessId() },
            windows: Vec::new(),
        };
        // SAFETY: the callback only uses `search` during this call.
        unsafe {
            EnumWindows(Some(visit), &mut search as *mut Search as LPARAM);
            for hwnd in &search.windows {
                ShowWindow(*hwnd, SW_MINIMIZE);
            }
        }
        search.windows.len()
    }
}

#[cfg(not(windows))]
mod platform {
    use super::Target;
    pub fn open(_target: &Target) -> Result<(), String> {
        Ok(())
    }
    pub fn minimize(_keys: &[String]) -> usize {
        0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection {
        let mut conn = Connection::open_in_memory().unwrap();
        crate::db::configure(&conn).unwrap();
        crate::migrate::run(&mut conn, crate::migrate::MIGRATIONS, 0).unwrap();
        conn
    }

    #[test]
    fn program_names_match_loosely() {
        assert_eq!(program_key("Telegram.exe"), "telegram");
        assert_eq!(program_key("telegram"), "telegram");
        assert_eq!(
            program_key(r"C:\Apps\Telegram Desktop\Telegram.EXE"),
            "telegram"
        );
    }

    #[test]
    fn reads_targets() {
        let none = |_: &str| false;
        assert_eq!(
            target("https://example.com/jobs", none),
            Target::Item("https://example.com/jobs".into())
        );
        assert_eq!(
            target(r"code D:\Projects\sirna", none),
            Target::Command {
                program: "code".into(),
                args: r"D:\Projects\sirna".into()
            }
        );
        // An existing path with a space is opened whole, not split.
        assert_eq!(
            target(r"D:\My CV\cv.docx", |_| true),
            Target::Item(r"D:\My CV\cv.docx".into())
        );
        assert_eq!(target("notepad", none), Target::Item("notepad".into()));
    }

    #[test]
    fn programs_with_spaces_keep_their_path() {
        let obsidian = r"C:\Program Files\Obsidian\Obsidian.exe";
        let exists = |path: &str| path == obsidian;
        let expected = Target::Command {
            program: obsidian.into(),
            args: "--vault notes".into(),
        };
        assert_eq!(
            target(&format!("\"{obsidian}\" --vault notes"), |_| false),
            expected
        );
        assert_eq!(
            target(&format!("{obsidian} --vault notes"), exists),
            expected
        );
        assert_eq!(
            target(&format!("\"{obsidian}\""), |_| false),
            Target::Item(obsidian.into())
        );
    }

    #[test]
    fn loads_the_seeded_kits() {
        let conn = db();
        let coding = load(&conn, Some("coding"));
        assert_eq!(coding.minimize, vec!["Telegram.exe"]);
        assert!(coding.checklist.contains(&"Water on the desk".to_string()));
        assert_eq!(load(&conn, Some("gym")), Kit::default());
        assert_eq!(load(&conn, None), Kit::default());
        assert_eq!(load(&conn, Some("nope")), Kit::default());
    }

    #[test]
    fn bad_json_is_an_empty_list() {
        assert!(list("not json").is_empty());
        assert_eq!(list(r#"[" a ", ""]"#), vec!["a"]);
    }
}
