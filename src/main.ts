import { spawn } from "node:child_process";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { authStoreExists, runDoctor, runOnboard } from "./auth.js";
import { runCloudCommand } from "./cloud.js";
import { findRepoRoot } from "./git.js";
import { discoverModelOptions } from "./models.js";
import { resolveNativeBinaryPath } from "./native-binary.js";
import {
  cleanupRuns,
  deleteRun,
  listProjectRuns,
  mergeRun,
  printLogs,
  startRun,
  statusRuns,
  stopRun,
  watchRun,
  workerRun,
} from "./run-manager.js";
import { runInteractiveShell } from "./repl.js";
import { runTmuxAgentPane, runTmuxTaskPane, runTmuxWorkerIdle } from "./tmux-dashboard.js";
import { runInteractiveTui } from "./tui.js";
import type { BackendId } from "./types.js";
import { commandExists, isTty, runCommand } from "./util.js";
import { attachTmuxSession, ensureTmuxDashboardSession, hasTmux, repoTmuxSessionName, shellCommand } from "./tmux.js";

type Parsed = {
  command?: string;
  args: string[];
  flags: {
    json?: boolean;
    quiet?: boolean;
    detach?: boolean;
    watch?: boolean;
    follow?: boolean;
    worktree?: boolean;
    queue?: boolean;
    allowDirty?: boolean;
    force?: boolean;
    nonInteractive?: boolean;
    model?: string;
    backend?: BackendId;
    cwd?: string;
    repo?: string;
    run?: string;
    help?: boolean;
    version?: boolean;
    noTmux?: boolean;
    noNative?: boolean;
    headless?: boolean;
    tmuxSession?: string;
    homePaths?: string[];
  };
};

