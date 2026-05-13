import { spawn } from "node:child_process";
import fsp from "node:fs/promises";
import path from "node:path";
import { createSpec, renderContract, verifyRun } from "./brain.js";
import { getBackend } from "./backends.js";
import {
  createRunRecord,
  agentContextPath,
  eventsPath,
  listRuns,
  loadConfig,
  loadRunRecord,
  outputPath,
  resolveRun,
  runDir,
  saveConfig,
  saveRunRecord,
} from "./state.js";
import type { BackendId, JsonValue, RunRecord, RudderEvent, VerificationResult } from "./types.js";
import {
  appendEvent,
} from "./state.js";
import {
  activeRunsForCheckout,
  createRunWorktree,
  currentBranch,
  currentCommit,
  findRepoRoot,
  mergeRunIntoCurrentBranch,
  processAlive,
  removeWorktree,
} from "./git.js";
import { ensureDir, isTty, newRunId, nowIso, pathExists, shortenHome } from "./util.js";

const AUTO_STEER_DELAY_MS = 10_000;

export async function startRun(params: {
  task: string;
  backend?: BackendId;
  model?: string;
  detach?: boolean;
  worktree?: boolean;
  queue?: boolean;
  json?: boolean;
  exitOnComplete?: boolean;
  watchSignal?: AbortSignal;
  quiet?: boolean;
  silent?: boolean;
  view?: "default" | "shell";
}): Promise<RunRecord> {
  const repoRoot = findRepoRoot();
  const config = await loadConfig();
  const backend = params.backend ?? config.lastUsedBackend ?? config.defaultBackend;
  const model =
    params.model ??
    (backend === "claude"
      ? config.backends.claude?.model
      : backend === "codex"
        ? config.backends.codex?.model
        : config.backends.acpx?.model);

  const active = await activeRunsForCheckout(repoRoot, repoRoot);
  if (params.queue && active.length > 0) {
    throw new Error("Queue mode is not implemented yet; omit --queue to create a worktree run.");
  }
  const useWorktree = Boolean(params.worktree || active.length > 0);
  const baseCommit = await currentCommit(repoRoot);
  const targetBranch = await currentBranch(repoRoot);
  const id = newRunId(params.task);
  const worktreeInfo = useWorktree
    ? await createRunWorktree({ repoRoot, runId: id, task: params.task, baseCommit })
    : { path: repoRoot, branch: undefined };
  const run = await createRunRecord({
    id,
    repoRoot,
    task: params.task,
    backend,
    model,
    targetBranch,
    baseCommit,
    useWorktree,
    worktreeBranch: worktreeInfo.branch,
    worktreePath: worktreeInfo.path,
  });
  await emit(run, {
    ts: nowIso(),
    runId: run.id,
    type: "run.created",
    message: useWorktree
      ? `Created worktree ${shortenHome(worktreeInfo.path)}`
      : "Created run in current checkout",
  });
  await writeAgentContext(repoRoot);

  config.lastUsedBackend = backend;
  await saveConfig(config);
  const worker = spawn(process.execPath, [process.argv[1] ?? "", "__worker", "--repo", repoRoot, "--run", run.id], {
    cwd: repoRoot,
    detached: true,
    stdio: "ignore",
  });
  worker.unref();
  run.process = {
    pid: worker.pid,
    startedAt: nowIso(),
  };
  run.status = "running";
  await saveRunRecord(run);

  if (params.json) {
    console.log(JSON.stringify(run, null, 2));
    return run;
  }
  if (!params.quiet && !params.silent) {
    console.log(`Started ${run.id}`);
    console.log(`  backend: ${backend}${model ? ` (${model})` : ""}`);
    console.log(`  mode:    ${useWorktree ? `worktree ${shortenHome(worktreeInfo.path)}` : "current checkout"}`);
  }
  if (params.detach || !isTty()) {
    if (params.silent) {
      return run;
    }
    if (params.quiet) {
      console.log(`Started ${run.id} in background. Use /watch ${run.id} or rudder watch ${run.id}.`);
    } else {
      console.log(`  watch:   rudder watch ${run.id}`);
    }
    return run;
  }
  await watchRun({
    repoRoot,
    runId: run.id,
    follow: true,
    exitOnComplete: params.exitOnComplete,
    signal: params.watchSignal,
    view: params.view,
  });
  return run;
}

