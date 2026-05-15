#!/usr/bin/env sh
set -eu

repo_name="${RUDDER_REPO_NAME:-repo}"
task="${RUDDER_TASK:-}"
snapshot_url="${RUDDER_SNAPSHOT_URL:-}"
cloud_url="${RUDDER_CLOUD_URL:-}"
sail_id="${RUDDER_SAIL_ID:-}"
worker_token="${RUDDER_WORKER_TOKEN:-}"

if [ -z "$snapshot_url" ]; then
  echo "RUDDER_SNAPSHOT_URL is required" >&2
  exit 2
fi

mkdir -p /workspace
cd /workspace

echo "Downloading Rudder snapshot..."
curl -fsSL "$snapshot_url" -o snapshot.tgz
mkdir -p unpacked
tar -xzf snapshot.tgz -C unpacked

if [ -d unpacked/home ]; then
  echo "Restoring selected HOME config..."
  cp -R unpacked/home/. "$HOME"/ 2>/dev/null || true
fi

if [ -d unpacked/repo ]; then
  mkdir -p "$repo_name"
  cp -R unpacked/repo/. "$repo_name"/
  cd "$repo_name"
else
  cd unpacked
fi

if [ ! -d .git ]; then
  echo "Initializing cloud git baseline..."
  git init -q
  git config user.email "rudder-cloud@local"
  git config user.name "Rudder Cloud"
  git add -A
  git commit -qm "rudder cloud baseline" || true
fi

echo "Rudder worker ready in $(pwd)"
rudder doctor || true

heartbeat() {
  while true; do
    curl -fsS -X POST "$cloud_url/api/rudder/sail/$sail_id/heartbeat" \
      -H "authorization: Bearer $worker_token" \
      -H "content-type: application/json" \
      -d '{"state":"running"}' >/dev/null 2>&1 || true
    sleep 30
  done
}

report_done() {
  state="$1"
  code="$2"
  if [ -n "$cloud_url" ] && [ -n "$sail_id" ] && [ -n "$worker_token" ]; then
    curl -fsS -X POST "$cloud_url/api/rudder/sail/$sail_id/heartbeat" \
      -H "authorization: Bearer $worker_token" \
      -H "content-type: application/json" \
      -d "{\"state\":\"$state\",\"exitCode\":$code}" >/dev/null 2>&1 || true
  fi
}

heartbeat_pid=""
if [ -n "$cloud_url" ] && [ -n "$sail_id" ] && [ -n "$worker_token" ]; then
  heartbeat &
  heartbeat_pid="$!"
fi

cleanup() {
  if [ -n "$heartbeat_pid" ]; then
    kill "$heartbeat_pid" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT INT TERM

if [ -n "$task" ]; then
  echo "Starting Rudder task: $task"
  set +e
  run_json="$(mktemp)"
  rudder codex --worktree --json "$task" >"$run_json"
  code="$?"
  if [ "$code" -eq 0 ]; then
    cat "$run_json"
    run_id="$(node -e 'const fs=require("fs"); const v=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); process.stdout.write(v.id || "");' "$run_json" 2>/dev/null || true)"
    if [ -n "$run_id" ]; then
      while true; do
        status="$(rudder runs --json | node -e 'const id=process.argv[1]; let s=""; process.stdin.on("data", d => s += d); process.stdin.on("end", () => { const runs=JSON.parse(s); const run=runs.find((r) => r.id === id); process.stdout.write(run?.status || "unknown"); });' "$run_id" 2>/dev/null || echo unknown)"
        echo "Rudder run $run_id status: $status"
        case "$status" in
          completed)
            code=0
            break
            ;;
          failed|cancelled)
            code=1
            break
            ;;
        esac
        sleep 10
      done
      rudder logs "$run_id" || true
      if [ "$code" -ne 0 ] && [ -f ".rudder/runs/$run_id/events.ndjson" ]; then
        echo "Raw Rudder events for failed run:"
        tail -n 80 ".rudder/runs/$run_id/events.ndjson" || true
      fi
    fi
  fi
  set -e
  if [ "$code" -eq 0 ]; then
    report_done completed "$code"
  else
    report_done failed "$code"
  fi
  exit "$code"
fi

rudder