export async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.flags.version || parsed.command === "version") {
    console.log(await packageVersion());
    return;
  }
  if (parsed.flags.cwd) {
    process.chdir(parsed.flags.cwd);
  }
  if (!parsed.command || parsed.flags.help) {
    if (!parsed.command && parsed.args.length > 0) {
      await maybeOnboard();
      await startRun({
        task: parsed.args.join(" "),
        backend: parsed.flags.backend,
        model: parsed.flags.model,
        detach: parsed.flags.detach,
        worktree: parsed.flags.worktree,
        queue: parsed.flags.queue,
        json: parsed.flags.json,
        view: "shell",
      });
      return;
    }
    if (!parsed.command && isTty() && !parsed.flags.help) {
      await maybeOnboard();
      await openDashboard(parsed);
      return;
    }
    printHelp();
    return;
  }

  switch (parsed.command) {
    case "__agents": {
      const repo = parsed.flags.repo;
      const tmuxSessionName = parsed.flags.tmuxSession;
      if (!repo || !tmuxSessionName) {
        throw new Error("__agents requires --repo and --tmux-session");
      }
      process.chdir(repo);
      await runTmuxAgentPane({
        tmuxSessionName,
        backend: parsed.flags.backend,
        model: parsed.flags.model,
      });
      return;
    }
    case "__task": {
      const repo = parsed.flags.repo;
      const tmuxSessionName = parsed.flags.tmuxSession;
      if (!repo || !tmuxSessionName) {
        throw new Error("__task requires --repo and --tmux-session");
      }
      process.chdir(repo);
      await runTmuxTaskPane({
        tmuxSessionName,
        backend: parsed.flags.backend,
        model: parsed.flags.model,
      });
      return;
    }
    case "__worker-idle": {
      const repo = parsed.flags.repo;
      const tmuxSessionName = parsed.flags.tmuxSession;
      if (!repo || !tmuxSessionName) {
        throw new Error("__worker-idle requires --repo and --tmux-session");
      }
      process.chdir(repo);
      await runTmuxWorkerIdle({
        tmuxSessionName,
        backend: parsed.flags.backend,
        model: parsed.flags.model,
      });
      return;
    }
    case "tmux":
      await maybeOnboard();
      await openTmuxDashboard(parsed);
      return;
    case "dashboard":
      await maybeOnboard();
      await openDashboard(parsed);
      return;
    case "mouse-test":
      await runNativeCommand(["mouse-test", ...parsed.args]);
      return;
    case "tui":
      await maybeOnboard();
      await runInteractiveTui({
        backend: parsed.flags.backend,
        model: parsed.flags.model,
        worktree: parsed.flags.worktree,
        detach: parsed.flags.detach,
      });
      return;
    case "shell":
    case "interactive":
      await maybeOnboard();
      await runInteractiveTui({
        backend: parsed.flags.backend,
        model: parsed.flags.model,
        worktree: parsed.flags.worktree,
        detach: parsed.flags.detach,
      });
      return;
    case "legacy-shell":
      await maybeOnboard();
      await runInteractiveShell({
        backend: parsed.flags.backend,
        model: parsed.flags.model,
        worktree: parsed.flags.worktree,
        detach: parsed.flags.detach,
      });
      return;
    case "__worker": {
      const repo = parsed.flags.repo;
      const run = parsed.flags.run;
      if (!repo || !run) {
        throw new Error("__worker requires --repo and --run");
      }
      await workerRun(repo, run);
      return;
    }
    case "onboard":
      await runOnboard({
        nonInteractive: parsed.flags.nonInteractive,
        json: parsed.flags.json,
      });
      return;
    case "doctor":
      await runDoctor({ json: parsed.flags.json });
      return;
    case "login":
      await runCloudCommand("cloud", ["login", ...parsed.args], {
        json: parsed.flags.json,
        homePaths: parsed.flags.homePaths,
      });
      return;
    case "cloud":
    case "sail":
      await runCloudCommand(parsed.command, parsed.args, {
        json: parsed.flags.json,
        homePaths: parsed.flags.homePaths,
      });
      return;
    case "run": {
      await maybeOnboard();
      const task = parsed.args.join(" ").trim();
      if (!task) {
        throw new Error("Missing task. Usage: rudder run \"fix the tests\"");
      }
      await startRun({
        task,
        backend: parsed.flags.backend,
        model: parsed.flags.model,
        detach: parsed.flags.detach,
        worktree: parsed.flags.worktree,
        queue: parsed.flags.queue,
        json: parsed.flags.json,
        view: "shell",
      });
      return;
    }
    case "claude":
    case "codex": {
      await maybeOnboard();
      const task = parsed.args.join(" ").trim();
      if (!task) {
        throw new Error(`Missing task. Usage: rudder ${parsed.command} "fix the tests"`);
      }
      await startRun({
        task,
        backend: parsed.command,
        model: parsed.flags.model,
        detach: parsed.flags.detach,
        worktree: parsed.flags.worktree,
        queue: parsed.flags.queue,
        json: parsed.flags.json,
        view: "shell",
      });
      return;
    }
    case "acpx": {
      await maybeOnboard();
      const args = parsed.args[0] === "codex" ? parsed.args.slice(1) : parsed.args;
      const task = args.join(" ").trim();
      if (!task) {
        throw new Error('Missing task. Usage: rudder acpx codex "fix the tests"');
      }
      await startRun({
        task,
        backend: "acpx",
        model: parsed.flags.model,
        detach: parsed.flags.detach,
        worktree: parsed.flags.worktree,
        queue: parsed.flags.queue,
        json: parsed.flags.json,
        view: "shell",
      });
      return;
    }
    case "watch":
      await watchRun({ runId: parsed.args[0], follow: true });
      return;
    case "logs":
      await printLogs(parsed.args[0], Boolean(parsed.flags.follow));
      return;
    case "status":
      await statusRuns({ json: parsed.flags.json });
      return;
    case "runs":
      await listProjectRuns({ json: parsed.flags.json });
      return;
    case "stop": {
      const run = parsed.args[0];
      if (!run) {
        throw new Error("Missing run id.");
      }
      await stopRun(run);
      return;
    }
    case "delete": {
      const run = parsed.args[0];
      if (!run) {
        throw new Error("Missing run id.");
      }
      await deleteRun(run, { force: Boolean(parsed.flags.force) });
      return;
    }
    case "merge": {
      const run = parsed.args[0];
      if (!run) {
        throw new Error("Missing run id.");
      }
      await mergeRun(run, Boolean(parsed.flags.allowDirty));
      return;
    }
    case "cleanup":
      await cleanupRuns(Boolean(parsed.flags.force));
      return;
    default: {
      await maybeOnboard();
      await startRun({
        task: [parsed.command, ...parsed.args].join(" "),
        backend: parsed.flags.backend,
        model: parsed.flags.model,
        detach: parsed.flags.detach,
        worktree: parsed.flags.worktree,
        queue: parsed.flags.queue,
        json: parsed.flags.json,
        view: "shell",
      });
    }
  }
}

