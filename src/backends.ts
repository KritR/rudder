import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import type { BackendAdapter, BackendId, RunRequest, RudderEvent, AuthProfileStore } from "./types.js";
import { loadAuthStore, saveRunRecord } from "./state.js";
import { commandExists, lineSplitBuffer, nowIso, parseJsonLine } from "./util.js";

export function getBackend(id: BackendId): BackendAdapter {
  if (id === "claude") {
    return claudeBackend();
  }
  if (id === "codex") {
    return codexBackend();
  }
  return acpxBackend();
}

function claudeBackend(): BackendAdapter {
  return {
    id: "claude",
    async verify() {
      return commandExists("claude")
        ? { ok: true, message: "claude found" }
        : { ok: false, message: "claude is not on PATH" };
    },
    async run(request, emit) {
      const existingSessionId = request.run.session?.nativeSessionId;
      const isFollowUp = (request.run.turns?.length ?? 0) > 1;
      const sessionId = existingSessionId ?? randomUUID();
      request.run.session = {
        ...(request.run.session ?? {}),
        nativeSessionId: sessionId,
      };
      await saveRunRecord(request.run);
      const env = await backendEnv("anthropic");
      const args = [
        "-p",
        request.prompt,
        "--model",
        request.run.model || "opus",
        "--effort",
        "xhigh",
        "--permission-mode",
        "bypassPermissions",
        "--dangerously-skip-permissions",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--append-system-prompt",
        request.contract,
        ...(isFollowUp && existingSessionId
          ? ["--resume", existingSessionId, "--fork-session"]
          : ["--session-id", sessionId]),
      ];
      return await spawnAndStream({
        command: "claude",
        args,
        cwd: request.run.worktree.path,
        env,
        request,
        emit,
      });
    },
  };
}

function codexBackend(): BackendAdapter {
  return {
    id: "codex",
    async verify() {
      return commandExists("codex")
        ? { ok: true, message: "codex found" }
        : { ok: false, message: "codex is not on PATH" };
    },
    async run(request, emit) {
      const env = await backendEnv("openai");
      const args = [
        "exec",
        "--json",
        "--color",
        "never",
        "--model",
        request.run.model || "gpt-5.5",
        "--sandbox",
        "danger-full-access",
        "--dangerously-bypass-approvals-and-sandbox",
        "--enable",
        "goals",
        "-c",
        'approval_policy="never"',
        "-c",
        'model_reasoning_effort="xhigh"',
        "-c",
        'model_reasoning_summary="detailed"',
        "-c",
        "model_supports_reasoning_summaries=true",
        `${request.contract}\n\nUSER TASK:\n${request.prompt}`,
      ];
      return await spawnAndStream({
        command: "codex",
        args,
        cwd: request.run.worktree.path,
        env,
        request,
        emit,
      });
    },
  };
}

function acpxBackend(): BackendAdapter {
  return {
    id: "acpx",
    async verify() {
      return commandExists("acpx")
        ? { ok: true, message: "acpx found" }
        : { ok: false, message: "acpx is not on PATH" };
    },
    async run(request, emit) {
      const sessionName = request.run.session?.sessionName ?? request.run.id;
      request.run.session = {
        ...(request.run.session ?? {}),
        sessionName,
      };
      await saveRunRecord(request.run);
      const args = [
        "--approve-all",
        "--format",
        "json",
        ...(request.run.model ? ["--model", request.run.model] : []),
        "--cwd",
        request.run.worktree.path,
        "codex",
        "-s",
        sessionName,
        `${request.contract}\n\nUSER TASK:\n${request.prompt}`,
      ];
      return await spawnAndStream({
        command: "acpx",
        args,
        cwd: request.run.worktree.path,
        env: process.env,
        request,
        emit,
      });
    },
  };
}

async function backendEnv(provider: "anthropic" | "openai"): Promise<NodeJS.ProcessEnv> {
  const store = await loadAuthStore();
  const env = { ...process.env };
  if (provider === "anthropic") {
    const profile = firstProfile(store, ["anthropic:env", "anthropic:default"]);
    if (profile?.type === "api_key" && profile.key) {
      env.ANTHROPIC_API_KEY = profile.key;
    }
    if (profile?.type === "token" && profile.token) {
      env.ANTHROPIC_OAUTH_TOKEN = profile.token;
    }
  }
  if (provider === "openai") {
    const profile = firstProfile(store, ["openai:env", "openai:default"]);
    if (profile?.type === "api_key" && profile.key) {
      env.OPENAI_API_KEY = profile.key;
    }
  }
  return env;
}

function firstProfile(store: AuthProfileStore, ids: string[]) {
  for (const id of ids) {
    const profile = store.profiles[id];
    if (profile) {
      return profile;
    }
  }
  return undefined;
}

