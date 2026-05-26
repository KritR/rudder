import type { JsonValue } from "./types.js";
export type MigrationDecision = "migrate" | "migrate-fresh" | "stay" | "stop";
export type MigrationCandidate = {
    runId: string;
    task: string;
    taskSummary?: string;
    backend: string;
    status: string;
    worktreePath: string;
    worktreeBranch?: string;
    sessionId?: string;
    sessionJsonlPath?: string;
    reason: "resumable" | "no-session" | "no-jsonl" | "unsupported-backend" | "missing-worktree" | "not-running";
    decision: MigrationDecision;
};
export type MigrationPlan = {
    candidates: MigrationCandidate[];
    migrated: MigrationCandidate[];
    stayedLocal: MigrationCandidate[];
};
export type MigrationManifestEntry = {
    runId: string;
    task: string;
    taskSummary?: string;
    backend: string;
    model?: string;
    sessionId: string;
    /** Path of the worktree on the local machine. */
    localWorktreePath: string;
    /** Relative path (under repo root / snapshot stage) the worktree maps to on cloud. */
    cloudWorktreeRelativePath: string;
    /** Relative path inside the snapshot tar where the session jsonl is staged. */
    sessionJsonlSnapshotPath: string;
    worktreeBranch?: string;
    createdAt?: string;
    /**
     * Prompt-engineered handoff for fresh restarts (when no resumable session
     * exists). Includes the original task and recent user steering so the new
     * agent has context, not just the bare task.
     */
    freshPrompt?: string;
};
/**
 * Build a compact "you're picking up from a paused session" prompt for a
 * migrated agent whose conversation can't be replayed verbatim.
 */
export declare function buildFreshHandoffPrompt(candidate: MigrationCandidate, recentTurns: Array<{
    prompt: string;
    source: string;
}>): string;
export type MigrationSnapshotManifest = {
    version: 1;
    createdAt: string;
    agents: MigrationManifestEntry[];
};
/**
 * Discover candidate local agents that could be migrated to the cloud.
 *
 * "Running" is interpreted loosely: any run record whose worktree still exists
 * on disk and whose backend is resumable. We can't tell whether the PTY is
 * literally alive (the dashboard quits before this runs), but the Claude
 * session jsonl is persisted, so anything with a session id and an existing
 * jsonl can be resumed in the cloud via `claude --resume <id>`.
 */
export declare function findMigrationCandidates(repoRoot: string): Promise<MigrationCandidate[]>;
/**
 * Encode an absolute filesystem path the way Claude Code does for its session
 * jsonl directory layout: every non-alphanumeric, non-hyphen character becomes
 * a single hyphen, including the leading slash.
 */
export declare function encodeClaudeProjectsCwd(absolutePath: string): string;
export declare function claudeSessionJsonlPath(cwd: string, sessionId: string): string;
/**
 * Cloud-side absolute worktree path that the supervisor will stage a migrated
 * agent's worktree at. Mirrors the layout in supervisor.mjs.
 */
export declare function cloudWorkspacePath(repoName: string): string;
export declare function cloudWorktreeAbsolutePath(repoName: string, runId: string, task?: string): string;
export declare function formatCandidateReason(candidate: MigrationCandidate): string;
export declare function applyDefaultDecisions(candidates: MigrationCandidate[]): MigrationPlan;
export declare function migrationSummary(plan: MigrationPlan): string;
export declare function summaryAsJson(plan: MigrationPlan): JsonValue;