export async function continueRun(params: {
  runId: string;
  prompt: string;
  silent?: boolean;
}): Promise<RunRecord> {
  const repoRoot = findRepoRoot();
  const run = await loadRunRecord(repoRoot, params.runId);
  if (!run) {
    throw new Error(`Run not found: ${params.runId}`);
  }
  if (isActiveStatus(run.status) && run.status !== "steering") {
    throw new Error("That agent is still running. Wait for it to finish before sending another message.");
  }
  const prompt = params.prompt.trim();
  if (!prompt) {
    throw new Error("Missing prompt.");
  }
  const ts = nowIso();
  run.status = "running";
  run.currentPrompt = prompt;
  run.lastUserInputAt = ts;
  run.turns = [...(run.turns ?? []), { ts, prompt, source: "user" }];
  run.autoSteer = { count: 0, max: run.autoSteer?.max ?? 2 };
  await saveRunRecord(run);
  await emit(run, {
    ts,
    runId: run.id,
    type: "run.continued",
    message: "User continued the agent",
    data: { prompt },
  });
  await writeAgentContext(repoRoot);
  const worker = spawn(process.execPath, [process.argv[1] ?? "", "__worker", "--repo", repoRoot, "--run", run.id], {
    cwd: repoRoot,
    detached: true,
    stdio: "ignore",
  });
  worker.unref();
  run.process = {
    pid: worker.pid,
    startedAt: nowIso(),
  };
  await saveRunRecord(run);
  if (!params.silent) {
    console.log(`Continued ${run.id}`);
  }
  return run;
}

