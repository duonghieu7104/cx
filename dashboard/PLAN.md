# Dashboard plan (milestone M5)

The dashboard is not part of this release. `cx dash` prints a pointer here and does not open a port.

## Shape

A single Node process using only `node:http`. No Express, no npm dependencies, no credential routes.

- Bind to `127.0.0.1` only. There is no flag for `0.0.0.0`.
- A 32-byte token lives in `~/.config/cx/dash.token` with mode `600`.
- First visit accepts `?t=`. After that the token moves to an `HttpOnly; SameSite=Strict` cookie.
- Reject requests whose `Host` header is not the bound host and port.
- Read-only in the first dashboard release. Later write buttons need a CSRF token and a confirmation step.
- `cx approve` never gets a button. Approval stays in the terminal.

## Data

The server shells out to `cx status --json`, `cx queue --json`, and `cx stack status --json`, and reads the task event log. It does not read `.env` files, container environments, or Claude transcripts.

Proof images, when a later test runner stores them, are served only from the configured task folder's test directory after `realpath` confirms they stay inside that directory.

## Screens

1. Board: one row per task, columns from the enabled phases, human gates highlighted.
2. Task: lanes, last check, event timeline, links to the plan, review, and report files.
3. Stack: lease holder, TTL, current image versus baseline, drift called out in red.
4. Queue: running ticket, waiters, cooldown remaining.
5. Proof: thumbnails from the test folder.
6. Pull requests: number, base branch, CI and review state from `gh`, cached for a minute.

## Explicitly absent

- No `/api/.../creds` route.
- No route returns environment variables or tokens.
- No password is written into an agent file so a model can type it.
