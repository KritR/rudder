import { spawn } from "node:child_process";
import path from "node:path";
import {
  loadTmuxDashboardState,
  saveTmuxDashboardState,
  type NativeBackendId,
} from "./tmux-state.js";
import { commandExists, runCommand, shellQuote, shortHash, slugify } from "./util.js";

export function hasTmux(): boolean {
  return commandExists("tmux");
}

export function repoTmuxSessionName(repoRoot: string): string {
  const repo = slugify(path.basename(repoRoot), "repo").replace(/-/g, "_");
  return `rudder_${repo}_${shortHash(repoRoot).slice(0, 8)}`;
}

export function shellCommand(command: string, args: string[] = []): string {
  return [command, ...args].map(shellQuote).join(" ");
}

export async function ensureTmuxDashboardSession(params: {
  repoRoot: string;
  sessionName: string;
  agentCommand: string;
  workerCommand: string;
  taskCommand: string;
  backend: NativeBackendId;
  model?: string;
}): Promise<void> {
  if (await tmuxSessionExists(params.sessionName) && await loadTmuxDashboardState(params.repoRoot, params.sessionName)) {
    await configureRudderSession(params.sessionName);
    return;
  }
  if (await tmuxSessionExists(params.sessionName)) {
    await runTmux(["kill-session", "-t", params.sessionName], true);
  }
  await runTmux([
    "new-session",
    "-d",
    "-s",
    params.sessionName,
    "-c",
    params.repoRoot,
    "-n",
    "rudder",
    params.agentCommand,
  ]);
  await configureRudderSession(params.sessionName);
  const agentPaneId = await paneId(params.sessionName, "0.0");
  await runTmux(["select-pane", "-t", agentPaneId, "-T", "agents"], true);
  const taskPaneId = (
    await runTmux([
      "split-window",
      "-v",
      "-t",
      agentPaneId,
      "-l",
      "4",
      "-c",
      params.repoRoot,
      "-P",
      "-F",
      "#{pane_id}",
      params.taskCommand,
    ])
  ).stdout.trim();
  await runTmux(["select-pane", "-t", taskPaneId, "-T", "task"], true);
  const workerPaneId = (
    await runTmux([
      "split-window",
      "-h",
      "-t",
      agentPaneId,
      "-p",
      "82",
      "-c",
      params.repoRoot,
      "-P",
      "-F",
      "#{pane_id}",
      params.workerCommand,
    ])
  ).stdout.trim();
  const agentWidth = Math.max(28, Math.min(44, Math.floor(await windowWidth(params.sessionName) * 0.22)));
  await runTmux(["resize-pane", "-t", agentPaneId, "-x", String(agentWidth)], true);
  await runTmux(["select-pane", "-t", workerPaneId, "-T", "worker"], true);
  await runTmux(["set-option", "-p", "-t", workerPaneId, "remain-on-exit", "on"], true);
  await saveTmuxDashboardState({
    version: 1,
    repoRoot: params.repoRoot,
    sessionName: params.sessionName,
    agentPaneId,
    workerPaneId,
    taskPaneId,
    backend: params.backend,
    model: params.model,
  });
  await selectPane(taskPaneId || agentPaneId);
}

export async function configureRudderSession(sessionName: string): Promise<void> {
  await runTmux(["set-option", "-t", sessionName, "mouse", "on"], true);
  await runTmux(["set-option", "-t", sessionName, "pane-border-status", "top"], true);
  await runTmux(["set-option", "-t", sessionName, "pane-border-lines", "double"], true);
  await runTmux([
    "set-option",
    "-t",
    sessionName,
    "pane-border-format",
    "#{?pane_active,#[fg=black,bg=brightcyan,bold]  FOCUS  #[default] #[fg=brightcyan,bold]━━━━ ,#[fg=colour244]}#{pane_title} ",
  ], true);
  await runTmux(["set-option", "-t", sessionName, "pane-active-border-style", "fg=brightcyan,bold"], true);
  await runTmux(["set-option", "-t", sessionName, "pane-border-style", "fg=colour238"], true);
  await runTmux(["bind-key", "-T", "root", "Tab", "select-pane", "-t", ":.+"], true);
  await runTmux(["bind-key", "-T", "root", "BTab", "select-pane", "-t", ":.-"], true);
}

export async function attachTmuxSession(sessionName: string): Promise<number> {
  return await new Promise((resolve, reject) => {
    const args = process.env.TMUX
      ? ["switch-client", "-t", sessionName]
      : ["attach-session", "-t", sessionName];
    const child = spawn("tmux", args, {
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 0));
  });
}

export async function createAgentPane(params: {
  sessionName: string;
  cwd: string;
  title: string;
  command: string;
  logPath?: string;
}): Promise<string> {
  const result = await runTmux([
    "split-window",
    "-h",
    "-t",
    `${params.sessionName}:0`,
    "-c",
    params.cwd,
    "-P",
    "-F",
    "#{pane_id}",
    params.command,
  ]);
  const paneId = result.stdout.trim();
  if (paneId) {
    await runTmux(["select-pane", "-t", paneId, "-T", params.title], true);
    if (params.logPath) {
      await runTmux(["pipe-pane", "-o", "-t", paneId, `cat >> ${shellQuote(params.logPath)}`], true);
    }
    await runTmux(["select-layout", "-t", `${params.sessionName}:0`, "tiled"], true);
    await selectPane(paneId);
  }
  return paneId;
}

export async function respawnPane(params: {
  paneId: string;
  cwd: string;
  title: string;
  command: string;
  logPath?: string;
}): Promise<void> {
  await runTmux(["respawn-pane", "-k", "-t", params.paneId, "-c", params.cwd, params.command]);
  await runTmux(["select-pane", "-t", params.paneId, "-T", params.title], true);
  await runTmux(["set-option", "-p", "-t", params.paneId, "remain-on-exit", "on"], true);
  if (params.logPath) {
    await runTmux(["pipe-pane", "-o", "-t", params.paneId, `cat >> ${shellQuote(params.logPath)}`], true);
  }
  await selectPane(params.paneId);
}

export async function selectPane(paneId: string): Promise<void> {
  await runTmux(["select-pane", "-t", paneId], true);
}

export async function selectNextPane(sessionName: string): Promise<void> {
  await runTmux(["select-pane", "-t", `${sessionName}:0.+`], true);
}

export async function killPane(paneId: string): Promise<void> {
  await runTmux(["kill-pane", "-t", paneId], true);
}

export async function paneAlive(paneId: string): Promise<boolean> {
  const result = await runTmux(["display-message", "-p", "-t", paneId, "#{pane_id}"], true);
  return result.code === 0 && result.stdout.trim() === paneId;
}

export async function detachClient(sessionName: string): Promise<void> {
  await runTmux(["detach-client", "-s", sessionName], true);
}

async function tmuxSessionExists(sessionName: string): Promise<boolean> {
  const result = await runTmux(["has-session", "-t", sessionName], true);
  return result.code === 0;
}

async function paneId(sessionName: string, paneIndex: string): Promise<string> {
  const result = await runTmux(["display-message", "-p", "-t", `${sessionName}:${paneIndex}`, "#{pane_id}"]);
  return result.stdout.trim();
}

async function windowWidth(sessionName: string): Promise<number> {
  const result = await runTmux(["display-message", "-p", "-t", `${sessionName}:0`, "#{window_width}"], true);
  const width = Number(result.stdout.trim());
  return Number.isFinite(width) && width > 0 ? width : 120;
}

async function runTmux(
  args: string[],
  allowFailure = false,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return await runCommand("tmux", args, { allowFailure });
}
