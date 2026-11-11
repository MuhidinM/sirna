# Measurements

One line per check, newest first. Targets from [plan §10](plan.md#10-resource-budget). Measured with `scripts/measure.ps1` (private bytes, `sirna.exe` and its child processes).

| Date       | Milestone | Check                                                                 | Result                        | Target                     | Pass |
| ---------- | --------- | --------------------------------------------------------------------- | ----------------------------- | -------------------------- | ---- |
| 2026-11-11 | M0        | Debug build: 60 s after closing `main` (T-007)                        | 6.1 MB, 0 webviews            | idle + ≤ 10 MB, 0 webviews | ✅   |
| 2026-11-11 | M0        | Debug build: `main` open (T-007)                                      | 163.7 MB, 6 webview processes | ≤ 200 MB                   | ✅   |
| 2026-11-11 | M0        | Debug build: tray only after `--autostart` (T-007)                    | 3.8 MB, 0 webviews            | ≤ 30 MB                    | ✅   |
| 2026-11-11 | M0        | Build cache after the first debug build (`D:\dev\target`)             | 1.4 GB, 3 min 30 s            | ≤ 5 GB                     | ✅   |
| 2026-11-11 | M0        | Rust toolchain on D: (rustup minimal + clippy + rustfmt, Rust 1.99.1) | 640 MB                        | ~1 GB                      | ✅   |
