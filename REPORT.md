# Durable investigation runner

This is a scripted-provider proof that a headless process can persist, crash, and be driven from a socket. It is not an investigation, and it is not production-ready.

## Milestones

- M1: **PASS**
- M2: **PASS**
- M3: **PASS**
- M4: **PASS**

The package test covers the socket protocol. The pi-gui session below is the quit-and-reattach proof. This is still a scripted-provider proof, not a production runner.

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

Node v22.23.2. Re-run after the unix-socket and policy fixes, 2026-10-07T06:13:17Z. Exit code 0. 7 passed, 0 failed, 0 skipped. Duration about 2501 ms.

Typecheck on the same binary:

```
npm --prefix packages/workstream-runner run typecheck
```

Exit code 0.

Repo tests, with `PATH` preferring that same Node binary for this command only:

```
npm test
```

Re-run 2026-10-07T06:16:07Z with `PATH` preferring Node v22.23.2. Exit code 0. 29 passed, 0 failed, 0 skipped. Log lines that name HubSpot, Notion, or Asana are the existing in-process fakes.

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

## M4 detach (automated test)

| | |
|---|---|
| Parent pid (exited before the runner was checked) | 71012 |
| Runner pid | 71015 |
| Job id | b0b547c5-58e3-4b05-83c6-8d360872c618 |
| Checked at | 2026-10-07T06:13:18.466Z |

The parent was the `detach` command. Node `spawn` with `detached: true` starts a new session (`setsid`). The child ignores `SIGHUP`. The test then called the CLI `start` and `status`, and got the same job (`dispatchCount` 1). A different payload returned `conflict`. The test sent `SIGTERM` after that, so pid 71015 is not still running. The earlier automated proof (parent 54334, runner 54340, job `05c941b2-13c8-4ecd-a8eb-089c9679d3fb`, 2026-10-07T04:43:23.651Z) was the same shape.

Data directory mode `0700`, socket mode `0600`.

## M4 pi-gui session

Signed binary `/Applications/pi-gui.app`, `CFBundleShortVersionString` 1.0.1. macOS still refuses keystrokes (osascript 1002) and assistive access (-1719), so this session used the app's own terminal API (`ensureTerminalPanel` / `writeTerminal`) on a copy of that binary. The copy used `PI_APP_USER_DATA_DIR` so it did not take the existing single-instance lock. The shell was a real `/bin/zsh` whose parent was that pi-gui process. The app bundle was not modified.

| | |
|---|---|
| First pi-gui pid | 67509 (parent 1, started Wed Oct 7 01:02:55 2026 local) |
| Terminal shell | 68862, parent 67509, started 01:10:26 |
| Detach returned | pid 68929 at 2026-10-07T06:10:28Z local start |
| Runner after detach | 68929, parent 1, `src/main.ts serve --data /Users/zeke/.workstream-runner` |
| `start` key `case-gui` | job `707a8148-b20c-4004-b776-7553b6298c16`, `dispatchCount` 1, created 2026-10-07T06:14:39.418Z, status `running` |
| pi-gui quit | SIGTERM to 67509 at 2026-10-07T06:14:51Z. `pgrep` then reported no pi-gui process |
| Runner after quit | 68929 still parent 1 |
| Reopened pi-gui | 72008, parent 1, started after the quit |
| New terminal | zsh 72195, parent 72008, session `terminal-muxpr0s1-1` |
| `status` | same job id, `dispatchCount` 1, exit 0 |
| `start` same key and payload | same job id, `dispatchCount` still 1, exit 0, checked 2026-10-07T06:15:21Z |

`~/.workstream-runner` mode `0700`, `runner.sock` mode `0600`. The first `start` from that terminal, at 2026-10-07T06:11:03Z, exited 1 because Node 22.23 passes unix `connect()` as `[{path}, null]` and the guard rejected it. The guard now allows that shape and still rejects TCP. The successful `start` above is the one after that fix.

## Changed paths

- `packages/workstream-runner/package.json` — isolated package; tests and start pin the Node 22.23.2 binary.
- `packages/workstream-runner/package-lock.json` — lockfile for that package, including `pi-durable` 1.0.4.
- `packages/workstream-runner/tsconfig.json` — NodeNext typecheck with TypeScript extension imports.
- `packages/workstream-runner/.gitignore` — ignore local sqlite, logs, and `node_modules`.
- `packages/workstream-runner/launch.json` — absolute node path and serve entry.
- `packages/workstream-runner/config/policy.json` — trusted portal and the three excluded ids.
- `packages/workstream-runner/src/node-bin.ts` — the absolute node path.
- `packages/workstream-runner/src/offline.ts` — refuse TCP, DNS, and fetch; allow unix sockets, including Node 22.23's normalized connect arguments.
- `packages/workstream-runner/src/policy.ts` — fail-closed identity policy from local config only. An unprovable traverse keeps the identities it could parse and still denies the path.
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
- `packages/workstream-runner/test/m4-cli.test.ts` — socket protocol, CLI `start`/`status`, and parent-exit detach.
- `REPORT.md` — this file.

Existing repo source was not edited.

## What was not verified

- Typing the commands with the keyboard. Assistive access is denied, so the signed app's terminal API wrote the lines into its PTY. The shell's parent was still pi-gui.
- The pre-existing Dock process (pid 22629) was not the process that was quit. It was already gone before the quit step. The process that was quit is pid 67509, the signed v1.0.1 binary whose terminal started the runner.
- Behavior against a live model or a live HubSpot portal. The faux provider does not speak for investigation quality.
- An OS firewall. Offline is an in-process guard on `net`, `http`, `https`, `dns`, and `fetch`. The successful scripted runs recorded `networkAttempts=0`. A dependency that opened a socket without those APIs would not be caught.
- `ps` during the sandboxed first attempt. That attempt is not the M2 proof.

## Live calls, writes, and global changes

Checked:

- No `smoke:hubspot:live` run, and no HubSpot, Notion, or Asana client was called from the runner. The root `npm test` log lines are the existing in-process fakes.
- Env files were not read. Byte counts only: `clients/apartment-life/.env` 189, `clients/apartment-life/.env.example` 71, `clients/optidge/.env` 71, `clients/optidge/.env.example` 71, `.env` 359, `.env.example` 287.
- `~/.pi/agent` was not opened or modified. The installed pi-gui bundle was not modified. The ceremony launched the signed binary with a separate `PI_APP_USER_DATA_DIR` (`/tmp/pi-m4-userdata`, then `/tmp/pi-m4-userdata-reopen`) and a localhost debug port. Those processes, and the runner pid 68929, were stopped with SIGTERM at 2026-10-07T06:16:35Z after the reattach proof. No launchd job was added.
- No `nvm alias`, shell startup edit, `brew` change, or launchd job. `launchctl list` had no workstream or pi-durable entry.
- No production CRM write, comment, message, enrichment, or sync. The three excluded ids are only in the deny policy and tests. Fixture fetches use ticket `10000000001` and deal `10000000002`.