function parseArgs(argv: string[]): Parsed {
  const parsed: Parsed = { args: [], flags: {} };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? "";
    if (arg === "--") {
      parsed.args.push(...argv.slice(i + 1));
      break;
    }
    if (arg === "--help" || arg === "-h") {
      parsed.flags.help = true;
      continue;
    }
    if (arg === "--version" || arg === "-v") {
      parsed.flags.version = true;
      continue;
    }
    if (arg === "--json") {
      parsed.flags.json = true;
      continue;
    }
    if (arg === "--quiet" || arg === "-q") {
      parsed.flags.quiet = true;
      continue;
    }
    if (arg === "--detach" || arg === "-d") {
      parsed.flags.detach = true;
      continue;
    }
    if (arg === "--watch") {
      parsed.flags.watch = true;
      continue;
    }
    if (arg === "--follow" || arg === "-f") {
      parsed.flags.follow = true;
      continue;
    }
    if (arg === "--worktree") {
      parsed.flags.worktree = true;
      continue;
    }
    if (arg === "--queue") {
      parsed.flags.queue = true;
      continue;
    }
    if (arg === "--allow-dirty") {
      parsed.flags.allowDirty = true;
      continue;
    }
    if (arg === "--force") {
      parsed.flags.force = true;
      continue;
    }
    if (arg === "--non-interactive") {
      parsed.flags.nonInteractive = true;
      continue;
    }
    if (arg === "--no-tmux") {
      parsed.flags.noTmux = true;
      continue;
    }
    if (arg === "--no-native") {
      parsed.flags.noNative = true;
      continue;
    }
    if (arg === "--headless") {
      parsed.flags.headless = true;
      continue;
    }
    if (takesValue(arg, "--model", "-m")) {
      parsed.flags.model = readValue(argv, ++i, arg);
      continue;
    }
    if (takesValue(arg, "--backend", "-b")) {
      parsed.flags.backend = normalizeBackend(readValue(argv, ++i, arg));
      continue;
    }
    if (takesValue(arg, "--cwd", "-C")) {
      parsed.flags.cwd = readValue(argv, ++i, arg);
      continue;
    }
    if (takesValue(arg, "--repo")) {
      parsed.flags.repo = readValue(argv, ++i, arg);
      continue;
    }
    if (takesValue(arg, "--run")) {
      parsed.flags.run = readValue(argv, ++i, arg);
      continue;
    }
    if (takesValue(arg, "--tmux-session")) {
      parsed.flags.tmuxSession = readValue(argv, ++i, arg);
      continue;
    }
    if (takesValue(arg, "--home-path")) {
      parsed.flags.homePaths = [...(parsed.flags.homePaths ?? []), readValue(argv, ++i, arg)];
      continue;
    }
    if (arg.startsWith("--model=")) {
      parsed.flags.model = arg.slice("--model=".length);
      continue;
    }
    if (arg.startsWith("--backend=")) {
      parsed.flags.backend = normalizeBackend(arg.slice("--backend=".length));
      continue;
    }
    if (arg.startsWith("--cwd=")) {
      parsed.flags.cwd = arg.slice("--cwd=".length);
      continue;
    }
    if (arg.startsWith("--repo=")) {
      parsed.flags.repo = arg.slice("--repo=".length);
      continue;
    }
    if (arg.startsWith("--run=")) {
      parsed.flags.run = arg.slice("--run=".length);
      continue;
    }
    if (arg.startsWith("--tmux-session=")) {
      parsed.flags.tmuxSession = arg.slice("--tmux-session=".length);
      continue;
    }
    if (arg.startsWith("--home-path=")) {
      parsed.flags.homePaths = [...(parsed.flags.homePaths ?? []), arg.slice("--home-path=".length)];
      continue;
    }
    if (!parsed.command && !arg.startsWith("-")) {
      parsed.command = arg;
      continue;
    }
    parsed.args.push(arg);
  }
  return parsed;
}

