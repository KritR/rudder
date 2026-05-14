import { spawn } from "node:child_process";
import path from "node:path";
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
  dashboardCommand: string;
}): Promise<void> {
  if (await tmuxSessionExists(params.sessionName)) {
    return;
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
    params.dashboardCommand,
  ]);
  await runTmux(["set-option", "-t", params.sessionName, "mouse", "on"], true);
  await runTmux(["set-option", "-t", params.sessionName, "pane-border-status", "top"], true);
  await runTmux(["set-option", "-t", params.sessionName, "pane-border-format", " #{pane_title} "], true);
  await runTmux(["select-pane", "-t", `${params.sessionName}:0.0`, "-T", "rudder dashboard"], true);
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

export async function selectPane(paneId: string): Promise<void> {
  await runTmux(["select-pane", "-t", paneId], true);
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

async function runTmux(
  args: string[],
  allowFailure = false,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return await runCommand("tmux", args, { allowFailure });
}
