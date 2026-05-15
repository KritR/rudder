import type { RunRecord, SpecContract, VerificationResult } from "./types.js";
export declare function createSpec(run: RunRecord): Promise<SpecContract>;
export declare function renderContract(spec: SpecContract): string;
export declare function verifyRun(run: RunRecord): Promise<VerificationResult>;
