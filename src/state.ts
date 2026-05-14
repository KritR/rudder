import path from "node:path";
import fsp from "node:fs/promises";
import type { AuthProfileStore, RudderConfig, RunRecord, RudderEvent } from "./types.js";
import {
  ensureDir,
  newRunId,
  nowIso,
  readJson,
  rudderHome,
  shortHash,
  slugify,
  writeJson,
} from "./util.js";

export function globalConfigPath(): string {
  return path.join(rudderHome(), "config.json");
}

export function authStorePath(): string {
  return path.join(rudderHome(), "auth-profiles.json");
}

export function projectStateDir(repoRoot: string): string {
  return path.join(repoRoot, ".rudder");
}

export function runsDir(repoRoot: string): string {
  return path.join(projectStateDir(repoRoot), "runs");
}

export function runDir(repoRoot: string, runId: string): string {
  return path.join(runsDir(repoRoot), runId);
}

export function runRecordPath(repoRoot: string, runId: string): string {
  return path.join(runDir(repoRoot, runId), "run.json");
}

export function eventsPath(repoRoot: string, runId: string): string {
  return path.join(runDir(repoRoot, runId), "events.ndjson");
}

export function outputPath(repoRoot: string, runId: string): string {
  return path.join(runDir(repoRoot, runId), "output.txt");
}

export function agentContextPath(repoRoot: string): string {
  return path.join(repoRoot, "RUDDER.md");
}

export function specPath(repoRoot: string, runId: string): string {
  return path.join(runDir(repoRoot, runId), "spec.json");
}

export function verifierPath(repoRoot: string, runId: string): string {
  return path.join(runDir(repoRoot, runId), "verifier.json");
}

export function worktreePath(repoRoot: string, runId: string): string {
  const parent = path.dirname(repoRoot);
  const repoName = `${slugify(path.basename(repoRoot), "repo")}-${shortHash(repoRoot)}`;
  return path.join(parent, ".rudder-worktrees", repoName, runId);
}

export async function loadConfig(): Promise<RudderConfig> {
  const existing = await readJson<RudderConfig>(globalConfigPath());
  if (existing?.version === 1) {
    return existing;
  }
  return defaultConfig();
}

export function defaultConfig(): RudderConfig {
  return {
    version: 1,
    defaultBackend: "claude",
    runPolicy: {
      sameCheckout: "single-active",
      concurrentPromptMode: "worktree",
      mergeMode: "manual-on-conflict",
    },
    acpx: { install: "latest" },
    backends: {
      claude: { profileId: "anthropic:claude-code", model: "sonnet" },
      codex: {
        profileId: "openai-codex:default",
        model: "gpt-5.5",
      },
      acpx: { model: "gpt-5.5" },
    },
  };
}

export async function saveConfig(config: RudderConfig): Promise<void> {
  await writeJson(globalConfigPath(), config, { mode: 0o600 });
}

export async function loadAuthStore(): Promise<AuthProfileStore> {
  const existing = await readJson<AuthProfileStore>(authStorePath());
  if (existing?.version === 1 && existing.profiles && typeof existing.profiles === "object") {
    return {
      version: 1,
      profiles: normalizeProfiles(existing.profiles),
      order: existing.order,
      lastGood: existing.lastGood,
      usageStats: existing.usageStats,
    };
  }
  return { version: 1, profiles: {} };
}

