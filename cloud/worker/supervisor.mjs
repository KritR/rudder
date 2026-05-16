#!/usr/bin/env node
// Rudder cloud worker supervisor.
// 1. Stages the snapshot into /workspace.
// 2. Spawns `rudder` (or `rudder codex --worktree --json "$task"`) under a PTY.
// 3. Bridges PTY stdin/stdout to a control-plane WebSocket so a remote
//    `rudder cloud attach <id>` session can drive the worker live.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import pty from "node-pty";

const cloudUrl = (process.env.RUDDER_CLOUD_URL || "").trim();
const sailId = (process.env.RUDDER_SAIL_ID || "").trim();
const workerToken = (process.env.RUDDER_WORKER_TOKEN || "").trim();
const snapshotUrl = (process.env.RUDDER_SNAPSHOT_URL || "").trim();
const repoName = (process.env.RUDDER_REPO_NAME || "repo").trim() || "repo";
const task = process.env.RUDDER_TASK || "";

if (!snapshotUrl) {
  console.error("RUDDER_SNAPSHOT_URL is required");
  process.exit(2);
}

stageSnapshot();

const cwd = process.cwd();
console.log(`Rudder worker ready in ${cwd}`);
sh("rudder doctor || true");

const command = "rudder";
const args = task ? ["codex", "--worktree", task] : [];

const term = pty.spawn(command, args, {
  name: "xterm-256color",
  cols: 120,
  rows: 32,
  cwd,
  env: {
    ...process.env,
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    RUDDER_HEADLESS: "0",
  },
});

let ws = null;
let wsReadyPromise = connect();
let lastReportedState = "running";
let exited = false;
let heartbeatTimer = setInterval(reportHeartbeat, 30000);
reportHeartbeat();

term.onData((data) => {
  process.stdout.write(data);
  const socket = ws;
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(Buffer.from(data, "utf8"), { binary: true });
  }
});

term.onExit(({ exitCode, signal }) => {
  exited = true;
  clearInterval(heartbeatTimer);
  const state = exitCode === 0 ? "completed" : "failed";
  reportDone(state, exitCode ?? (signal ? 128 + signal : 1));
  const socket = ws;
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: "exit", code: exitCode, signal: signal ?? null }));
    socket.close(1000, "worker-exit");
  }
  setTimeout(() => process.exit(exitCode ?? 1), 250).unref();
});

process.on("SIGTERM", () => {
  if (!exited) {
    term.kill("SIGTERM");
  }
});
process.on("SIGINT", () => {
  if (!exited) {
    term.kill("SIGINT");
  }
});

function connect() {
  if (!cloudUrl || !sailId || !workerToken) {
    return Promise.resolve(null);
  }
  const wsUrl = cloudUrl.replace(/^http/, "ws").replace(/\/$/, "")
    + `/api/rudder/sail/${encodeURIComponent(sailId)}/worker`;
  return new Promise((resolve) => {
    let connected = false;
    const socket = new WebSocket(wsUrl, {
      headers: { authorization: `Bearer ${workerToken}` },
    });
    socket.binaryType = "nodebuffer";
    socket.on("open", () => {
      connected = true;
      ws = socket;
      socket.send(JSON.stringify({
        type: "hello",
        cols: term.cols,
        rows: term.rows,
        sailId,
      }));
      resolve(socket);
    });
    socket.on("message", (data, isBinary) => {
      if (exited) {
        return;
      }
      if (isBinary && Buffer.isBuffer(data)) {
        term.write(data.toString("utf8"));
        return;
      }
      const text = Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
      handleControl(text);
    });
    const reschedule = () => {
      if (exited) {
        return;
      }
      ws = null;
      setTimeout(() => { wsReadyPromise = connect(); }, 2000);
    };
    socket.on("close", reschedule);
    socket.on("error", () => {
      if (!connected) {
        try { socket.terminate(); } catch { /* ignore */ }
        resolve(null);
      }
    });
  });
}

function handleControl(text) {
  let payload = null;
  try {
    payload = JSON.parse(text);
  } catch {
    return;
  }
  if (!payload || typeof payload !== "object") {
    return;
  }
  if (payload.type === "resize" && Number.isFinite(payload.cols) && Number.isFinite(payload.rows)) {
    const cols = Math.max(20, Math.min(500, Math.floor(payload.cols)));
    const rows = Math.max(5, Math.min(200, Math.floor(payload.rows)));
    try {
      term.resize(cols, rows);
    } catch {
      // ignore
    }
    return;
  }
  if (payload.type === "signal" && typeof payload.name === "string") {
    try {
      term.kill(payload.name);
    } catch {
      // ignore
    }
  }
}

function stageSnapshot() {
  fs.mkdirSync("/workspace", { recursive: true });
  process.chdir("/workspace");
  console.log("Downloading Rudder snapshot...");
  sh(`curl -fsSL ${shQuote(snapshotUrl)} -o snapshot.tgz`);
  fs.mkdirSync("unpacked", { recursive: true });
  sh("tar -xzf snapshot.tgz -C unpacked");
  if (fs.existsSync("unpacked/home")) {
    console.log("Restoring selected HOME config...");
    const home = os.homedir() || process.env.HOME || "/root";
    sh(`cp -R unpacked/home/. ${shQuote(home + "/")} 2>/dev/null || true`);
    sh(`find ${shQuote(home)} -name '._*' -delete 2>/dev/null || true`);
  }
  let workdir;
  if (fs.existsSync("unpacked/repo")) {
    workdir = path.join("/workspace", repoName);
    fs.mkdirSync(workdir, { recursive: true });
    sh(`cp -R unpacked/repo/. ${shQuote(workdir + "/")}`);
  } else {
    workdir = "/workspace/unpacked";
  }
  process.chdir(workdir);
  if (!fs.existsSync(".git")) {
    console.log("Initializing cloud git baseline...");
    sh("git init -q");
    sh('git config user.email "rudder-cloud@local"');
    sh('git config user.name "Rudder Cloud"');
    sh("git add -A");
    sh('git commit -qm "rudder cloud baseline" || true');
  }
}

function reportHeartbeat() {
  if (!cloudUrl || !sailId || !workerToken) {
    return;
  }
  const url = `${cloudUrl.replace(/\/$/, "")}/api/rudder/sail/${encodeURIComponent(sailId)}/heartbeat`;
  fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${workerToken}`,
    },
    body: JSON.stringify({ state: lastReportedState }),
  }).catch(() => undefined);
}

function reportDone(state, code) {
  lastReportedState = state;
  if (!cloudUrl || !sailId || !workerToken) {
    return;
  }
  const url = `${cloudUrl.replace(/\/$/, "")}/api/rudder/sail/${encodeURIComponent(sailId)}/heartbeat`;
  // best-effort fire-and-forget; we exit shortly after
  fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${workerToken}`,
    },
    body: JSON.stringify({ state, exitCode: code }),
  }).catch(() => undefined);
}

function sh(cmd) {
  const result = spawnSync("sh", ["-lc", cmd], { stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`command failed (${result.status}): ${cmd}`);
  }
}

function shQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}
