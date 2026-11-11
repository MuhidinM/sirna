# 0002 — One local SQLite file, owned by Rust

Status: accepted · 2026-11-11

## Context

Reminders, the focus timer and backups run with no window open, so the database must be reachable without a webview. Data is personal and stays on the machine.

## Decision

One SQLite file (WAL) opened by Rust with rusqlite. The UI reads through a read-only `db_query` command and writes only through `db_tx`, which checks a table and column allowlist and writes an audit row. Forward-only migrations per feature, with checksums.

## Consequences

- Every change has an actor and can be undone.
- No `tauri-plugin-sql`; tests use the same migrations in `node:sqlite`.
- Sync or a phone app later needs no key changes (ULIDs, soft deletes).
