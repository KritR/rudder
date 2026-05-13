import fsp from "node:fs/promises";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BackendId } from "./types.js";

const MODELS_DEV_URL = "https://models.dev/api.json";
const MODELS_DEV_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export type ModelOption = {
  label: string;
  value?: string;
  detail: string;
};

type CodexCache = {
  models?: Array<{
    slug?: string;
    display_name?: string;
    description?: string;
    visibility?: string;
  }>;
};

type ModelsDevModel = {
  id?: string;
  name?: string;
  reasoning?: boolean;
  tool_call?: boolean;
  release_date?: string;
  last_updated?: string;
  limit?: {
    context?: number;
    output?: number;
  };
  modalities?: {
    input?: string[];
    output?: string[];
  };
};

type ModelsDevProvider = {
  id?: string;
  name?: string;
  models?: Record<string, ModelsDevModel>;
};

type ModelsDevCache = Record<string, ModelsDevProvider>;

export async function discoverModelOptions(
  backend: BackendId,
  configuredDefault?: string,
): Promise<ModelOption[]> {
  const defaultDetail = configuredDefault ? `configured default: ${configuredDefault}` : "use the backend's default";
  const options: ModelOption[] = [{ label: "Default", value: undefined, detail: defaultDetail }];
  const discovered = backend === "claude" ? await discoverClaudeModelsDev() : await discoverCodexModelsDev();
  if (backend === "claude") {
    pushUnique(options, { label: "Sonnet latest", value: "sonnet", detail: "Claude Code alias" });
    pushUnique(options, { label: "Opus latest", value: "opus", detail: "Claude Code alias" });
  }
  for (const option of discovered) {
    pushUnique(options, option);
  }
  if (options.length <= 1) {
    const fallback = backend === "claude" ? await discoverClaudeModelsLocal() : await discoverCodexModelsLocal();
    for (const option of fallback) {
      pushUnique(options, option);
    }
  }
  return options;
}

export function fallbackModelOptions(backend: BackendId, configuredDefault?: string): ModelOption[] {
  const defaultDetail = configuredDefault ? `configured default: ${configuredDefault}` : "use the backend's default";
  if (backend === "claude") {
    return [
      { label: "Default", value: undefined, detail: defaultDetail },
      { label: "Sonnet latest", value: "sonnet", detail: "Claude Code alias from local CLI help" },
      { label: "Opus latest", value: "opus", detail: "Claude Code alias from local CLI help" },
    ];
  }
  return [
    { label: "Default", value: undefined, detail: defaultDetail },
    { label: "GPT-5.5", value: "gpt-5.5", detail: "Codex fallback model" },
  ];
}

async function discoverCodexModelsDev(): Promise<ModelOption[]> {
  const data = await readModelsDev();
  const provider = data.openai;
  const entries = Object.entries(provider?.models ?? {})
    .filter(([id, model]) => isUsableTextModel(id, model))
    .sort(compareModelEntries("codex"));
  return entries.map(([id, model]) => ({
    label: model.name || id,
    value: id,
    detail: formatModelsDevDetail("OpenAI", model),
  }));
}

async function discoverClaudeModelsDev(): Promise<ModelOption[]> {
  const data = await readModelsDev();
  const provider = data.anthropic;
  const entries = Object.entries(provider?.models ?? {})
    .filter(([id, model]) => id.startsWith("claude-") && isUsableTextModel(id, model))
    .sort(compareModelEntries("claude"));
  return entries.map(([id, model]) => ({
    label: model.name || prettyClaudeModel(id),
    value: id,
    detail: formatModelsDevDetail("Anthropic", model),
  }));
}

async function discoverCodexModelsLocal(): Promise<ModelOption[]> {
  const file = path.join(os.homedir(), ".codex", "models_cache.json");
  const raw = await fsp.readFile(file, "utf8").catch(() => "");
  if (!raw) {
    return [];
  }
  const parsed = JSON.parse(raw) as CodexCache;
  return (parsed.models ?? [])
    .filter((model) => model.slug && model.slug !== "codex-auto-review")
    .map((model) => ({
      label: model.display_name || model.slug || "model",
      value: model.slug,
      detail: model.description || "from local Codex model cache",
    }));
}

async function discoverClaudeModelsLocal(): Promise<ModelOption[]> {
  const counts = new Map<string, number>();
  await collectClaudeProjectModels(path.join(os.homedir(), ".claude", "projects"), counts);
  const recent = [...counts.entries()]
    .filter(([model]) => model !== "<synthetic>")
    .sort((a, b) => b[1] - a[1])
    .map(([model]) => ({
      label: prettyClaudeModel(model),
      value: model,
      detail: "seen in local Claude Code sessions",
    }));
  const options: ModelOption[] = [
    { label: "Sonnet latest", value: "sonnet", detail: "Claude Code alias from local CLI help" },
    { label: "Opus latest", value: "opus", detail: "Claude Code alias from local CLI help" },
  ];
  for (const option of recent) {
    pushUnique(options, option);
  }
  return options;
}

async function readModelsDev(): Promise<ModelsDevCache> {
  const cached = await readModelsDevCache();
  if (cached && Date.now() - cached.mtimeMs < MODELS_DEV_CACHE_MAX_AGE_MS) {
    return cached.data;
  }
  const fresh = await fetchModelsDev().catch(() => null);
  if (fresh) {
    await writeModelsDevCache(fresh);
    return fresh;
  }
  return cached?.data ?? {};
}

