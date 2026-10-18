# Subagents lab

This is a trial of [pi-subagents](https://github.com/nicobailon/pi-subagents) 0.79.1 and pi-web-access 0.42.0 on Pi 1.3.0 (`@earendil-works/pi-coding-agent`). The rest of this repo still documents Pi 0.85.1 for the HubSpot, Notion, and Asana agent. This trial does not change that pin.

## Setup

From the repo root, with Pi 1.3.0 on `PATH`:

```bash
bash scripts/setup-subagents.sh
```

The script stops unless `pi --version` prints `1.3.0`. It then runs these commands from the repo root:

```bash
pi install -l npm:pi-subagents@0.79.1
pi install -l npm:pi-web-access@0.42.0
```

Pi 1.3 writes a project package as the string `npm:name@version` in `.pi/settings.json`. Those two pins are already listed there, next to `npm:pi-mcp-adapter`. Versioned npm specs are skipped by `pi update`.

Pi 1.3 refuses `pi install -l` when the project is not trusted, and a non-interactive run does not prompt. If the script stops with that message, rerun the same install with `--approve`. This repo already uses `--approve` for `pi-mcp-adapter`. `--approve` applies to that command only. It does not edit `~/.pi/agent/settings.json`.

The script then creates or merges `~/.pi/agent/extensions/subagent/config.json`:

```json
{
  "parallel": { "concurrency": 3 },
  "globalConcurrencyLimit": 4,
  "maxSubagentDepth": 1
}
```

If that file already exists, Node merges those keys and keeps every other key. `parallel.concurrency` is merged into an existing `parallel` object. A timestamped `config.json.bak.<time>` backup is written only when the merge changes the file. A second run that already has these values leaves the file alone. Invalid JSON is left untouched. The script does not read or write any other path under `~/.pi`.

## Global config

`~/.pi/agent/extensions/subagent/config.json` is user-global. The same concurrency and depth limits apply to every Pi project on this machine, including pi-apartment-life, not only this lab.

## Not for pi-apartment-life yet

Do not use subagents in pi-apartment-life until its safety PR lands. That change has to:

- force children to load the harness with `registerRequiredChildExtensions` and `requireForAllRunners`
- block the gate, verify, external-runner, machine, and schedule options
- stop children from inheriting `.env`

## How to fan out

The built-in `scout` can write. In pi-subagents 0.79.1 its tools are `read`, `grep`, `find`, `ls`, `bash`, `write`, and `contact_supervisor`. Use `al-scout` (`.pi/agents/al-scout.md`) for Apartment Life, HubSpot, Notion, and Asana research in this repo. Its tools are only `read`, `grep`, `find`, and `ls`. It does not load project extensions, so it cannot call MCP.

Fan out only read-only work. Keep 4 or fewer children at once. Keep writes in the parent.

## Try it

Start `pi` in this repo and trust the project, then:

- `/subagents-doctor`
- `Use oracle to challenge this plan`
- `/parallel-research`
- `Use al-scout to map Apartment Life research sources in this repo`

Checked against pi-subagents 0.79.1: `parallel.concurrency`, `globalConcurrencyLimit`, and `maxSubagentDepth` are keys in `~/.pi/agent/extensions/subagent/config.json`. `/subagents-doctor` and `/parallel-research` are the published command names (`prompts/parallel-research.md`). Nothing in this lab was renamed.
