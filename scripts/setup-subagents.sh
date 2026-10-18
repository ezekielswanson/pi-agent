#!/usr/bin/env bash
# Pin the subagent lab packages for this repo and merge the global pi-subagents config.
# The only path under ~/.pi this script writes is
# ~/.pi/agent/extensions/subagent/config.json, plus a timestamped backup of that file
# when a merge changes it.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

EXPECTED_PI_VERSION="1.3.0"

if ! command -v pi >/dev/null 2>&1; then
  echo "pi is not on PATH. Install @earendil-works/pi-coding-agent@${EXPECTED_PI_VERSION}, then rerun this script." >&2
  exit 1
fi

version_err="$(mktemp)"
cleanup() {
  rm -f "$version_err"
}
trap cleanup EXIT

if ! pi_version="$(pi --version 2>"$version_err")"; then
  echo "pi --version failed. This lab needs Pi ${EXPECTED_PI_VERSION}." >&2
  if [[ -s "$version_err" ]]; then
    cat "$version_err" >&2
  fi
  exit 1
fi

# Pi 1.3 prints the bare version on stdout, for example: 1.3.0
pi_version="${pi_version%%$'\n'*}"
pi_version="${pi_version%$'\r'}"
pi_version="$(printf '%s' "$pi_version" | tr -d '[:space:]')"

if [[ "$pi_version" != "$EXPECTED_PI_VERSION" ]]; then
  echo "This lab needs Pi ${EXPECTED_PI_VERSION} (@earendil-works/pi-coding-agent)." >&2
  echo "pi --version reported: ${pi_version:-<empty>}" >&2
  exit 1
fi

install_local() {
  local spec="$1"
  echo "Running: pi install -l ${spec}"
  if ! pi install -l "$spec"; then
    echo "pi install -l ${spec} failed." >&2
    echo "Pi 1.3 refuses a project install when this repo is not trusted, and a non-interactive run does not prompt." >&2
    echo "If Pi said the project is not trusted, rerun that same install with --approve." >&2
    echo "This repo already uses --approve for pi-mcp-adapter. --approve applies to that command only and does not edit ~/.pi/agent/settings.json." >&2
    exit 1
  fi
}

install_local "npm:pi-subagents@0.79.1"
install_local "npm:pi-web-access@0.42.0"

if [[ -z "${HOME:-}" ]]; then
  echo "HOME is unset. Refusing to guess a path under ~/.pi." >&2
  exit 1
fi

config_path="${HOME%/}/.pi/agent/extensions/subagent/config.json"

PI_SUBAGENT_CONFIG="$config_path" node <<'END_NODE'
const fs = require("node:fs");
const path = require("node:path");

const configPath = process.env.PI_SUBAGENT_CONFIG;
const configSuffix = `${path.sep}.pi${path.sep}agent${path.sep}extensions${path.sep}subagent${path.sep}config.json`;
const dirSuffix = `${path.sep}.pi${path.sep}agent${path.sep}extensions${path.sep}subagent`;

function refuse(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

if (!configPath || !path.resolve(configPath).endsWith(configSuffix)) {
  refuse("Refusing to write subagent config: unexpected path.");
}

function insideHome(target) {
  const home = process.env.HOME;
  if (!home) refuse("HOME is unset. Refusing to write subagent config.");
  const homeReal = fs.realpathSync(home);
  const real = fs.realpathSync(target);
  const prefix = homeReal.endsWith(path.sep) ? homeReal : `${homeReal}${path.sep}`;
  if (real !== homeReal && !real.startsWith(prefix)) {
    refuse(`Refusing to touch ${target}: it resolves outside the home directory.`);
  }
  return real;
}

function nearestExisting(start) {
  let current = path.resolve(start);
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return current;
    current = parent;
  }
  return current;
}

const desiredParallel = { concurrency: 3 };
const desired = {
  parallel: desiredParallel,
  globalConcurrencyLimit: 4,
  maxSubagentDepth: 1,
};