function takesValue(arg: string, ...names: string[]): boolean {
  return names.includes(arg);
}

function readValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function normalizeBackend(value: string): BackendId {
  if (value === "claude" || value === "codex" || value === "acpx") {
    return value;
  }
  throw new Error(`Unknown backend: ${value}`);
}

async function maybeOnboard(): Promise<void> {
  if (await authStoreExists()) {
    return;
  }
  if (!isTty()) {
    await runOnboard({ nonInteractive: true });
    return;
  }
  await runOnboard();
}

async function openDashboard(parsed: Parsed): Promise<void> {
  if (parsed.flags.noTmux || parsed.flags.headless) {
    await runInteractiveTui({
      backend: parsed.flags.backend,
      model: parsed.flags.model,
      worktree: parsed.flags.worktree,
      detach: parsed.flags.detach,
    });
    return;
  }
  await Promise.all([refreshModelCache(), ensureReviewTool()]);
  if (!parsed.flags.noNative && process.env.RUDDER_LEGACY_TMUX !== "1" && await runNativeDashboard()) {
    return;
  }
  if (hasTmux()) {
    await openTmuxDashboard(parsed);
    return;
  }
  await runInteractiveTui({
    backend: parsed.flags.backend,
    model: parsed.flags.model,
    worktree: parsed.flags.worktree,
    detach: parsed.flags.detach,
  });
}

async function refreshModelCache(): Promise<void> {
  await Promise.all([
    discoverModelOptions("claude").catch(() => []),
    discoverModelOptions("codex").catch(() => []),
  ]);
}

let reviewToolChecked = false;

async function ensureReviewTool(): Promise<void> {
  if (reviewToolChecked || process.env.RUDDER_REVIEW_TOOL === "git") {
    return;
  }
  reviewToolChecked = true;
  if (commandExists("hunk") || commandExists("hunkdiff")) {
    return;
  }
  if (!commandExists("npm")) {
    if (isTty()) {
      console.warn("hunkdiff unavailable; review pane will use live git diff fallback.");
    }
    return;
  }
  if (isTty()) {
    console.log("Installing hunkdiff@latest for the review pane...");
  }
  const result = await runCommand("npm", ["install", "-g", "hunkdiff@latest"], {
    allowFailure: true,
  });
  if (result.code !== 0 && isTty()) {
    console.warn("hunkdiff install failed; review pane will use live git diff fallback.");
  }
}

async function runNativeDashboard(): Promise<boolean> {
  const nativeBinary = resolveNativeBinaryPath();
  if (!nativeBinary) {
    return false;
  }
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      const child = spawn(nativeBinary, process.argv.slice(2), {
        stdio: "inherit",
        env: process.env,
      });
      child.on("error", reject);
      child.on("exit", (exitCode) => resolve(exitCode));
    });
    process.exitCode = code ?? 1;
    return true;
  } catch {
    return false;
  }
}

async function runNativeCommand(args: string[]): Promise<void> {
  const nativeBinary = resolveNativeBinaryPath();
  if (!nativeBinary) {
    throw new Error("rudder-native binary is not available in this package");
  }
  const code = await new Promise<number | null>((resolve, reject) => {
    const child = spawn(nativeBinary, args, {
      stdio: "inherit",
      env: process.env,
    });
    child.on("error", reject);
    child.on("exit", (exitCode) => resolve(exitCode));
  });
  process.exitCode = code ?? 1;
}