async function fetchModelsDev(): Promise<ModelsDevCache> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2500);
  try {
    const response = await fetch(MODELS_DEV_URL, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`models.dev returned ${response.status}`);
    }
    return await response.json() as ModelsDevCache;
  } finally {
    clearTimeout(timer);
  }
}

async function readModelsDevCache(): Promise<{ data: ModelsDevCache; mtimeMs: number } | null> {
  const file = modelsDevCachePath();
  const [raw, stat] = await Promise.all([
    fsp.readFile(file, "utf8").catch(() => ""),
    fsp.stat(file).catch(() => null),
  ]);
  if (!raw || !stat) {
    return null;
  }
  try {
    return { data: JSON.parse(raw) as ModelsDevCache, mtimeMs: stat.mtimeMs };
  } catch {
    return null;
  }
}

async function writeModelsDevCache(data: ModelsDevCache): Promise<void> {
  const file = modelsDevCachePath();
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify(data), { mode: 0o600 });
}

function modelsDevCachePath(): string {
  return path.join(os.homedir(), ".rudder", "models-dev.json");
}

function isUsableTextModel(id: string, model: ModelsDevModel): boolean {
  if (!model.tool_call) {
    return false;
  }
  if (/\b(embedding|image|audio|tts|whisper|transcribe|moderation|rerank)\b/i.test(id)) {
    return false;
  }
  const output = model.modalities?.output;
  return !output || output.includes("text");
}

function compareModelEntries(backend: "claude" | "codex") {
  return (a: [string, ModelsDevModel], b: [string, ModelsDevModel]) => {
    const score = backend === "claude" ? scoreClaudeModel : scoreCodexModel;
    const diff = score(b[0], b[1]) - score(a[0], a[1]);
    if (diff !== 0) {
      return diff;
    }
    return (b[1].release_date ?? "").localeCompare(a[1].release_date ?? "") || a[0].localeCompare(b[0]);
  };
}

function scoreClaudeModel(id: string, model: ModelsDevModel): number {
  let score = 0;
  if (id.includes("sonnet")) score += 40;
  if (id.includes("opus")) score += 35;
  if (id.includes("haiku")) score += 20;
  if (model.reasoning) score += 20;
  score += recencyScore(model);
  return score;
}

function scoreCodexModel(id: string, model: ModelsDevModel): number {
  let score = 0;
  if (id.includes("codex")) score += 60;
  if (id.startsWith("gpt-5")) score += 45;
  if (id.startsWith("o")) score += 20;
  if (model.reasoning) score += 20;
  score += recencyScore(model);
  return score;
}

function recencyScore(model: ModelsDevModel): number {
  const date = model.release_date || model.last_updated;
  if (!date) {
    return 0;
  }
  const timestamp = Date.parse(date);
  if (Number.isNaN(timestamp)) {
    return 0;
  }
  return Math.min(30, Math.max(0, Math.round((timestamp - Date.parse("2024-01-01")) / (30 * 24 * 60 * 60 * 1000))));
}

function formatModelsDevDetail(provider: string, model: ModelsDevModel): string {
  const parts = [`${provider} via models.dev`];
  if (model.limit?.context) {
    parts.push(`${formatNumber(model.limit.context)} ctx`);
  }
  if (model.reasoning) {
    parts.push("reasoning");
  }
  if (model.release_date) {
    parts.push(model.release_date);
  }
  return parts.join(" | ");
}

function formatNumber(value: number): string {
  if (value >= 1_000_000) {
    return `${Math.round(value / 100_000) / 10}M`;
  }
  if (value >= 1_000) {
    return `${Math.round(value / 1000)}k`;
  }
  return String(value);
}

async function collectClaudeProjectModels(dir: string, counts: Map<string, number>, depth = 0): Promise<void> {
  if (depth > 2 || !fs.existsSync(dir)) {
    return;
  }
  const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries.slice(0, 700)) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectClaudeProjectModels(fullPath, counts, depth + 1);
      continue;
    }
    if (!entry.name.endsWith(".jsonl")) {
      continue;
    }
    const raw = await fsp.readFile(fullPath, "utf8").catch(() => "");
    const lines = raw.split(/\r?\n/).slice(-250);
    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }
      try {
        collectModelFields(JSON.parse(line), counts);
      } catch {
        // Ignore corrupt or partial JSONL rows from active sessions.
      }
    }
  }
}

function collectModelFields(value: unknown, counts: Map<string, number>, depth = 0): void {
  if (!value || typeof value !== "object" || depth > 5) {
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectModelFields(item, counts, depth + 1);
    }
    return;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.model === "string") {
    counts.set(record.model, (counts.get(record.model) ?? 0) + 1);
  }
  if (record.model && typeof record.model === "object") {
    const model = record.model as Record<string, unknown>;
    for (const key of ["id", "name", "model"]) {
      if (typeof model[key] === "string") {
        counts.set(model[key], (counts.get(model[key]) ?? 0) + 1);
      }
    }
  }
  for (const child of Object.values(record)) {
    collectModelFields(child, counts, depth + 1);
  }
}

function prettyClaudeModel(model: string): string {
  if (model === "opus" || model === "sonnet") {
    return `${capitalize(model)} latest`;
  }
  return model
    .replace(/^claude-/, "")
    .split("-")
    .map((part) => (/^\d+$/.test(part) ? part : capitalize(part)))
    .join(" ");
}

function capitalize(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}

function pushUnique(options: ModelOption[], option: ModelOption): void {
  if (options.some((existing) => existing.value === option.value)) {
    return;
  }
  options.push(option);
}
