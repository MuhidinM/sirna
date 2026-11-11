//! Start-up and exit rules, kept free of Tauri types so they can be unit-tested.

use crate::AUTOSTART_ARG;

/// Passed to a second launch to show the check toast (used by the smoke test).
pub const TEST_TOAST_ARG: &str = "--test-toast";

/// What a second launch asks the running instance to do.
#[derive(Debug, PartialEq, Eq)]
pub enum SecondLaunch {
    OpenMain,
    TestToast,
}

pub fn second_launch_action<I, S>(args: I) -> SecondLaunch
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    if args.into_iter().any(|arg| arg.as_ref() == TEST_TOAST_ARG) {
        SecondLaunch::TestToast
    } else {
        SecondLaunch::OpenMain
    }
}

/// A manual launch opens the main window; an autostart launch stays in the tray.
pub fn should_open_main<I, S>(args: I) -> bool
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    !args.into_iter().any(|arg| arg.as_ref() == AUTOSTART_ARG)
}

/// Keep running when the exit request came from the last window closing
/// (no exit code). An explicit exit, such as tray Quit, carries a code.
pub fn keep_running_on_exit_request(code: Option<i32>) -> bool {
    code.is_none()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manual_launch_opens_main() {
        assert!(should_open_main(["sirna.exe"]));
    }

    #[test]
    fn autostart_launch_stays_in_tray() {
        assert!(!should_open_main(["sirna.exe", "--autostart"]));
    }

    #[test]
    fn second_launch_opens_main_by_default() {
        assert_eq!(second_launch_action(["sirna.exe"]), SecondLaunch::OpenMain);
    }

    #[test]
    fn second_launch_can_ask_for_the_check_toast() {
        assert_eq!(
            second_launch_action(["sirna.exe", "--test-toast"]),
            SecondLaunch::TestToast
        );
    }

    #[test]
    fn closing_the_last_window_keeps_running() {
        assert!(keep_running_on_exit_request(None));
    }

    #[test]
    fn explicit_exit_is_allowed() {
        assert!(!keep_running_on_exit_request(Some(0)));
    }
}