export async function workerRun(repoRoot: string, runId: string): Promise<void> {
  const run = await loadRunRecord(repoRoot, runId);
  if (!run) {
    throw new Error(`Run not found: ${runId}`);
  }
  try {
    let current = run;
    while (true) {
      const pass = await runBackendPass(current);
      current = pass.run;
      if (pass.exitCode !== 0) {
        current.status = "failed";
        await saveRunRecord(current);
        await emit(current, {
          ts: nowIso(),
          runId,
          type: "run.failed",
          message: `Backend exited with ${pass.exitCode}`,
        });
        await writeAgentContext(repoRoot);
        return;
      }

      current.status = "verifying";
      await saveRunRecord(current);
      const verification = await verifyRun(current);
      current.verification = verification;
      await saveRunRecord(current);
      await emit(current, {
        ts: nowIso(),
        runId,
        type: "verifier.result",
        message: verification.notes,
        data: verification as unknown as JsonValue,
      });

      if (await shouldAutoSteer(current, verification)) {
        const waitingSince = nowIso();
        current.status = "steering";
        current.autoSteer = {
          count: current.autoSteer?.count ?? 0,
          max: current.autoSteer?.max ?? 2,
          waitingSince,
        };
        await saveRunRecord(current);
        await emit(current, {
          ts: waitingSince,
          runId,
          type: "steerer.waiting",
          message: "Waiting 10 seconds before automatic steering",
        });
        await writeAgentContext(repoRoot);
        await delay(AUTO_STEER_DELAY_MS);
        const latest = await loadRunRecord(repoRoot, runId);
        if (!latest) {
          return;
        }
        if (latest.lastUserInputAt && latest.lastUserInputAt > waitingSince) {
          if (latest.status !== "running") {
            latest.status = "completed";
            await saveRunRecord(latest);
            await emit(latest, {
              ts: nowIso(),
              runId,
              type: "run.completed",
              message: "Run completed; user follow-up took over steering",
            });
          }
          await writeAgentContext(repoRoot);
          return;
        }
        const steeringPrompt = buildSteeringPrompt(verification);
        latest.currentPrompt = steeringPrompt;
        latest.turns = [...(latest.turns ?? []), { ts: nowIso(), prompt: steeringPrompt, source: "steerer" }];
        latest.autoSteer = {
          count: (latest.autoSteer?.count ?? 0) + 1,
          max: latest.autoSteer?.max ?? 2,
        };
        latest.status = "running";
        await saveRunRecord(latest);
        await emit(latest, {
          ts: nowIso(),
          runId,
          type: "steerer.prompt",
          message: "Automatic steering prompt sent",
          data: { prompt: steeringPrompt },
        });
        current = latest;
        continue;
      }

      current.status = verification.shouldContinue ? "failed" : "completed";
      await saveRunRecord(current);
      await emit(current, {
        ts: nowIso(),
        runId,
        type: current.status === "completed" ? "run.completed" : "run.failed",
        message:
          current.status === "completed"
            ? "Run completed"
            : `Run failed verification: ${verification.missing.join("; ")}`,
      });
      await writeAgentContext(repoRoot);
      return;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    run.status = "failed";
    run.process = {
      ...(run.process ?? {}),
      endedAt: nowIso(),
      exitCode: 1,
      signal: null,
    };
    await saveRunRecord(run);
    await emit(run, {
      ts: nowIso(),
      runId,
      type: "run.failed",
      message,
    });
    await writeAgentContext(repoRoot);
  }
}

async function runBackendPass(run: RunRecord): Promise<{ run: RunRecord; exitCode: number }> {
  const spec = await createSpec(run);
  await emit(run, {
    ts: nowIso(),
    runId: run.id,
    type: "planner.spec",
    message: "Planner contract created",
    data: spec as unknown as JsonValue,
  });
  const backend = getBackend(run.backend);
  const health = await backend.verify();
  if (!health.ok) {
    throw new Error(health.message);
  }
  const exitCode = await backend.run(
    {
      run,
      prompt: run.currentPrompt ?? run.task,
      contract: renderContract(spec),
    },
    async (event) => {
      await emit(run, event);
    },
  );
  run.process = {
    ...(run.process ?? {}),
    endedAt: nowIso(),
    exitCode,
    signal: null,
  };
  await saveRunRecord(run);
  return { run, exitCode };
}

async function shouldAutoSteer(run: RunRecord, verification: VerificationResult): Promise<boolean> {
  if (run.status === "cancelled" || run.status === "merged" || run.status === "merge-conflict") {
    return false;
  }
  const max = run.autoSteer?.max ?? 2;
  const count = run.autoSteer?.count ?? 0;
  if (count >= max) {
    return false;
  }
  if (verification.shouldContinue || verification.missing.length > 0) {
    return true;
  }
  return count === 0;
}

function buildSteeringPrompt(verification: VerificationResult): string {
  const missing = verification.missing.length
    ? `\nKnown gaps:\n${verification.missing.map((item) => `- ${item}`).join("\n")}`
    : "";
  return [
    "Rudder automatic steering check:",
    "Pause and review the work you just completed.",
    "What remaining tasks are there, if any?",
    "Does the implementation look correct and scoped?",
    "Were the relevant tests/checks run? If not, run the smallest useful checks now or explain why not.",
    "If anything is missing, fix it. If everything is done, say that clearly and do not make unnecessary changes.",
    missing,
  ]
    .filter(Boolean)
    .join("\n");
}

async function writeAgentContext(repoRoot: string): Promise<void> {
  const runs = await listRuns(repoRoot);
  const active = runs.filter((run) => isActiveStatus(run.status));
  const lines = [
    "# Rudder Agent Context",
    "",
    "This file is generated by Rudder and injected into new agent prompts so each agent can see what the others are doing.",
    "",
    `Updated: ${nowIso()}`,
    "",
    "## Active Agents",
    ...(active.length
      ? active.map((run) => formatAgentContextRun(run))
      : ["- None"]),
    "",
    "## Recent Agents",
    ...runs.slice(0, 12).map((run) => formatAgentContextRun(run)),
    "",
  ];
  await ensureDir(path.dirname(agentContextPath(repoRoot)));
  await fsp.writeFile(agentContextPath(repoRoot), `${lines.join("\n")}\n`, "utf8");
}

function formatAgentContextRun(run: RunRecord): string {
  const location = run.worktree.enabled ? `worktree=${shortenHome(run.worktree.path)}` : "current checkout";
  const prompt = run.currentPrompt && run.currentPrompt !== run.task ? ` current="${run.currentPrompt.slice(0, 140)}"` : "";
  return `- ${run.id}: ${run.status}, ${run.backend}, ${location}, task="${run.task.slice(0, 140)}"${prompt}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function statusRuns(options?: { json?: boolean }): Promise<void> {
  const repoRoot = findRepoRoot();
  const runs = await listRuns(repoRoot);
  const active = runs.filter((run) => isActiveStatus(run.status));
  if (options?.json) {
    console.log(JSON.stringify({ repoRoot, active, runs }, null, 2));
    return;
  }
  console.log(`Repo: ${repoRoot}`);
  if (active.length === 0) {
    console.log("No active runs.");
    return;
  }
  for (const run of active) {
    const alive = processAlive(run.process?.pid) ? "alive" : "stale";
    console.log(`${run.id}  ${run.status}  ${alive}  ${run.backend}  ${run.task}`);
  }
}

export async function listProjectRuns(options?: { json?: boolean }): Promise<void> {
  const repoRoot = findRepoRoot();
  const runs = await listRuns(repoRoot);
  if (options?.json) {
    console.log(JSON.stringify(runs, null, 2));
    return;
  }
  for (const run of runs) {
    const wt = run.worktree.enabled ? ` worktree=${shortenHome(run.worktree.path)}` : "";
    console.log(`${run.id}  ${run.status}  ${run.backend}${wt}  ${run.task}`);
  }
}

export async function watchRun(params: {
  repoRoot?: string;
  runId?: string;
  follow?: boolean;
  exitOnComplete?: boolean;
  signal?: AbortSignal;
  view?: "default" | "shell";
}): Promise<void> {
  const repoRoot = params.repoRoot ?? findRepoRoot();
  const run = await resolveRun(repoRoot, params.runId);
  if (!run) {
    throw new Error("No runs found.");
  }
  const file = eventsPath(repoRoot, run.id);
  await waitForFile(file);
  let offset = 0;
  const initial = await fsp.readFile(file, "utf8").catch(() => "");
  offset = Buffer.byteLength(initial);
  const view = params.view ?? "default";
  const renderer = createEventRenderer(view);
  renderer.print(initial);
  if (!params.follow) {
    return;
  }
  const alreadyDone = await loadRunRecord(repoRoot, run.id);
  if (alreadyDone && !isActiveStatus(alreadyDone.status)) {
    if (params.exitOnComplete !== false) {
      process.exitCode = terminalExitCode(alreadyDone.status);
    }
    return;
  }
  if (view === "default") {
    console.log(`Watching ${run.id}. Ctrl-C detaches; use 'rudder stop ${run.id}' to cancel.`);
  }
  await followFile(file, offset, async (chunk) => {
    renderer.print(chunk);
    const latest = await loadRunRecord(repoRoot, run.id);
    if (latest && !isActiveStatus(latest.status)) {
      if (params.exitOnComplete === false) {
        renderer.finish();
        return false;
      }
      renderer.finish();
      process.exitCode = terminalExitCode(latest.status);
      process.exit();
    }
    return true;
  }, params.signal);
}

export async function printLogs(runId?: string, follow = false): Promise<void> {
  const repoRoot = findRepoRoot();
  const run = await resolveRun(repoRoot, runId);
  if (!run) {
    throw new Error("No runs found.");
  }
  const file = outputPath(repoRoot, run.id);
  if (!(await pathExists(file))) {
    return;
  }
  const output = await fsp.readFile(file, "utf8");
  process.stdout.write(output);
  if (follow) {
    await followFile(file, Buffer.byteLength(output), async (chunk) => {
      process.stdout.write(chunk);
    });
  }
}

export async function stopRun(runId: string, options?: { silent?: boolean }): Promise<void> {
  const repoRoot = findRepoRoot();
  const run = await loadRunRecord(repoRoot, runId);
  if (!run) {
    throw new Error(`Run not found: ${runId}`);
  }
  if (run.process?.pid && processAlive(run.process.pid)) {
    process.kill(run.process.pid, "SIGTERM");
  }
  run.status = "cancelled";
  run.process = {
    ...(run.process ?? {}),
    endedAt: nowIso(),
    signal: "SIGTERM",
  };
  await saveRunRecord(run);
  await emit(run, { ts: nowIso(), runId, type: "run.cancelled", message: "Run cancelled" });
  await writeAgentContext(repoRoot);
  if (!options?.silent) {
    console.log(`Stopped ${runId}`);
  }
}

export async function mergeRun(runId: string, allowDirty = false, options?: { silent?: boolean }): Promise<void> {
  const repoRoot = findRepoRoot();
  const run = await loadRunRecord(repoRoot, runId);
  if (!run) {
    throw new Error(`Run not found: ${runId}`);
  }
  const merged = await mergeRunIntoCurrentBranch(run, allowDirty);
  await emit(merged, {
    ts: nowIso(),
    runId,
    type: "merge.result",
    message:
      merged.merge?.status === "merged"
        ? "Merged successfully"
        : `Merge conflict: ${(merged.merge?.conflictedFiles ?? []).join(", ")}`,
    data: (merged.merge ?? {}) as unknown as JsonValue,
  });
  if (merged.merge?.status === "merged") {
    await writeAgentContext(repoRoot);
    if (!options?.silent) {
      console.log(`Merged ${runId}`);
    }
    return;
  }
  await writeAgentContext(repoRoot);
  if (!options?.silent) {
    console.log(`Merge conflict for ${runId}`);
    for (const file of merged.merge?.conflictedFiles ?? []) {
      console.log(`  ${file}`);
    }
  }
}

export async function cleanupRuns(force = false): Promise<void> {
  const repoRoot = findRepoRoot();
  const runs = await listRuns(repoRoot);
  for (const run of runs) {
    if (!run.worktree.enabled) {
      continue;
    }
    if (!force && run.status !== "merged") {
      continue;
    }
    await removeWorktree(repoRoot, run.worktree.path, force).catch(() => undefined);
    console.log(`Removed ${shortenHome(run.worktree.path)}`);
  }
  await writeAgentContext(repoRoot);
}

async function emit(run: RunRecord, event: RudderEvent): Promise<void> {
  await ensureDir(runDir(run.repoRoot, run.id));
  await appendEvent(run.repoRoot, event);
}

async function waitForFile(file: string): Promise<void> {
  for (let i = 0; i < 50; i += 1) {
    if (await pathExists(file)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function createEventRenderer(view: "default" | "shell"): {
  print(raw: string): void;
  finish(): void;
} {
  let sawStreamingText = false;
  let partialOpen = false;
  return {
    print(raw: string): void {
      for (const line of raw.split(/\r?\n/)) {
        if (!line.trim()) {
          continue;
        }
        try {
          const event = JSON.parse(line) as RudderEvent;
          if (view === "shell") {
            const rendered = renderShellEvent(event, {
              sawStreamingText,
              partialOpen,
            });
            sawStreamingText = rendered.sawStreamingText;
            partialOpen = rendered.partialOpen;
            if (rendered.text) {
              if (rendered.inline) {
                process.stdout.write(rendered.text);
              } else {
                if (partialOpen) {
                  process.stdout.write("\n");
                  partialOpen = false;
                }
                console.log(rendered.text);
              }
            }
            continue;
          }
          printDefaultEvent(event);
        } catch {
          console.log(line);
        }
      }
    },
    finish(): void {
      if (partialOpen) {
        process.stdout.write("\n");
        partialOpen = false;
      }
    },
  };
}

function printDefaultEvent(event: RudderEvent): void {
  if (event.type === "backend.output" || event.type === "backend.error") {
    if (event.message) {
      console.log(event.message);
    } else if (event.data) {
      const text = formatBackendData(event.data);
      if (text) {
        console.log(text);
      }
    }
  } else if (event.message) {
    console.log(`[rudder] ${event.message}`);
  }
}

function renderShellEvent(
  event: RudderEvent,
  state: { sawStreamingText: boolean; partialOpen: boolean },
): { text?: string; inline?: boolean; sawStreamingText: boolean; partialOpen: boolean } {
  let sawStreamingText = state.sawStreamingText;
  let partialOpen = state.partialOpen;
  if (event.type === "run.created") {
    const message = event.message?.startsWith("Created worktree ")
      ? event.message.replace("Created worktree ", "worktree ")
      : undefined;
    return { text: message, sawStreamingText, partialOpen };
  }
  if (event.type === "planner.spec") {
    return { sawStreamingText, partialOpen };
  }
  if (event.type === "run.started") {
    const command = objectField(event.data, "command");
    return {
      text: command ? `running ${command}` : undefined,
      sawStreamingText,
      partialOpen,
    };
  }
  if (event.type === "backend.output" || event.type === "backend.error") {
    const rendered = renderBackendForShell(event.data ?? event.message, event.type === "backend.error", sawStreamingText);
    if (rendered.sawStreamingText) {
      sawStreamingText = true;
    }
    if (rendered.inline) {
      partialOpen = true;
    } else if (rendered.text) {
      partialOpen = false;
    }
    return { ...rendered, sawStreamingText, partialOpen };
  }
  if (event.type === "backend.exit") {
    return { sawStreamingText, partialOpen };
  }
  if (event.type === "verifier.result") {
    const missing = Array.isArray((event.data as { missing?: unknown } | undefined)?.missing)
      ? ((event.data as { missing: unknown[] }).missing.filter((item) => typeof item === "string") as string[])
      : [];
    return {
      text: missing.length ? `verification needs follow-up: ${missing.join("; ")}` : undefined,
      sawStreamingText,
      partialOpen,
    };
  }
  if (event.type === "run.completed") {
    return { text: "done", sawStreamingText, partialOpen };
  }
  if (event.type === "run.failed") {
    return { text: event.message ? `failed: ${event.message}` : "failed", sawStreamingText, partialOpen };
  }
  if (event.type === "run.cancelled") {
    return { text: "cancelled", sawStreamingText, partialOpen };
  }
  if (event.type === "merge.result") {
    return { text: event.message, sawStreamingText, partialOpen };
  }
  return { sawStreamingText, partialOpen };
}

function renderBackendForShell(
  data: unknown,
  stderr: boolean,
  sawStreamingText: boolean,
): { text?: string; inline?: boolean; sawStreamingText?: boolean } {
  if (typeof data === "string") {
    return { text: stderr ? `error: ${data}` : data };
  }
  if (!data || typeof data !== "object") {
    return {};
  }
  const record = data as Record<string, unknown>;
  if (record.type === "stream_event" && isRecord(record.event)) {
    const event = record.event;
    if (event.type === "content_block_delta" && isRecord(event.delta) && typeof event.delta.text === "string") {
      return { text: event.delta.text, inline: true, sawStreamingText: true };
    }
    return {};
  }
  if (record.type === "assistant") {
    if (sawStreamingText) {
      return {};
    }
    const text = textFromAssistantMessage(record.message);
    return text ? { text } : {};
  }
  if (record.type === "result") {
    if (record.subtype === "success") {
      const text = typeof record.result === "string" && !sawStreamingText ? record.result.trim() : "";
      return text ? { text } : {};
    }
    const errors = Array.isArray(record.errors) ? record.errors.filter((item) => typeof item === "string") : [];
    return { text: `error: ${errors.join(", ") || String(record.subtype ?? "unknown")}` };
  }
  if (record.type === "system") {
    return {};
  }
  return {};
}

function textFromAssistantMessage(message: unknown): string {
  if (!isRecord(message)) {
    return "";
  }
  const content = message.content;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((block) => {
      if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
        return block.text;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function objectField(data: unknown, key: string): string | undefined {
  return isRecord(data) && typeof data[key] === "string" ? data[key] : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function formatBackendData(data: unknown): string {
  if (typeof data === "string") {
    return data;
  }
  if (data && typeof data === "object") {
    const record = data as Record<string, unknown>;
    if (record.type === "system" || record.type === "rate_limit_event" || record.type === "tool_use_summary") {
      return "";
    }
    if (record.type === "stream_event" && isRecord(record.event)) {
      const event = record.event;
      if (event.type === "content_block_delta" && isRecord(event.delta) && typeof event.delta.text === "string") {
        return event.delta.text;
      }
      return "";
    }
    if (record.type === "assistant") {
      return textFromAssistantMessage(record.message);
    }
    if (record.type === "result") {
      if (record.subtype === "success" && typeof record.result === "string") {
        return record.result;
      }
      if (Array.isArray(record.errors)) {
        return record.errors.filter((item) => typeof item === "string").join(", ");
      }
    }
    for (const key of ["message", "text", "content", "delta"]) {
      if (typeof record[key] === "string") {
        return record[key];
      }
    }
    if (typeof record.type === "string") {
      return `[${record.type}] ${JSON.stringify(record)}`;
    }
  }
  return JSON.stringify(data);
}

async function followFile(
  file: string,
  startOffset: number,
  onChunk: (chunk: string) => Promise<boolean | void>,
  signal?: AbortSignal,
): Promise<void> {
  let offset = startOffset;
  while (!signal?.aborted) {
    const stat = await fsp.stat(file).catch(() => null);
    if (stat && stat.size > offset) {
      const handle = await fsp.open(file, "r");
      try {
        const length = stat.size - offset;
        const buffer = Buffer.alloc(length);
        await handle.read(buffer, 0, length, offset);
        offset = stat.size;
        const keepGoing = await onChunk(buffer.toString("utf8"));
        if (keepGoing === false) {
          return;
        }
      } finally {
        await handle.close();
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 350));
  }
}

function isActiveStatus(status: RunRecord["status"]): boolean {
  return status === "created" || status === "running" || status === "steering" || status === "verifying";
}

function terminalExitCode(status: RunRecord["status"]): number {
  return status === "completed" || status === "merged" ? 0 : 1;
}
