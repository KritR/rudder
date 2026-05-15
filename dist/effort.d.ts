import type { BackendId, EffortLevel } from "./types.js";
export type EffortOption = {
    label: string;
    value?: EffortLevel;
    detail: string;
};
export declare function discoverEffortOptions(backend: BackendId): Promise<EffortOption[]>;
export declare function fallbackEffortOptions(backend: BackendId): EffortOption[];
export declare function normalizeEffortForBackend(backend: BackendId, effort: EffortLevel | undefined): EffortLevel | undefined;
