import type { BackendId } from "./types.js";
type PaneDefaults = {
    tmuxSessionName: string;
    backend?: BackendId;
    model?: string;
};
export declare function runTmuxAgentPane(defaults: PaneDefaults): Promise<void>;
export declare function runTmuxTaskPane(defaults: PaneDefaults): Promise<void>;
export declare function runTmuxWorkerIdle(defaults: PaneDefaults): Promise<void>;
export {};
