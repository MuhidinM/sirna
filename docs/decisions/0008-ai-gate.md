# 0008 — The AI gate: one Rust command, ureq, key in a header

Status: accepted · 2026-11-11

## Context

Plan §7.1 puts every model call behind one Rust command: the key from Credential Manager, a host allowlist, pacing, a daily budget and a log (T-036). The webview must never see the key (R-PLT-04), and the free tier's limits are unpublished and small (§7.5, Appendix C).

## Decision

- **`ai_send(task, prompt_version, body)`** in `ai.rs`. The webview builds the `generateContent` body; Rust adds nothing to it and returns only the reply text and token counts. The model comes from the `ai.model` setting, picked from `ai_models` at key entry, never from code; ids are checked so they can't change the path.
- **Key in the `x-goog-api-key` header**, not the `?key=` query, so it can't land in a URL, a log line or the call log. Any text that leaves the gate (errors, logged replies) has the key scrubbed, in case Google echoes it.
- **Only `https://generativelanguage.googleapis.com`.** No other host can be called, and redirects are never followed (ureq would resend the key header to the new host); HTTPS only.
- **Budget by Pacific date** (the free tier resets at midnight Pacific; US summer time computed in Rust, tested at both switches). Cap 15 a day until you set yours in Settings. Every HTTP attempt counts, retries included, and a request is reserved against the cap before its pacing wait, so calls made together can't pass it.
- **Pacing:** one request per 7 s across the app. **429:** honour `RetryInfo` up to 20 s, else 2 retries with 2 s / 4 s backoff; 4xx other than 429 is not retried. **3 failed calls in a row → plain mode for 10 minutes.**
- **Log:** `core_ai_calls` keeps every request body and reply for 30 days; Settings → AI → What was sent shows them.
- **HTTP client: `ureq` 2** (blocking, rustls, JSON). The gate runs on a command thread, so async buys nothing; ureq is small next to reqwest and has no runtime of its own. No Google SDK.

## Consequences

- Every feature calls one command and gets a stable error code (`no-key`, `budget:15`, `rate-limited:34`, `plain-mode:540`, `http:400:…`, `network:…`) to fall back on its template text (R-AI-01).
- The gate is tested without the network: an `Env` trait stands in for the key, clock, sleep, HTTP and database.