function normalizeProfiles(
  profiles: Record<string, unknown>,
): AuthProfileStore["profiles"] {
  const normalized: AuthProfileStore["profiles"] = {};
  for (const [profileId, raw] of Object.entries(profiles)) {
    if (!raw || typeof raw !== "object") {
      continue;
    }
    const entry = { ...(raw as Record<string, unknown>) };
    if (!entry.type && typeof entry.mode === "string") {
      entry.type = entry.mode;
    }
    if (entry.type === "api_key" && typeof entry.provider === "string") {
      normalized[profileId] = {
        type: "api_key",
        provider: entry.provider,
        ...(typeof entry.key === "string" ? { key: entry.key } : {}),
        ...(typeof entry.apiKey === "string" ? { key: entry.apiKey } : {}),
      };
      continue;
    }
    if (entry.type === "token" && typeof entry.provider === "string") {
      normalized[profileId] = {
        type: "token",
        provider: entry.provider,
        ...(typeof entry.token === "string" ? { token: entry.token } : {}),
        ...(typeof entry.expires === "number" ? { expires: entry.expires } : {}),
      };
      continue;
    }
    if (
      entry.type === "oauth" &&
      typeof entry.provider === "string" &&
      typeof entry.access === "string" &&
      typeof entry.refresh === "string" &&
      typeof entry.expires === "number"
    ) {
      normalized[profileId] = {
        type: "oauth",
        provider: entry.provider,
        access: entry.access,
        refresh: entry.refresh,
        expires: entry.expires,
        ...(typeof entry.email === "string" ? { email: entry.email } : {}),
        ...(typeof entry.accountId === "string" ? { accountId: entry.accountId } : {}),
      };
    }
  }
  return normalized;
}

export async function saveAuthStore(store: AuthProfileStore): Promise<void> {
  await writeJson(authStorePath(), store, { mode: 0o600 });
}

export async function createRunRecord(params: {
  id?: string;
  repoRoot: string;
  task: string;
  backend: RunRecord["backend"];
  model?: string;
  effort?: RunRecord["effort"];
  targetBranch: string;
  baseCommit: string;
  useWorktree: boolean;
  worktreeBranch?: string;
  worktreePath?: string;
}): Promise<RunRecord> {
  const id = params.id ?? newRunId(params.task);
  const createdAt = nowIso();
  const record: RunRecord = {
    id,
    status: "created",
    task: params.task,
    backend: params.backend,
    model: params.model,
    effort: params.effort,
    createdAt,
    updatedAt: createdAt,
    repoRoot: params.repoRoot,
    targetBranch: params.targetBranch,
    baseCommit: params.baseCommit,
    worktree: {
      enabled: params.useWorktree,
      path: params.worktreePath ?? params.repoRoot,
      branch: params.worktreeBranch,
    },
    currentPrompt: params.task,
    turns: [{ ts: createdAt, prompt: params.task, source: "user" }],
    lastUserInputAt: createdAt,
    autoSteer: { count: 0, max: 2 },
  };
  await ensureDir(runDir(params.repoRoot, id));
  await saveRunRecord(record);
  return record;
}

export async function saveRunRecord(record: RunRecord): Promise<void> {
  record.updatedAt = nowIso();
  await writeJson(runRecordPath(record.repoRoot, record.id), record);
}

export async function loadRunRecord(repoRoot: string, runId: string): Promise<RunRecord | null> {
  return await readJson<RunRecord>(runRecordPath(repoRoot, runId));
}

export async function appendEvent(repoRoot: string, event: RudderEvent): Promise<void> {
  await ensureDir(runDir(repoRoot, event.runId));
  await fsp.appendFile(eventsPath(repoRoot, event.runId), `${JSON.stringify(event)}\n`, "utf8");
  const text =
    event.type === "backend.output" || event.type === "backend.error"
      ? event.message ?? (typeof event.data === "string" ? event.data : undefined)
      : undefined;
  if (text) {
    await fsp.appendFile(outputPath(repoRoot, event.runId), text, "utf8");
  }
}

export async function listRuns(repoRoot: string): Promise<RunRecord[]> {
  await ensureDir(runsDir(repoRoot));
  const entries = await fsp.readdir(runsDir(repoRoot), { withFileTypes: true });
  const runs = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => await loadRunRecord(repoRoot, entry.name)),
  );
  return runs
    .filter((run): run is RunRecord => Boolean(run))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function resolveRun(repoRoot: string, runId?: string): Promise<RunRecord | null> {
  if (runId) {
    return await loadRunRecord(repoRoot, runId);
  }
  const runs = await listRuns(repoRoot);
  return runs[0] ?? null;
}
