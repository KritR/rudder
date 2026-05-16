import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { JsonValue, RunRecord } from "./types.js";
import { pathExists, readJson } from "./util.js";

export type MigrationDecision = "migrate" | "stay" | "stop";

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
};

export type MigrationSnapshotManifest = {
  version: 1;
  createdAt: string;
  agents: MigrationManifestEntry[];
};

const RESUMABLE_BACKENDS = new Set(["claude"]);

/**
 * Discover candidate local agents that could be migrated to the cloud.
 *
 * "Running" is interpreted loosely: any run record whose worktree still exists
 * on disk and whose backend is resumable. We can't tell whether the PTY is
 * literally alive (the dashboard quits before this runs), but the Claude
 * session jsonl is persisted, so anything with a session id and an existing
 * jsonl can be resumed in the cloud via `claude --resume <id>`.
 */
export async function findMigrationCandidates(repoRoot: string): Promise<MigrationCandidate[]> {
  const runsDir = path.join(repoRoot, ".rudder", "runs");
  const entries = await fsp.readdir(runsDir, { withFileTypes: true }).catch(() => []);
  const out: MigrationCandidate[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const runJsonPath = path.join(runsDir, entry.name, "run.json");
    const record = await readJson<RunRecord>(runJsonPath);
    if (!record || record.id !== entry.name) {
      continue;
    }
    const candidate = await classify(record);
    if (candidate) {
      out.push(candidate);
    }
  }
  return out;
}

async function classify(record: RunRecord): Promise<MigrationCandidate | null> {
  const status = record.status;
  // Only consider agents the user might care about migrating: anything that is
  // not already terminal. We include "running"/"steering"/"verifying"/"created".
  if (status === "completed" || status === "merged" || status === "cancelled" || status === "failed") {
    return null;
  }
  const worktreePath = record.worktree?.path;
  if (!worktreePath) {
    return null;
  }
  const worktreeExists = await pathExists(worktreePath);
  const base: Omit<MigrationCandidate, "reason" | "decision"> = {
    runId: record.id,
    task: record.task,
    taskSummary: record.taskSummary,
    backend: record.backend,
    status,
    worktreePath,
    worktreeBranch: record.worktree?.branch,
    sessionId: record.session?.nativeSessionId,
  };
  if (!worktreeExists) {
    return { ...base, reason: "missing-worktree", decision: "stay" };
  }
  if (!RESUMABLE_BACKENDS.has(record.backend)) {
    return { ...base, reason: "unsupported-backend", decision: "stay" };
  }
  const sessionId = record.session?.nativeSessionId;
  if (!sessionId) {
    return { ...base, reason: "no-session", decision: "stay" };
  }
  const jsonl = claudeSessionJsonlPath(worktreePath, sessionId);
  if (!(await pathExists(jsonl))) {
    return { ...base, reason: "no-jsonl", sessionJsonlPath: jsonl, decision: "stay" };
  }
  return { ...base, sessionJsonlPath: jsonl, reason: "resumable", decision: "migrate" };
}

/**
 * Encode an absolute filesystem path the way Claude Code does for its session
 * jsonl directory layout: every non-alphanumeric, non-hyphen character becomes
 * a single hyphen, including the leading slash.
 */
export function encodeClaudeProjectsCwd(absolutePath: string): string {
  return absolutePath.replace(/[^A-Za-z0-9-]/g, "-");
}

export function claudeSessionJsonlPath(cwd: string, sessionId: string): string {
  return path.join(
    os.homedir(),
    ".claude",
    "projects",
    encodeClaudeProjectsCwd(path.resolve(cwd)),
    `${sessionId}.jsonl`,
  );
}

/**
 * Cloud-side absolute worktree path that the supervisor will stage a migrated
 * agent's worktree at. Mirrors the layout in supervisor.mjs.
 */
export function cloudWorkspacePath(repoName: string): string {
  return path.posix.join("/workspace", repoName);
}

export function cloudWorktreeAbsolutePath(repoName: string, runId: string): string {
  // Mirrors src/state.ts worktreePath() but rooted at the cloud workspace.
  return path.posix.join("/workspace", ".rudder-worktrees", repoName, runId);
}

export function formatCandidateReason(candidate: MigrationCandidate): string {
  switch (candidate.reason) {
    case "resumable":
      return "resumable";
    case "no-session":
      return "no Claude session id";
    case "no-jsonl":
      return "Claude session jsonl missing locally";
    case "unsupported-backend":
      return `${candidate.backend} not resumable`;
    case "missing-worktree":
      return "worktree gone";
    case "not-running":
      return "not running";
    default:
      return "skipped";
  }
}

export function applyDefaultDecisions(candidates: MigrationCandidate[]): MigrationPlan {
  const migrated = candidates.filter((c) => c.decision === "migrate");
  const stayedLocal = candidates.filter((c) => c.decision !== "migrate");
  return { candidates, migrated, stayedLocal };
}

export function migrationSummary(plan: MigrationPlan): string {
  const lines: string[] = [];
  lines.push(`${plan.migrated.length} agent${plan.migrated.length === 1 ? "" : "s"} will move to cloud, ${plan.stayedLocal.length} will stay local.`);
  for (const c of plan.migrated) {
    const short = (c.taskSummary || c.task || c.runId).slice(0, 72);
    lines.push(`  move  ${c.runId}  ${short}`);
  }
  for (const c of plan.stayedLocal) {
    const short = (c.taskSummary || c.task || c.runId).slice(0, 60);
    lines.push(`  stay  ${c.runId}  ${short}  (${formatCandidateReason(c)})`);
  }
  return lines.join("\n");
}

export function summaryAsJson(plan: MigrationPlan): JsonValue {
  return {
    moved: plan.migrated.length,
    stayedLocal: plan.stayedLocal.length,
    agents: plan.candidates.map((c) => ({
      runId: c.runId,
      backend: c.backend,
      decision: c.decision,
      reason: c.reason,
      task: c.taskSummary || c.task,
    })),
  };
}
