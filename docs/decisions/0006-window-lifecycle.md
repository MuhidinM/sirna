# 0006 — Windows are destroyed on close; nothing is kept warm

Status: accepted · 2026-11-11

## Context

Plan §4.3 left two questions for M0: does closing a Tauri window on Windows free WebView2's memory (a 2022 report said it didn't on Windows 10), and is a cold capture box fast enough (≤ 700 ms p95), or should it be hidden and kept warm (+60–100 MB all day)?

## Decision

Destroy every window on close, including the capture box. No hidden or suspended webviews. Fallbacks 1 and 2 from the plan are not needed.

Measured on this laptop (release build, installed, `scripts/measure.ps1` and `scripts/hotkey-check.ps1`):

| Check                                     | Result                                     | Target         |
| ----------------------------------------- | ------------------------------------------ | -------------- |
| Idle in the tray, no window               | 2.7 MB private bytes, 0 WebView2 processes | ≤ 30 MB        |
| Main window open                          | ~150–165 MB (whole process tree)           | ≤ 200 MB       |
| 60 s after closing the main window        | 5.0 MB, 0 WebView2 processes               | idle + ≤ 10 MB |
| Capture box, hotkey → ready to type, cold | 408–668 ms, p95 452 ms (20/20)             | ≤ 700 ms       |
| After 20 capture opens and closes         | 7.5 MB, 0 WebView2 processes               | idle + ≤ 10 MB |

## Consequences

- Sirna costs almost nothing while it sits in the tray; memory is only used while a window is on screen.
- The first capture after start-up is slower (~670 ms) because WebView2 starts; later ones are ~430 ms.
- If a future Windows or WebView2 update stops freeing memory, `measure.ps1` after each milestone will show it, and the plan's fallbacks are still written down.