function stamp() {
  const d = new Date();
  const p = (n, width = 2) => String(n).padStart(width, "0");
  return [
    String(d.getFullYear()),
    p(d.getMonth() + 1),
    p(d.getDate()),
    "T",
    p(d.getHours()),
    p(d.getMinutes()),
    p(d.getSeconds()),
    p(d.getMilliseconds(), 3),
  ].join("");
}

function assertConfigLocation() {
  const anchor = nearestExisting(configPath);
  const anchorReal = insideHome(anchor);
  if (fs.existsSync(configPath)) {
    const realFile = insideHome(configPath);
    if (!realFile.endsWith(configSuffix)) {
      refuse(`Refusing to update ${configPath}: it does not resolve to the subagent config file.`);
    }
    return;
  }
  if (anchorReal !== fs.realpathSync(process.env.HOME) && !anchorReal.endsWith(dirSuffix)) {
    const allowed =
      anchorReal.endsWith(`${path.sep}.pi`) ||
      anchorReal.endsWith(`${path.sep}.pi${path.sep}agent`) ||
      anchorReal.endsWith(`${path.sep}.pi${path.sep}agent${path.sep}extensions`) ||
      anchorReal.endsWith(dirSuffix);
    if (!allowed) {
      refuse(`Refusing to create ${configPath}: a parent path resolves outside the subagent config directory.`);
    }
  }
}

function writeConfig(value) {
  assertConfigLocation();
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const dirStat = fs.lstatSync(path.dirname(configPath));
  if (dirStat.isSymbolicLink()) {
    refuse(`Refusing to write ${configPath}: parent directory is a symlink.`);
  }
  const dirReal = insideHome(path.dirname(configPath));
  if (!dirReal.endsWith(dirSuffix)) {
    refuse(`Refusing to write ${configPath}: directory resolves outside the subagent config directory.`);
  }
  fs.writeFileSync(configPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o644 });
}

if (!fs.existsSync(configPath)) {
  writeConfig(desired);
  process.stdout.write(`Created ${configPath}\n`);
  process.exit(0);
}

assertConfigLocation();

const existingStat = fs.lstatSync(configPath);
if (existingStat.isSymbolicLink()) {
  process.stderr.write(`Refusing to update ${configPath}: it is a symlink. The file was not changed.\n`);
  process.exit(1);
}
if (!existingStat.isFile()) {
  process.stderr.write(`Refusing to update ${configPath}: it is not a regular file. The file was not changed.\n`);
  process.exit(1);
}

let parsed;
try {
  parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`Refusing to merge ${configPath}: not valid JSON (${message}). The file was not changed.\n`);
  process.exit(1);
}

if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
  process.stderr.write(`Refusing to merge ${configPath}: expected a JSON object. The file was not changed.\n`);
  process.exit(1);
}

const currentParallel = parsed.parallel;
const parallelOk =
  currentParallel !== null &&
  typeof currentParallel === "object" &&
  !Array.isArray(currentParallel) &&
  currentParallel.concurrency === 3;
const alreadySet = parallelOk && parsed.globalConcurrencyLimit === 4 && parsed.maxSubagentDepth === 1;

if (alreadySet) {
  process.stdout.write(`${configPath} already has the lab limits. Left it unchanged.\n`);
  process.exit(0);
}

const next = { ...parsed };
if (
  currentParallel !== null &&
  typeof currentParallel === "object" &&
  !Array.isArray(currentParallel)
) {
  next.parallel = { ...currentParallel, ...desiredParallel };
} else {
  next.parallel = { ...desiredParallel };
}
next.globalConcurrencyLimit = desired.globalConcurrencyLimit;
next.maxSubagentDepth = desired.maxSubagentDepth;

let backup = `${configPath}.bak.${stamp()}`;
if (fs.existsSync(backup)) {
  backup = `${backup}-${process.pid}`;
}
fs.copyFileSync(configPath, backup);
writeConfig(next);
process.stdout.write(`Updated ${configPath}\nBackup ${backup}\n`);
END_NODE

cat <<'EOF'

Next steps:
  1. Start pi in this repo.
  2. Run /subagents-doctor
  3. Try: Use oracle to challenge this plan
  4. Try: /parallel-research
  5. Try: Use al-scout to map Apartment Life research sources in this repo
EOF
