import fsp from "node:fs/promises";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Box, Text, render, useApp, useInput, useWindowSize } from "ink";
import { currentBranch, findRepoRoot } from "./git.js";
import {
  eventsPath,
  listRuns,
  loadConfig,
  outputPath,
} from "./state.js";
import { mergeRun, startRun, stopRun } from "./run-manager.js";
import type { BackendId, RunRecord, RudderConfig, RudderEvent, RunStatus } from "./types.js";
import { pathExists, shortenHome } from "./util.js";

type TuiDefaults = {
  backend?: BackendId;
  model?: string;
  worktree?: boolean;
  detach?: boolean;
};

type UiRun = RunRecord & {
  output: string;
  events: RudderEvent[];
  work: WorkItem[];
};

type WorkItem = {
  label: string;
  detail?: string;
  tone: "muted" | "info" | "success" | "warning" | "danger";
};

const BACKENDS: BackendId[] = ["claude", "codex", "acpx"];

export async function runInteractiveTui(defaults?: TuiDefaults): Promise<void> {
  const instance = render(<RudderTui defaults={defaults ?? {}} />, {
    alternateScreen: true,
    exitOnCtrlC: false,
    maxFps: 12,
  });
  await instance.waitUntilExit();
}

function RudderTui({ defaults }: { defaults: TuiDefaults }): React.ReactElement {
  const app = useApp();
  const size = useWindowSize();
  const [repoRoot, setRepoRoot] = useState(() => findRepoRoot());
  const [branch, setBranch] = useState("HEAD");
  const [config, setConfig] = useState<RudderConfig | null>(null);
  const [backend, setBackend] = useState<BackendId>(defaults.backend ?? "claude");
  const [model, setModel] = useState<string | undefined>(defaults.model);
  const [worktreeMode, setWorktreeMode] = useState<"auto" | "always">(defaults.worktree ? "always" : "auto");
  const [runs, setRuns] = useState<UiRun[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | undefined>();
  const [expandedRunIds, setExpandedRunIds] = useState<Set<string>>(new Set());
  const [transcriptExpanded, setTranscriptExpanded] = useState(false);
  const [input, setInput] = useState("");
  const [notice, setNotice] = useState("Ready");
  const [helpOpen, setHelpOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [preferencesLoaded, setPreferencesLoaded] = useState(false);

  const refresh = useCallback(async () => {
    const root = findRepoRoot();
    const [nextConfig, nextBranch, nextRuns] = await Promise.all([
      loadConfig(),
      currentBranch(root),
      loadUiRuns(root),
    ]);
    setRepoRoot(root);
    setConfig(nextConfig);
    setBranch(nextBranch);
    setRuns(nextRuns);
    if (!preferencesLoaded) {
      setBackend(defaults.backend ?? nextConfig.lastUsedBackend ?? nextConfig.defaultBackend);
      setModel(defaults.model);
      setPreferencesLoaded(true);
    }
    setSelectedRunId((current) => current ?? nextRuns[0]?.id);
  }, [defaults.backend, defaults.model, preferencesLoaded]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => {
      void refresh();
    }, 800);
    return () => clearInterval(timer);
  }, [refresh]);

  const selectedIndex = Math.max(0, runs.findIndex((run) => run.id === selectedRunId));
  const selectedRun = runs[selectedIndex];
  const activeCount = runs.filter((run) => isActive(run.status)).length;
  const selectedExpanded = Boolean(selectedRun && expandedRunIds.has(selectedRun.id));

  const submitTask = useCallback(async (task: string) => {
    const trimmed = task.trim();
    if (!trimmed || submitting) {
      return;
    }
    setSubmitting(true);
    setNotice(`Starting ${backend}...`);
    try {
      const run = await startRun({
        task: trimmed,
        backend,
        model,
        detach: true,
        worktree: worktreeMode === "always",
        silent: true,
        view: "shell",
      });
      setInput("");
      setSelectedRunId(run.id);
      setExpandedRunIds((current) => new Set(current).add(run.id));
      setNotice(`Started ${run.id}`);
      await refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setSubmitting(false);
    }
  }, [backend, model, refresh, submitting, worktreeMode]);

  const handleCommand = useCallback(async (line: string) => {
    const [command = "", ...args] = line.slice(1).trim().split(/\s+/).filter(Boolean);
    switch (command) {
      case "":
      case "help":
      case "?":
        setHelpOpen((value) => !value);
        setInput("");
        return;
      case "q":
      case "quit":
      case "exit":
        app.exit();
        return;
      case "backend":
        if (isBackend(args[0])) {
          setBackend(args[0]);
          setModel(undefined);
          setNotice(`Backend ${args[0]}`);
        } else {
          setNotice("Usage: /backend claude|codex|acpx");
        }
        setInput("");
        return;
      case "model":
        setModel(args.join(" ") || undefined);
        setNotice(args.length ? `Model ${args.join(" ")}` : "Using backend default model");
        setInput("");
        return;
      case "worktree":
        setWorktreeMode(args[0] === "always" || args[0] === "on" ? "always" : "auto");
        setNotice(`Worktrees ${args[0] === "always" || args[0] === "on" ? "always" : "auto"}`);
        setInput("");
        return;
      case "stop":
        await runAction(args[0] ?? selectedRun?.id, async (id) => stopRun(id, { silent: true }), "Stopped", setNotice, refresh);
        setInput("");
        return;
      case "merge":
        await runAction(args[0] ?? selectedRun?.id, async (id) => mergeRun(id, args.includes("--allow-dirty"), { silent: true }), "Merged", setNotice, refresh);
        setInput("");
        return;
      case "clear":
        setExpandedRunIds(new Set());
        setNotice("Collapsed all runs");
        setInput("");
        return;
      default:
        setNotice(`Unknown command: /${command}`);
        setInput("");
    }
  }, [app, refresh, selectedRun?.id]);

  useInput((value, key) => {
    if (key.ctrl && value === "c") {
      app.exit();
      return;
    }
    if (key.escape) {
      if (input) {
        setInput("");
      } else if (helpOpen) {
        setHelpOpen(false);
      } else if (transcriptExpanded) {
        setTranscriptExpanded(false);
      }
      return;
    }
    if (key.tab) {
      cycleBackend(backend, setBackend);
      setModel(undefined);
      return;
    }
    if (key.upArrow || (input.length === 0 && value === "k")) {
      selectRelative(runs, selectedRunId, -1, setSelectedRunId);
      return;
    }
    if (key.downArrow || (input.length === 0 && value === "j")) {
      selectRelative(runs, selectedRunId, 1, setSelectedRunId);
      return;
    }
    if (key.pageUp) {
      selectRelative(runs, selectedRunId, -5, setSelectedRunId);
      return;
    }
    if (key.pageDown) {
      selectRelative(runs, selectedRunId, 5, setSelectedRunId);
      return;
    }
    if (key.return) {
      if (input.trim().startsWith("/")) {
        void handleCommand(input);
      } else {
        void submitTask(input);
      }
      return;
    }
    if (key.backspace || key.delete) {
      setInput((current) => current.slice(0, -1));
      return;
    }
    if (input.length === 0 && value === "q") {
      app.exit();
      return;
    }
    if (input.length === 0 && value === "?") {
      setHelpOpen((current) => !current);
      return;
    }
    if (input.length === 0 && value === "r") {
      void refresh();
      setNotice("Refreshed");
      return;
    }
    if (input.length === 0 && value === "b") {
      cycleBackend(backend, setBackend);
      setModel(undefined);
      return;
    }
    if (input.length === 0 && value === "w") {
      setWorktreeMode((current) => current === "auto" ? "always" : "auto");
      return;
    }
    if (input.length === 0 && value === "x" && selectedRun) {
      setExpandedRunIds((current) => toggleSet(current, selectedRun.id));
      return;
    }
    if (input.length === 0 && value === "l" && selectedRun) {
      setTranscriptExpanded((current) => !current);
      return;
    }
    if (input.length === 0 && value === "s" && selectedRun) {
      void runAction(selectedRun.id, async (id) => stopRun(id, { silent: true }), "Stopped", setNotice, refresh);
      return;
    }
    if (input.length === 0 && value === "m" && selectedRun) {
      void runAction(selectedRun.id, async (id) => mergeRun(id, false, { silent: true }), "Merged", setNotice, refresh);
      return;
    }
    if (isPrintable(value)) {
      setInput((current) => current + value);
    }
  });

  const width = Math.max(80, size.columns);
  const height = Math.max(24, size.rows);
  const railWidth = Math.min(42, Math.max(30, Math.floor(width * 0.34)));
  const detailWidth = Math.max(30, width - railWidth - 1);
  const detailHeight = Math.max(8, height - 8);

  return (
    <Box flexDirection="column" width={width} height={height}>
      <Header repoRoot={repoRoot} branch={branch} backend={backend} model={model ?? modelForBackend(backend, config)} activeCount={activeCount} worktreeMode={worktreeMode} />
      <Box flexGrow={1} minHeight={0}>
        <RunRail runs={runs} selectedRunId={selectedRun?.id} width={railWidth} expandedRunIds={expandedRunIds} />
        <Box flexDirection="column" flexGrow={1} marginLeft={1}>
          <DetailPane run={selectedRun} width={detailWidth} height={detailHeight} expanded={selectedExpanded} transcriptExpanded={transcriptExpanded} />
        </Box>
      </Box>
      {helpOpen ? <Help /> : null}
      <PromptDock input={input} backend={backend} model={model ?? modelForBackend(backend, config)} notice={notice} submitting={submitting} />
      <Footer />
    </Box>
  );
}

