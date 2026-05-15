import { type NativeBackendId } from "./tmux-state.js";
import type { EffortLevel } from "./types.js";
export declare function hasTmux(): boolean;
export declare function repoTmuxSessionName(repoRoot: string): string;
export declare function shellCommand(command: string, args?: string[]): string;
export declare function ensureTmuxDashboardSession(params: {
    repoRoot: string;
    sessionName: string;
    agentCommand: string;
    workerCommand: string;
    taskCommand: string;
    backend: NativeBackendId;
    model?: string;
    effort?: EffortLevel;
}): Promise<void>;
export declare function normalizeTmuxDashboardLayout(repoRoot: string, sessionName: string): Promise<void>;
export declare function configureRudderSession(sessionName: string): Promise<void>;
export declare function attachTmuxSession(sessionName: string): Promise<number>;
export declare function createAgentPane(params: {
    sessionName: string;
    cwd: string;
    title: string;
    command: string;
    logPath?: string;
}): Promise<string>;
export declare function respawnPane(params: {
    paneId: string;
    cwd: string;
    title: string;
    command: string;
    logPath?: string;
}): Promise<void>;
export declare function selectPane(paneId: string): Promise<void>;
export declare function paneExitStatus(paneId: string): Promise<number | null>;
export declare function selectNextPane(sessionName: string): Promise<void>;
export declare function resizePane(paneId: string, height: number): Promise<void>;
export declare function killPane(paneId: string): Promise<void>;
export declare function paneAlive(paneId: string): Promise<boolean>;
export declare function detachClient(sessionName: string): Promise<void>;
