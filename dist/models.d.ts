import type { BackendId } from "./types.js";
export type ModelOption = {
    label: string;
    value?: string;
    detail?: string;
    backend?: BackendId;
};
export declare function discoverModelOptions(backend: BackendId, configuredDefault?: string): Promise<ModelOption[]>;
export declare function fallbackModelOptions(backend: BackendId, configuredDefault?: string): ModelOption[];