function Header(props: {
  repoRoot: string;
  branch: string;
  backend: BackendId;
  model?: string;
  activeCount: number;
  worktreeMode: "auto" | "always";
}): React.ReactElement {
  return (
    <Box borderStyle="single" borderColor="cyan" paddingX={1} justifyContent="space-between">
      <Box>
        <Text bold color="cyan">rudder</Text>
        <Text color="gray">  {shortenHome(props.repoRoot)} </Text>
        <Text color="gray">{props.branch}</Text>
      </Box>
      <Box>
        <Text color="green">{props.backend}</Text>
        <Text color="gray">{props.model ? ` ${props.model}` : ""}</Text>
        <Text color="gray">  worktree:{props.worktreeMode}</Text>
        <Text color={props.activeCount > 0 ? "yellow" : "gray"}>  active:{props.activeCount}</Text>
      </Box>
    </Box>
  );
}

function RunRail(props: {
  runs: UiRun[];
  selectedRunId?: string;
  width: number;
  expandedRunIds: Set<string>;
}): React.ReactElement {
  const visible = props.runs.slice(0, 12);
  return (
    <Box flexDirection="column" width={props.width} borderStyle="single" borderColor="gray" paddingX={1}>
      <Box justifyContent="space-between">
        <Text bold>agents</Text>
        <Text color="gray">{props.runs.length} runs</Text>
      </Box>
      {visible.length === 0 ? (
        <Box marginTop={1}><Text color="gray">No runs yet. Type a task below.</Text></Box>
      ) : null}
      {visible.map((run) => (
        <RunCard
          key={run.id}
          run={run}
          selected={run.id === props.selectedRunId}
          expanded={props.expandedRunIds.has(run.id)}
          width={props.width - 4}
        />
      ))}
    </Box>
  );
}

