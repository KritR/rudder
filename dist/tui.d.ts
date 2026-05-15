import type { BackendId } from "./types.js";
type TuiDefaults = {
    backend?: BackendId;
    model?: string;
    worktree?: boolean;
    detach?: boolean;
};
export declare function runInteractiveTui(defaults?: TuiDefaults): Promise<void>;
export {};
