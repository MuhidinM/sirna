# 0001 — Tauri v2 with a Rust tray core

Status: accepted · 2026-11-11

## Context

Sirna runs all day in the tray on a laptop with little free disk, and low memory use is a must. The developer knows TypeScript and React, not Rust. Options: Electron, Tauri v2, Wails v3 (beta), native C#.

## Decision

Tauri v2. A small Rust core lives in the tray; WebView2 windows exist only while shown. Rust is limited to what must run with no window (tray, hotkey, timer, toasts, DB, network, secrets).

## Consequences

- Installer and idle memory far below Electron's; WebView2 is already on Windows 11.
- Some Rust to write, and a 3–5 GB build cache on D: (kept in check with `cargo clean`).
- Whether a closed window frees WebView2 memory is unverified; M0 measures it and has fallbacks (plan §4.3).
- Runner-up: Wails v3 (Go), if Rust becomes a blocker and beta status is acceptable.