function RunCard(props: { run: UiRun; selected: boolean; expanded: boolean; width: number }): React.ReactElement {
  const tone = statusColor(props.run.status);
  const label = props.selected ? ">" : " ";
  const task = truncate(props.run.task, Math.max(12, props.width - 14));
  const meta = `${props.run.worktree.enabled ? "wt" : "co"} ${props.expanded ? "open" : "closed"}`;
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text wrap="truncate" color={props.selected ? "white" : "gray"} bold={props.selected}>
        {label} {statusGlyph(props.run.status)} {props.run.backend} {task}
      </Text>
      <Text wrap="truncate" color={tone}>{props.run.status}  <Text color="gray">{meta}</Text></Text>
    </Box>
  );
}

function DetailPane(props: {
  run?: UiRun;
  width: number;
  height: number;
  expanded: boolean;
  transcriptExpanded: boolean;
}): React.ReactElement {
  if (!props.run) {
    return (
      <Box width={props.width} height={props.height} borderStyle="single" borderColor="gray" paddingX={1} flexDirection="column">
        <Text color="gray">No agent selected.</Text>
      </Box>
    );
  }
  const workLimit = props.expanded ? 10 : 5;
  const outputHeight = props.transcriptExpanded ? Math.max(8, props.height - 7) : Math.max(5, Math.floor(props.height * 0.45));
  const contentWidth = Math.max(10, props.width - 4);
  return (
    <Box width={props.width} height={props.height} borderStyle="single" borderColor={statusColor(props.run.status)} paddingX={1} flexDirection="column">
      <Text> </Text>
      <Text wrap="truncate" color={statusColor(props.run.status)}>
        {props.run.status}  {props.run.backend} {shortId(props.run.id)}  {props.run.task}
      </Text>
      <Text wrap="truncate" color="gray">{props.run.worktree.enabled ? shortenHome(props.run.worktree.path) : "current checkout"}</Text>
      {!props.transcriptExpanded ? (
        <Box flexDirection="column" marginTop={1}>
          <Text bold>work</Text>
          {props.run.work.slice(-workLimit).map((item, index) => (
            <Text key={`${item.label}-${index}`} color={toneColor(item.tone)} wrap="truncate">
              {formatWorkLine(item, contentWidth)}
            </Text>
          ))}
          {props.run.work.length === 0 ? <Text color="gray">No worker events yet.</Text> : null}
        </Box>
      ) : null}
      <Box flexDirection="column" marginTop={1} minHeight={0}>
        <Text bold>transcript</Text>
        <Box height={outputHeight} overflow="hidden" flexDirection="column">
          {tailLines(props.run.output, outputHeight).map((line, index) => (
            <Text key={index} wrap="truncate">{line || " "}</Text>
          ))}
        </Box>
      </Box>
    </Box>
  );
}