async function spawnAndStream(params: {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  request: RunRequest;
  emit: (event: RudderEvent) => Promise<void>;
}): Promise<number> {
  await params.emit({
    ts: nowIso(),
    runId: params.request.run.id,
    type: "run.started",
    message: `${params.command} started`,
    data: { command: params.command, args: params.args },
  });
  const child = spawn(params.command, params.args, {
    cwd: params.cwd,
    env: params.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  params.request.run.process = {
    ...(params.request.run.process ?? {}),
    pid: child.pid,
    startedAt: nowIso(),
  };
  params.request.run.status = "running";
  await saveRunRecord(params.request.run);

  let outRest = "";
  let errRest = "";
  const streamState = { sawStreamingText: false };
  let emitQueue = Promise.resolve();
  const enqueueBackendLine = (line: string, stderr: boolean) => {
    emitQueue = emitQueue
      .then(async () => {
        await emitBackendLine(params.request.run, line, params.emit, stderr, streamState);
      })
      .catch(async (error: unknown) => {
        await params.emit({
          ts: nowIso(),
          runId: params.request.run.id,
          type: "backend.error",
          message: error instanceof Error ? error.message : String(error),
        });
      });
  };
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    const split = lineSplitBuffer(outRest, chunk);
    outRest = split.rest;
    for (const line of split.lines) {
      enqueueBackendLine(line, false);
    }
  });
  child.stderr.on("data", (chunk: string) => {
    const split = lineSplitBuffer(errRest, chunk);
    errRest = split.rest;
    for (const line of split.lines) {
      enqueueBackendLine(line, true);
    }
  });

  return await new Promise((resolve) => {
    child.on("error", (error) => {
      void params.emit({
        ts: nowIso(),
        runId: params.request.run.id,
        type: "backend.error",
        message: error.message,
      });
      resolve(1);
    });
    child.on("close", (code, signal) => {
      if (outRest) {
        enqueueBackendLine(outRest, false);
      }
      if (errRest) {
        enqueueBackendLine(errRest, true);
      }
      void (async () => {
        await emitQueue;
        await params.emit({
          ts: nowIso(),
          runId: params.request.run.id,
          type: "backend.exit",
          message: `${params.command} exited with ${code ?? signal ?? "unknown"}`,
          data: { code: code ?? null, signal: signal ?? null },
        });
        resolve(code ?? (signal ? 130 : 1));
      })();
    });
  });
}

async function emitBackendLine(
  run: RunRequest["run"],
  line: string,
  emit: (event: RudderEvent) => Promise<void>,
  stderr: boolean,
  streamState: { sawStreamingText: boolean },
): Promise<void> {
  const trimmed = line.trimEnd();
  if (!trimmed) {
    return;
  }
  const parsed = parseJsonLine(trimmed);
  const message = parsed ? textFromBackendData(parsed, streamState.sawStreamingText) : trimmed;
  if (isStreamingTextEvent(parsed)) {
    streamState.sawStreamingText = true;
  }
  const sessionId = sessionIdFromBackendData(parsed);
  if (sessionId && run.session?.nativeSessionId !== sessionId) {
    run.session = {
      ...(run.session ?? {}),
      nativeSessionId: sessionId,
    };
    await saveRunRecord(run);
  }
  await emit({
    ts: nowIso(),
    runId: run.id,
    type: stderr ? "backend.error" : "backend.output",
    message: message || undefined,
    data: parsed ?? trimmed,
  });
}

function sessionIdFromBackendData(data: unknown): string | undefined {
  return isRecord(data) && typeof data.session_id === "string" ? data.session_id : undefined;
}

function textFromBackendData(data: unknown, sawStreamingText: boolean): string {
  if (!data || typeof data !== "object") {
    return "";
  }
  const record = data as Record<string, unknown>;
  if (record.type === "stream_event" && isRecord(record.event)) {
    const event = record.event;
    if (event.type === "content_block_delta" && isRecord(event.delta) && typeof event.delta.text === "string") {
      return event.delta.text;
    }
    return "";
  }
  if (record.type === "assistant") {
    if (sawStreamingText) {
      return "";
    }
    return textFromAssistantMessage(record.message);
  }
  if (record.type === "result") {
    if (record.subtype === "success" && typeof record.result === "string") {
      return sawStreamingText ? "" : record.result;
    }
    if (Array.isArray(record.errors)) {
      return record.errors.filter((item) => typeof item === "string").join(", ");
    }
    return "";
  }
  if (typeof record.message === "string") {
    return record.message;
  }
  if (typeof record.text === "string") {
    return record.text;
  }
  return "";
}

function isStreamingTextEvent(data: unknown): boolean {
  if (!isRecord(data) || data.type !== "stream_event" || !isRecord(data.event)) {
    return false;
  }
  const event = data.event;
  return event.type === "content_block_delta" && isRecord(event.delta) && typeof event.delta.text === "string";
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
