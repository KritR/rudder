import path from "node:path";
import { projectStateDir } from "./state.js";
import type { BackendId, JsonValue } from "./types.js";
import { ensureDir, readJson, writeJson } from "./util.js";

export type NativeBackendId = Exclude<BackendId, "acpx">;

export type TmuxDashboardState = {
  version: 1;
  repoRoot: string;
  sessionName: string;
  agentPaneId: string;
  workerPaneId: string;
  taskPaneId: string;
  selectedRunId?: string;
  backend: NativeBackendId;
  model?: string;
};

export function tmuxDashboardStatePath(repoRoot: string, sessionName: string): string {
  return path.join(projectStateDir(repoRoot), "tmux", `${sessionName}.json`);
}

export async function loadTmuxDashboardState(
  repoRoot: string,
  sessionName: string,
): Promise<TmuxDashboardState | null> {
  return await readJson<TmuxDashboardState>(tmuxDashboardStatePath(repoRoot, sessionName));
}

export async function saveTmuxDashboardState(state: TmuxDashboardState): Promise<void> {
  await ensureDir(path.dirname(tmuxDashboardStatePath(state.repoRoot, state.sessionName)));
  await writeJson(tmuxDashboardStatePath(state.repoRoot, state.sessionName), state as unknown as JsonValue);
}

export async function updateTmuxDashboardState(
  repoRoot: string,
  sessionName: string,
  patch: Partial<Omit<TmuxDashboardState, "version" | "repoRoot" | "sessionName">>,
): Promise<TmuxDashboardState | null> {
  const current = await loadTmuxDashboardState(repoRoot, sessionName);
  if (!current) {
    return null;
  }
  const next = { ...current, ...patch };
  await saveTmuxDashboardState(next);
  return next;
}