function Help(): React.ReactElement {
  return (
    <Box borderStyle="single" borderColor="yellow" paddingX={1} flexDirection="column">
      <Text bold color="yellow">keys</Text>
      <Text><Text color="cyan">Enter</Text> submit task or slash command   <Text color="cyan">Tab</Text> switch backend   <Text color="cyan">j/k</Text> or arrows select run</Text>
      <Text><Text color="cyan">x</Text> expand/collapse run   <Text color="cyan">l</Text> expand transcript   <Text color="cyan">w</Text> worktree auto/always</Text>
      <Text><Text color="cyan">s</Text> stop selected   <Text color="cyan">m</Text> merge selected   <Text color="cyan">r</Text> refresh   <Text color="cyan">q</Text> quit</Text>
      <Text color="gray">Slash: /backend claude|codex|acpx, /model &lt;name&gt;, /worktree auto|always, /stop, /merge, /exit</Text>
    </Box>
  );
}

function PromptDock(props: {
  input: string;
  backend: BackendId;
  model?: string;
  notice: string;
  submitting: boolean;
}): React.ReactElement {
  return (
    <Box flexDirection="column" borderStyle="single" borderColor="cyan" paddingX={1}>
      <Box justifyContent="space-between">
        <Text color="gray">{props.notice}</Text>
        <Text color="gray">{props.backend}{props.model ? ` ${props.model}` : ""}</Text>
      </Box>
      <Text>
        <Text color={props.submitting ? "yellow" : "cyan"}>{props.submitting ? "starting" : "task"}</Text>
        <Text>  {props.input}</Text>
        <Text color="cyan">_</Text>
      </Text>
    </Box>
  );
}

function Footer(): React.ReactElement {
  return (
    <Box justifyContent="space-between">
      <Text color="gray">Enter submit  Tab backend  j/k select  x expand  l log  w wt</Text>
      <Text color="gray">? help  q quit</Text>
    </Box>
  );
}

