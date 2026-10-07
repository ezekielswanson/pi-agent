# Durable investigation runner

This is a scripted-provider proof that a headless process can persist, crash, and be driven from a socket. It is not an investigation, and it is not production-ready.

## Milestones

- M1: **PASS**
- M2: **PASS**
- M3: **PASS**
- M4: **FAIL**

M4's package test passed (detached process, idempotent `start`, restrictive socket). The required session inside pi-gui v1.0.1 did not. macOS refused keystrokes (`osascript` error 1002: not allowed to send keystrokes), so the runner was never started from pi-gui's terminal. pi-gui was left running (pid 22629). It was not quit, and it was not reopened for a second terminal.

## Durable

Installed version: `@earendil-works/pi-durable` **1.0.4** (Node engine `>=22.19.0`).

Value exports actually called:

- `Harness`
- `createRegistry`
- `defineExtension`
- `defineTool`
- `defineDoc`
- `openNodeSqliteStorage` from `@earendil-works/pi-durable/storage/sqlite/node`

Type-only names also imported: `Conversation`, `ConversationId`, `Submission`, `SubmissionId`, `Harness`.

`CodingTools` was not imported. The model path is `fauxProvider` from `@earendil-works/pi-ai` 1.0.4 (`createModels`, `fauxAssistantMessage`, `fauxToolCall`, `Type`). Context is `BACKGROUND_CONTEXT` from `@earendil-works/chord/context`.

Launch node, including `launch.json` and the test script, is `/Users/zeke/.nvm/versions/node/v22.23.2/bin/node`. The default shell node was not changed.

## Commands

Runner typecheck, after the `allowImportingTsExtensions` fix:

```
npm --prefix packages/workstream-runner run typecheck
```

Exit code 0.

Runner tests (the first sandboxed run failed: `ps`/`kill`/unix-socket `EPERM`, and one URL form parsed as `unprovable`. The run below is outside the sandbox, after those fixes):

```
npm --prefix packages/workstream-runner run test
```

Node v22.23.2. Exit code 0. 7 passed, 0 failed, 0 skipped. Duration about 2093 ms.

Repo tests, with `PATH` preferring that same Node binary for this command only:

```
npm test
```

Exit code 0. 29 passed, 0 failed, 0 skipped.

## M2 kill

Real `kill -9` from the test process (`execFileSync("kill", ["-9", pid])`), not a thrown exception.

| | |
|---|---|
| Killed pid | 54335 |
| Killed at | 2026-10-07T04:43:23.179Z |
| Signal | 9 (`SIGKILL`, exit code null) |
| Resume pid | 54395 |
| Resume process started | 2026-10-07T04:43:23.547Z |

Step-completion record left in SQLite: `fetch_record` only, pid 54335, at 2026-10-07T04:43:23.112Z.

Execution records: `fetch_record` pid 54335 at 2026-10-07T04:43:23.101Z, and `walk_associations` pid 54335 at 2026-10-07T04:43:23.123Z. The resume process did not append another execution. The walk tool result was an error whose text contained `interrupted`.

## M4 detach (automated test only)

| | |
|---|---|
| Parent pid (exited before the runner was checked) | 54334 |
| Runner pid | 54340 |
| Job id | 05c941b2-13c8-4ecd-a8eb-089c9679d3fb |
| Checked at | 2026-10-07T04:43:23.651Z |

The parent was the `detach` command. Node `spawn` with `detached: true` starts a new session (`setsid`). The child ignores `SIGHUP`. The test then called `status` and `start` with the same key and got the same job (`dispatchCount` 1). A different payload returned `conflict`. The test sent `SIGTERM` after that, so pid 54340 is not still running.

Data directory mode `0700`, socket mode `0600`.

pi-gui ceremony: **not run**. No second set of PIDs exists for a quit/reopen.

## Changed paths

- `packages/workstream-runner/package.json` — isolated package; tests and start pin the Node 22.23.2 binary.
- `packages/workstream-runner/package-lock.json` — lockfile for that package, including `pi-durable` 1.0.4.
- `packages/workstream-runner/tsconfig.json` — NodeNext typecheck with TypeScript extension imports.
- `packages/workstream-runner/.gitignore` — ignore local sqlite, logs, and `node_modules`.
- `packages/workstream-runner/launch.json` — absolute node path and serve entry.
- `packages/workstream-runner/config/policy.json` — trusted portal and the three excluded ids.
- `packages/workstream-runner/src/node-bin.ts` — the absolute node path.
- `packages/workstream-runner/src/offline.ts` — refuse TCP, DNS, and fetch; allow unix sockets.
- `packages/workstream-runner/src/policy.ts` — fail-closed identity policy from local config only.
- `packages/workstream-runner/src/access.ts` — fetch local fixtures only after an allow decision.
- `packages/workstream-runner/src/investigation-doc.ts` — SQLite-backed execution and step records.
- `packages/workstream-runner/src/tools.ts` — three synthetic tools, replay unsafe, no coding tools.
- `packages/workstream-runner/src/script.ts` — canned model turns from the committed transcript.
- `packages/workstream-runner/src/session.ts` — one Harness over one SQLite file.
- `packages/workstream-runner/src/jobs.ts` — request key persisted before dispatch.
- `packages/workstream-runner/src/server.ts` — unix-socket ops: health, start, list, get, cancel, subscribe, status.
- `packages/workstream-runner/src/client.ts` — one JSON line per call.
- `packages/workstream-runner/src/runner.ts` — one-shot run and resume against the same store.
- `packages/workstream-runner/src/detach.ts` — detached serve on the absolute node path.
- `packages/workstream-runner/src/main.ts` — CLI entry.
- `packages/workstream-runner/test/helpers.ts` — spawn the runner with the absolute node path.
- `packages/workstream-runner/test/m1-persist.test.ts` — persisted investigation, offline guard.
- `packages/workstream-runner/test/m2-crash.test.ts` — real `kill -9` and resume.
- `packages/workstream-runner/test/m3-policy.test.ts` — alias, URL, association, search, and evidence tests.
- `packages/workstream-runner/test/m4-cli.test.ts` — socket protocol and parent-exit detach.
- `REPORT.md` — this file.

Existing repo source was not edited.

## What was not verified

- Starting the runner from a terminal inside pi-gui v1.0.1, quitting the app, seeing the process in `ps`, reopening pi-gui, and reattaching with `status` / `start`.
- Behavior against a live model or a live HubSpot portal. The faux provider does not speak for investigation quality.
- An OS firewall. Offline is an in-process guard on `net`, `http`, `https`, `dns`, and `fetch`. The successful runs recorded `networkAttempts=0`. A dependency that opened a socket without those APIs would not be caught.
- `ps` during the sandboxed first attempt. That attempt is not the M2 proof.

## Live calls, writes, and global changes

Checked:

- No `smoke:hubspot:live` run, and no HubSpot, Notion, or Asana client was called from the runner. The root `npm test` log lines are the existing in-process fakes.
- Env files were not read. Byte counts only: `clients/apartment-life/.env` 189, `clients/apartment-life/.env.example` 71, `clients/optidge/.env` 71, `clients/optidge/.env.example` 71, `.env` 359, `.env.example` 287.
- `~/.pi/agent` was not opened or modified. The installed pi-gui bundle was not modified. pi-gui stayed pid 22629.
- No `nvm alias`, shell startup edit, `brew` change, or launchd job. `launchctl list` had no workstream or pi-durable entry.
- No production CRM write, comment, message, enrichment, or sync. The three excluded ids are only in the deny policy and tests. Fixture fetches use ticket `10000000001` and deal `10000000002`.
