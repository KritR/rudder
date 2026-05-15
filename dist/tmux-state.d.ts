import type { BackendId, EffortLevel } from "./types.js";
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
    effort?: EffortLevel;
};
export declare function tmuxDashboardStatePath(repoRoot: string, sessionName: string): string;
export declare function loadTmuxDashboardState(repoRoot: string, sessionName: string): Promise<TmuxDashboardState | null>;
export declare function saveTmuxDashboardState(state: TmuxDashboardState): Promise<void>;
export declare function updateTmuxDashboardState(repoRoot: string, sessionName: string, patch: Partial<Omit<TmuxDashboardState, "version" | "repoRoot" | "sessionName">>): Promise<TmuxDashboardState | null>;
