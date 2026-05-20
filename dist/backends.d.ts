import type { BackendAdapter, BackendId } from "./types.js";
export declare function getBackend(id: BackendId): BackendAdapter;
export declare function backendEnv(provider: "anthropic" | "openai"): Promise<NodeJS.ProcessEnv>;