async function loadUiRuns(repoRoot: string): Promise<UiRun[]> {
  const runs = await listRuns(repoRoot);
  return await Promise.all(runs.map(async (run) => {
    const [output, events] = await Promise.all([
      readTextIfExists(outputPath(repoRoot, run.id)),
      readEvents(repoRoot, run.id),
    ]);
    return {
      ...run,
      output,
      events,
      work: buildWork(events, run),
    };
  }));
}

async function readTextIfExists(file: string): Promise<string> {
  if (!(await pathExists(file))) {
    return "";
  }
  return await fsp.readFile(file, "utf8").catch(() => "");
}

async function readEvents(repoRoot: string, runId: string): Promise<RudderEvent[]> {
  const file = eventsPath(repoRoot, runId);
  const raw = await readTextIfExists(file);
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as RudderEvent;
      } catch {
        return null;
      }
    })
    .filter((event): event is RudderEvent => Boolean(event));
}

function buildWork(events: RudderEvent[], run: RunRecord): WorkItem[] {
  const items: WorkItem[] = [];
  for (const event of events) {
    if (event.type === "run.created") {
      items.push({ label: run.worktree.enabled ? "worktree prepared" : "checkout claimed", detail: event.message, tone: "info" });
      continue;
    }
    if (event.type === "planner.spec") {
      items.push({ label: "planner contract", detail: "acceptance criteria generated", tone: "info" });
      continue;
    }
    if (event.type === "run.started") {
      items.push({ label: "worker started", detail: objectField(event.data, "command") ?? run.backend, tone: "info" });
      continue;
    }
    if (event.type === "backend.output") {
      const tool = toolSummary(event.data);
      if (tool) {
        items.push(tool);
      }
      continue;
    }
    if (event.type === "backend.error") {
      items.push({ label: "backend error", detail: event.message, tone: "danger" });
      continue;
    }
    if (event.type === "verifier.result") {
      const missing = missingCount(event.data);
      items.push({ label: "verifier", detail: missing ? `${missing} missing item${missing === 1 ? "" : "s"}` : "accepted", tone: missing ? "warning" : "success" });
      continue;
    }
    if (event.type === "run.completed") {
      items.push({ label: "completed", detail: event.message, tone: "success" });
      continue;
    }
    if (event.type === "run.failed") {
      items.push({ label: "failed", detail: event.message, tone: "danger" });
      continue;
    }
    if (event.type === "run.cancelled") {
      items.push({ label: "cancelled", detail: event.message, tone: "warning" });
      continue;
    }
    if (event.type === "merge.result") {
      items.push({ label: "merge", detail: event.message, tone: event.message?.includes("conflict") ? "warning" : "success" });
    }
  }
  return compactWork(items);
}

function toolSummary(data: unknown): WorkItem | null {
  if (!isRecord(data) || data.type !== "stream_event" || !isRecord(data.event)) {
    return null;
  }
  const event = data.event;
  if (event.type === "content_block_start" && isRecord(event.content_block)) {
    const block = event.content_block;
    if (block.type === "tool_use") {
      return { label: "tool", detail: typeof block.name === "string" ? block.name : "tool_use", tone: "muted" };
    }
  }
  return null;
}

function compactWork(items: WorkItem[]): WorkItem[] {
  const compacted: WorkItem[] = [];
  for (const item of items) {
    const last = compacted.at(-1);
    if (last && last.label === item.label && last.detail === item.detail && last.tone === item.tone) {
      continue;
    }
    compacted.push(item);
  }
  return compacted;
}

function formatWorkLine(item: WorkItem, width: number): string {
  const raw = `${workGlyph(item.tone)} ${item.label}${item.detail ? `  ${item.detail}` : ""}`;
  return truncate(raw, width).padEnd(width, " ");
}

async function runAction(
  runId: string | undefined,
  action: (runId: string) => Promise<unknown>,
  success: string,
  setNotice: (notice: string) => void,
  refresh: () => Promise<void>,
): Promise<void> {
  if (!runId) {
    setNotice("No run selected");
    return;
  }
  try {
    await action(runId);
    setNotice(`${success} ${shortId(runId)}`);
    await refresh();
  } catch (error) {
    setNotice(error instanceof Error ? error.message : String(error));
  }
}

