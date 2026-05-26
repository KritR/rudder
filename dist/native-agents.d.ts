import type { RunRecord } from "./types.js";
export declare function nativeAgentCommand(params: {
    run: RunRecord;
    prompt: string;
    contract: string;
    mode?: "execute" | "plan";
    codexCommand?: string;
}): string;
