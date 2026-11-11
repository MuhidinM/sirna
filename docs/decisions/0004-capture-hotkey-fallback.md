# 0004 — Capture hotkey with fallbacks

Status: accepted · 2026-11-11

## Context

The plan picked Ctrl+Alt+Space for the capture box (plan §3.5, D20). On the development machine another running app already owns it (checked with `RegisterHotKey`: it fails with Sirna closed). Several installed tools register global hotkeys (PowerToys, Logitech Options+, Everything, the Claude desktop app). A capture box that silently doesn't open breaks the one entry point the app depends on.

## Decision

Try candidates in order and keep the first Windows accepts: Ctrl+Alt+Space, then Ctrl+Alt+J, then Ctrl+Shift+Alt+Space. The tray tooltip names the active key ("Sirna · Ctrl+Alt+J to capture"), or says that none was free. A setting to choose your own key comes with T-015.

Opening the box: the window is focused again from Rust once the page has loaded (`capture_ready`). Focusing it only at creation activated the frame but left keyboard focus outside the web content, so typed keys were lost.

## Consequences

- Capture always has a key when any candidate is free, and the user can see which one.
- The key can differ between machines; docs and onboarding say "your capture key", not a fixed combination.
- `capture_ready` also logs the time from key press to ready-to-type, which `scripts/hotkey-check.ps1` reads for the T-010 measurements.
