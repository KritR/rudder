import type { BackendId } from "./types.js";
export declare function runInteractiveShell(defaults?: {
    backend?: BackendId;
    model?: string;
    worktree?: boolean;
    detach?: boolean;
}): Promise<void>;
