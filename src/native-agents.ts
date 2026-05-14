import type { RunRecord } from "./types.js";
import { shellQuote } from "./util.js";

export function nativeAgentCommand(params: {
  run: RunRecord;
  prompt: string;
  contract: string;
}): string {
  const args = params.run.backend === "codex"
    ? codexArgs(params.run, params.prompt, params.contract)
    : claudeArgs(params.run, params.prompt, params.contract);
  return args.map(shellQuote).join(" ");
}

function claudeArgs(run: RunRecord, prompt: string, contract: string): string[] {
  const model = run.model || "sonnet";
  const effort = run.effort || "xhigh";
  const sessionId = run.session?.nativeSessionId;
  return compact([
    "claude",
    "--model",
    model,
    "--effort",
    effort,
    "--permission-mode",
    "bypassPermissions",
    "--dangerously-skip-permissions",
    "--append-system-prompt",
    contract,
    "--name",
    paneTitle(run),
    sessionId ? "--session-id" : undefined,
    sessionId,
    prompt,
  ]);
}

function codexArgs(run: RunRecord, prompt: string, contract: string): string[] {
  const model = run.model || "gpt-5.5";
  const effort = codexEffort(run.effort);
  return [
    "codex",
    "--model",
    model,
    "--sandbox",
    "danger-full-access",
    "--ask-for-approval",
    "never",
    "--dangerously-bypass-approvals-and-sandbox",
    "--enable",
    "goals",
    "-c",
    `model_reasoning_effort="${effort}"`,
    "-c",
    'model_reasoning_summary="detailed"',
    "-c",
    "model_supports_reasoning_summaries=true",
    "--cd",
    run.worktree.path,
    [contract, "", prompt].join("\n"),
  ];
}

function codexEffort(effort: RunRecord["effort"]): string {
  return effort === "max" ? "xhigh" : effort || "xhigh";
}

function paneTitle(run: RunRecord): string {
  const words = run.task.replace(/\s+/g, " ").trim().slice(0, 34);
  return `${run.backend}:${words || run.id.slice(0, 12)}`;
}

function compact(values: Array<string | undefined>): string[] {
  return values.filter((value): value is string => Boolean(value));
}
