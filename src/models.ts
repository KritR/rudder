import fsp from "node:fs/promises";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BackendId } from "./types.js";

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

export async function discoverModelOptions(
  backend: BackendId,
  configuredDefault?: string,
): Promise<ModelOption[]> {
  const defaultDetail = configuredDefault ? `configured default: ${configuredDefault}` : "use the backend's default";
  const options: ModelOption[] = [{ label: "Default", value: undefined, detail: defaultDetail }];
  const discovered = backend === "claude" ? await discoverClaudeModels() : await discoverCodexModels();
  for (const option of discovered) {
    pushUnique(options, option);
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

async function discoverCodexModels(): Promise<ModelOption[]> {
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

async function discoverClaudeModels(): Promise<ModelOption[]> {
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
