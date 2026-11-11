# Measurements

One line per check, newest first. Targets from [plan §10](plan.md#10-resource-budget). Measured with `scripts/measure.ps1` (private bytes, `sirna.exe` and its child processes).

| Date | Milestone | Check | Result | Target | Pass |
| --- | --- | --- | --- | --- | --- |
| 2026-11-11 | M0 | Build cache after the first debug build (`D:\dev\target`) | 1.4 GB, 3 min 30 s | ≤ 5 GB | ✅ |
| 2026-11-11 | M0 | Rust toolchain on D: (rustup minimal + clippy + rustfmt, Rust 1.99.1) | 640 MB | ~1 GB | ✅ |