async function openTmuxDashboard(parsed: Parsed): Promise<void> {
  if (!hasTmux()) {
    await runInteractiveTui({
      backend: parsed.flags.backend,
      model: parsed.flags.model,
      worktree: parsed.flags.worktree,
      detach: parsed.flags.detach,
    });
    return;
  }
  await ensureReviewTool();
  const repoRoot = findRepoRoot();
  const sessionName = parsed.flags.tmuxSession ?? repoTmuxSessionName(repoRoot);
  const entry = process.argv[1];
  if (!entry) {
    throw new Error("Cannot locate Rudder entrypoint.");
  }
  const common = [
    entry,
  ];
  const commonFlags = [
    "--repo",
    repoRoot,
    "--tmux-session",
    sessionName,
    ...(parsed.flags.backend ? ["--backend", parsed.flags.backend] : []),
    ...(parsed.flags.model ? ["--model", parsed.flags.model] : []),
  ];
  await ensureTmuxDashboardSession({
    repoRoot,
    sessionName,
    agentCommand: shellCommand(process.execPath, [...common, "__agents", ...commonFlags]),
    workerCommand: shellCommand(process.execPath, [...common, "__worker-idle", ...commonFlags]),
    taskCommand: shellCommand(process.execPath, [...common, "__task", ...commonFlags]),
    backend: parsed.flags.backend === "codex" ? "codex" : "claude",
    model: parsed.flags.model,
  });
  const code = await attachTmuxSession(sessionName);
  process.exitCode = code;
}

async function packageVersion(): Promise<string> {
  const packageFile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json");
  const raw = await fsp.readFile(packageFile, "utf8").catch(() => "");
  if (!raw) {
    return "unknown";
  }
  const parsed = JSON.parse(raw) as { version?: string };
  return parsed.version ?? "unknown";
}

function printHelp(): void {
  console.log(`rudder

Usage:
  rudder                         Open native dashboard with real agent panes
  rudder tmux                    Open tmux dashboard with native agent panes
  rudder tui                     Open legacy full-screen stream TUI
  rudder "task"
  rudder run [options] "task"
  rudder claude [options] "task"
  rudder codex [options] "task"
  rudder login
  rudder cloud [name]
  rudder cloud help
  rudder cloud list
  rudder cloud onload <runId>
  rudder sail [name]

Run management:
  rudder watch [run]              Attach to live output
  rudder logs [run] [--follow]    Print saved output
  rudder status [--json]          Show active runs for this repo
  rudder runs [--json]            List runs for this repo
  rudder stop <run>               Cancel a run
  rudder delete <run>             Delete a run and its worktree
  rudder merge <run>              Merge a worktree run into current branch
  rudder cleanup [--force]        Remove merged worktrees

Setup:
  rudder onboard
  rudder doctor [--json]
  rudder mouse-test [raw|parsed]    Show whether your terminal sends wheel events

Cloud:
  rudder login                    Open browser login and store cloud token
  rudder cloud [name]             Start a cloud worker from this repo snapshot
  rudder cloud list               List cloud workers/runs
  rudder cloud help               Show cloud command help
  rudder cloud onload <runId>     Move a local Rudder run to cloud
  rudder cloud pause <id>         Pause an idle cloud worker
  rudder cloud resume <id>        Resume a cloud worker
  rudder sail [name]              Alias for starting a cloud worker

Options:
  -d, --detach                    Start in background
      --worktree                  Always isolate in a git worktree
      --queue                     Queue mode (reserved)
  -m, --model <model>             Backend model
  -b, --backend <backend>         claude or codex
  -C, --cwd <dir>                 Run from another directory
      --no-tmux                   Use the legacy TUI for bare rudder
      --no-native                 Use the tmux dashboard instead of native
      --headless                  Alias for --no-tmux on bare rudder
      --home-path <path>          Include extra HOME path in cloud snapshot
      --json                      Machine-readable output
  -v, --version                   Print version
      --allow-dirty               Allow merge into dirty target branch
`);
}