function selectRelative(
  runs: UiRun[],
  selectedRunId: string | undefined,
  delta: number,
  setSelectedRunId: (runId: string | undefined) => void,
): void {
  if (runs.length === 0) {
    return;
  }
  const index = Math.max(0, runs.findIndex((run) => run.id === selectedRunId));
  const next = Math.min(runs.length - 1, Math.max(0, index + delta));
  setSelectedRunId(runs[next]?.id);
}

function cycleBackend(current: BackendId, setBackend: (backend: BackendId) => void): void {
  const index = BACKENDS.indexOf(current);
  setBackend(BACKENDS[(index + 1) % BACKENDS.length] ?? "claude");
}

function toggleSet(current: Set<string>, value: string): Set<string> {
  const next = new Set(current);
  if (next.has(value)) {
    next.delete(value);
  } else {
    next.add(value);
  }
  return next;
}

function modelForBackend(backend: BackendId, config: RudderConfig | null): string | undefined {
  if (!config) {
    return undefined;
  }
  if (backend === "claude") {
    return config.backends.claude?.model;
  }
  if (backend === "codex") {
    return config.backends.codex?.model;
  }
  return config.backends.acpx?.model;
}

function isBackend(value: string | undefined): value is BackendId {
  return value === "claude" || value === "codex" || value === "acpx";
}

function isPrintable(value: string): boolean {
  return value.length > 0 && !/[\u0000-\u001f\u007f]/.test(value);
}

function isActive(status: RunStatus): boolean {
  return status === "created" || status === "running" || status === "verifying";
}

function statusGlyph(status: RunStatus): string {
  if (status === "completed" || status === "merged") {
    return "ok";
  }
  if (status === "failed" || status === "merge-conflict") {
    return "!!";
  }
  if (status === "cancelled") {
    return "--";
  }
  return "..";
}

function statusColor(status: RunStatus): string {
  if (status === "completed" || status === "merged") {
    return "green";
  }
  if (status === "failed" || status === "merge-conflict") {
    return "red";
  }
  if (status === "cancelled") {
    return "yellow";
  }
  if (status === "verifying") {
    return "magenta";
  }
  return "cyan";
}

function toneColor(tone: WorkItem["tone"]): string {
  if (tone === "success") {
    return "green";
  }
  if (tone === "warning") {
    return "yellow";
  }
  if (tone === "danger") {
    return "red";
  }
  if (tone === "info") {
    return "cyan";
  }
  return "gray";
}

function workGlyph(tone: WorkItem["tone"]): string {
  if (tone === "success") {
    return "ok";
  }
  if (tone === "warning") {
    return "??";
  }
  if (tone === "danger") {
    return "!!";
  }
  if (tone === "info") {
    return "->";
  }
  return "--";
}

function missingCount(data: unknown): number {
  if (!isRecord(data) || !Array.isArray(data.missing)) {
    return 0;
  }
  return data.missing.length;
}

function objectField(data: unknown, key: string): string | undefined {
  return isRecord(data) && typeof data[key] === "string" ? data[key] : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function tailLines(text: string, maxLines: number): string[] {
  const normalized = text.replace(/\r/g, "");
  const lines = normalized.includes("\n") ? normalized.split("\n") : chunkLine(normalized, 96);
  const visible = lines.filter((line, index) => line.length > 0 || index < lines.length - 1).slice(-Math.max(1, maxLines));
  return visible.length ? visible : ["No transcript yet."];
}

function chunkLine(text: string, width: number): string[] {
  if (!text) {
    return [];
  }
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += width) {
    chunks.push(text.slice(i, i + width));
  }
  return chunks;
}

function shortId(runId: string): string {
  return runId.slice(0, 14);
}

function truncate(value: string, width: number): string {
  if (value.length <= width) {
    return value;
  }
  if (width <= 1) {
    return value.slice(0, width);
  }
  return `${value.slice(0, Math.max(0, width - 3))}...`;
}
