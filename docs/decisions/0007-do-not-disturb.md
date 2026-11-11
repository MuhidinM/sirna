# 0007 — Do not disturb through the QuietHoursSettings COM server

Status: accepted · 2026-11-11

## Context

Plan §3.6a wants Do not disturb on during a focus session and restored after. Windows 11 has no documented API for it. The plan listed three routes to test (T-029): an undocumented WNF write, Windows' own Focus session, and a "Turn on Do not disturb (Win+N)" tick as the fallback.

Research (sources below) and a live test on this laptop (Windows 11, build 26300.9818) found:

| Route                                                                                                                                                                                   | Result                                                                                                                                                                       |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Write WNF `WNF_SHEL_QUIETHOURS_ACTIVE_PROFILE_CHANGED`                                                                                                                                  | Not a way to set it: the state is what WpnUserService publishes after a change. **Reading** it works and shows what Windows applied (0 off, 1 priority only, 2 alarms only). |
| `Windows.UI.Shell.FocusSessionManager.TryStartFocusSession`                                                                                                                             | Limited Access Feature: fails with 0x80070005 without a Microsoft unlock token.                                                                                              |
| `ms-clock://` focus timer links                                                                                                                                                         | Opens the Clock app; turns DND on only if the user's Focus settings say so.                                                                                                  |
| Rewrite the CloudStore registry blob                                                                                                                                                    | Needs WpnUserService restarted. Rejected.                                                                                                                                    |
| **`QuietHoursSettings` COM server** (`CLSID {F53321FA-34F8-4B7F-B9A3-361877CB94CF}`, `IID {6BFF4732-81EC-4FFB-AE67-B6C1BC29631F}`, hosted by WpnUserService), `put_UserSelectedProfile` | **Works.** No admin, no restart. Unrestricted → PriorityOnly → Unrestricted, confirmed by the WNF state (stamps 1388/1389, then 1392/1393 and 1394/1395 from the Rust code). |

One trap found in the live test: Windows applies the change asynchronously. Switching on and straight off within milliseconds left Do not disturb **on**, while the read-back said off. Restored by hand at once.

## Decision

- `dnd.rs` switches to `Microsoft.QuietHoursProfile.PriorityOnly` when a focus session starts and puts the saved profile back when it ends, through the COM server on a short-lived single-threaded apartment.
- A switch counts only once the WNF state shows the new level (polled up to 3 s), so the asynchronous trap above can't pass silently. Syncs run one at a time, off the tray and command threads, and read the timer's state under their lock.
- The saved original is only dropped when it is certainly safe: a switch that was sent but not yet confirmed keeps it; an unreadable profile keeps it; a failed restore is tried three times, then again every minute and at the next start.
- Only when you had it off: an existing Do not disturb, or one you change during the session, is left alone.
- The original profile is saved in `core_settings` (`dnd.restore`) before switching, so a crash is undone at the next start.
- It is restored before break toasts are shown (Do not disturb would hide them).
- `focus.dnd = "off"` turns the feature off. If the COM server stops answering in a future build, nothing is switched and the sheet shows the kit's manual tick instead.

## Consequences

- Priority-only lets calls, alarms and your priority apps through; everything else waits in the notification centre until the session ends.
- It is undocumented: a Windows update can break it. The read-only probe (`dnd::available`) makes that a quiet fallback, not an error; `cargo test dnd::tests::live_round_trip -- --ignored` re-checks it on a real machine.
- Check again in the installed build after `pnpm ship` (AGENTS.md rule 7).

## Sources

- WinDndToggle (COM interface, 23H2): github.com/HalZheng/WinDndToggle
- WNF names: github.com/ionescu007/wnfun, github.com/redplait/wnfmon
- taskbar-focus crate (WNF read, CloudStore write): docs.rs/crate/taskbar-focus
- FocusSessionManager: learn.microsoft.com/uwp/api/windows.ui.shell.focussessionmanager
