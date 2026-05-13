import fsp from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, render, useApp, useInput, useWindowSize } from "ink";
import { currentBranch, findRepoRoot } from "./git.js";
import { discoverModelOptions, fallbackModelOptions, type ModelOption } from "./models.js";
import {
  eventsPath,
  listRuns,
  loadConfig,
  outputPath,
} from "./state.js";
import { continueRun, mergeRun, startRun, stopRun } from "./run-manager.js";
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

type FocusPane = "agents" | "worker" | "task";

const BACKENDS: BackendId[] = ["claude", "codex", "acpx"];
const COMPLETION_SOUND = fileURLToPath(new URL("../assets/sounds/ping.mp3", import.meta.url));

type CommandOption = {
  name: string;
  detail: string;
  insert: string;
};

const COMMANDS: CommandOption[] = [
  { name: "backend", detail: "switch backend: claude, codex, acpx", insert: "/backend " },
  { name: "model", detail: "open model picker or set a custom model id", insert: "/model" },
  { name: "agent", detail: "send your next input to the selected agent", insert: "/agent" },
  { name: "interrupt", detail: "interrupt and redirect the selected running agent", insert: "/interrupt" },
  { name: "new", detail: "return to new-agent mode", insert: "/new" },
  { name: "worktree", detail: "toggle worktree policy", insert: "/worktree " },
  { name: "stop", detail: "stop the selected run", insert: "/stop" },
  { name: "merge", detail: "merge the selected completed worktree", insert: "/merge" },
  { name: "merge-all", detail: "merge all completed worktrees", insert: "/merge-all" },
  { name: "clear", detail: "collapse all run cards", insert: "/clear" },
  { name: "help", detail: "show key and slash command help", insert: "/help" },
  { name: "exit", detail: "quit Rudder", insert: "/exit" },
];

export async function runInteractiveTui(defaults?: TuiDefaults): Promise<void> {
  const instance = render(<RudderTui defaults={defaults ?? {}} />, {
    alternateScreen: true,
    exitOnCtrlC: false,
    maxFps: 60,
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
  const [worktreeMode, setWorktreeMode] = useState<"auto" | "always">(defaults.worktree === false ? "auto" : "always");
  const [runs, setRuns] = useState<UiRun[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | undefined>();
  const [targetRunId, setTargetRunId] = useState<string | undefined>();
  const [focusPane, setFocusPane] = useState<FocusPane>("task");
  const [expandedRunIds, setExpandedRunIds] = useState<Set<string>>(new Set());
  const [transcriptExpanded, setTranscriptExpanded] = useState(false);
  const [input, setInput] = useState("");
  const [notice, setNotice] = useState("Ready");
  const [helpOpen, setHelpOpen] = useState(false);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [modelMenuIndex, setModelMenuIndex] = useState(0);
  const [commandMenuIndex, setCommandMenuIndex] = useState(0);
  const [discoveredModels, setDiscoveredModels] = useState<ModelOption[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [preferencesLoaded, setPreferencesLoaded] = useState(false);
  const notifiedFinishedRuns = useRef<Set<string> | null>(null);

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
    notifyFinishedRuns(nextRuns, notifiedFinishedRuns);
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
    }, input ? 1500 : 900);
    return () => clearInterval(timer);
  }, [input, refresh]);

  useEffect(() => {
    let cancelled = false;
    const configuredDefault = modelForBackend(backend, config);
    void discoverModelOptions(backend, configuredDefault)
      .then((options) => {
        if (!cancelled) {
          setDiscoveredModels(options);
          setModelMenuIndex(0);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setDiscoveredModels(fallbackModelOptions(backend, configuredDefault));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [backend, config]);

  const selectedIndex = Math.max(0, runs.findIndex((run) => run.id === selectedRunId));
  const selectedRun = runs[selectedIndex];
  const targetRun = focusPane === "worker" && selectedRun ? selectedRun : targetRunId ? runs.find((run) => run.id === targetRunId) : undefined;
  const activeCount = runs.filter((run) => isActive(run.status)).length;
  const selectedExpanded = Boolean(selectedRun && expandedRunIds.has(selectedRun.id));
  const modelOptions = useMemo(
    () => discoveredModels.length ? discoveredModels : fallbackModelOptions(backend, modelForBackend(backend, config)),
    [backend, config, discoveredModels],
  );
  const commandOptions = useMemo(() => filterCommands(input), [input]);
  const commandMenuOpen = input.startsWith("/") && !modelMenuOpen && commandOptions.length > 0;

  const submitTask = useCallback(async (task: string) => {
    const trimmed = task.trim();
    if (!trimmed || submitting) {
      return;
    }
    setSubmitting(true);
    if (targetRun) {
      const interrupt = isActive(targetRun.status);
      setNotice(`${interrupt ? "Interrupting" : "Sending to"} ${shortId(targetRun.id)}...`);
      try {
        const run = await continueRun({
          runId: targetRun.id,
          prompt: trimmed,
          interrupt,
          silent: true,
        });
        setInput("");
        setSelectedRunId(run.id);
        setExpandedRunIds((current) => new Set(current).add(run.id));
        setNotice(`${interrupt ? "Interrupted" : "Sent to"} ${shortId(run.id)}`);
        await refresh();
      } catch (error) {
        setNotice(error instanceof Error ? error.message : String(error));
      } finally {
        setSubmitting(false);
      }
      return;
    }
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
  }, [backend, model, refresh, submitting, targetRun, worktreeMode]);

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
          chooseBackend(args[0], setBackend, setModel, setNotice);
        } else {
          setNotice("Usage: /backend claude|codex|acpx");
        }
        setInput("");
        return;
      case "agent":
      case "continue":
      case "interrupt": {
        const run = resolveUiRun(runs, args[0] ?? selectedRun?.id);
        if (run) {
          setTargetRunId(run.id);
          setSelectedRunId(run.id);
          setFocusPane("worker");
          setNotice(`${isActive(run.status) ? "Esc/Enter will interrupt" : "Typing to"} ${shortId(run.id)}`);
        } else {
          setNotice("No agent selected");
        }
        setInput("");
        return;
      }
      case "new":
        setTargetRunId(undefined);
        setFocusPane("task");
        setNotice("Typing starts a new agent");
        setInput("");
        return;
      case "model":
        if (args.length === 0) {
          setModelMenuOpen(true);
          setModelMenuIndex(0);
          setNotice(`Pick a ${backend} model`);
        } else {
          const nextModel = args.join(" ");
          setModel(nextModel);
          setNotice(`Model ${nextModel}`);
        }
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
      case "merge-all":
        await mergeReadyRuns(runs, args.includes("--allow-dirty"), setNotice, refresh);
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
  }, [app, backend, refresh, runs, selectedRun?.id]);

  const selectModelOption = useCallback((index: number) => {
    const option = modelOptions[index];
    if (!option) {
      return;
    }
    setModel(option.value);
    setModelMenuOpen(false);
    setModelMenuIndex(index);
    setNotice(option.value ? `Model ${option.value}` : "Using backend default model");
  }, [modelOptions]);

  const selectCommandOption = useCallback((index: number) => {
    const option = commandOptions[index];
    if (!option) {
      return;
    }
    setInput(option.insert.endsWith(" ") ? option.insert : option.insert);
    setCommandMenuIndex(index);
    if (!option.insert.endsWith(" ") && option.insert !== "/model") {
      setNotice(`Press Enter to run ${option.insert}`);
    }
    if (option.insert === "/model") {
      setInput("");
      setModelMenuOpen(true);
      setModelMenuIndex(0);
      setNotice(`Pick a ${backend} model`);
    }
  }, [backend, commandOptions]);

  useInput((value, key) => {
    if (key.ctrl && value === "c") {
      app.exit();
      return;
    }
    if (key.tab || value === "\t") {
      const next = nextFocusPane(focusPane);
      setFocusPane(next);
      setModelMenuOpen(false);
      setInput("");
      if (next === "worker" && selectedRun) {
        setNotice(`${isActive(selectedRun.status) ? "Worker focus: type redirect, Enter interrupts" : "Worker focus: type follow-up"} ${shortId(selectedRun.id)}`);
      } else if (next === "agents") {
        setNotice("Agents focus: j/k or arrows select runs");
      } else {
        setTargetRunId(undefined);
        setNotice("Task focus: type a new task");
      }
      return;
    }
    if (modelMenuOpen) {
      if (key.escape) {
        setModelMenuOpen(false);
        setNotice("Model unchanged");
        return;
      }
      if (key.upArrow || value === "k") {
        setModelMenuIndex((current) => Math.max(0, current - 1));
        return;
      }
      if (key.downArrow || value === "j") {
        setModelMenuIndex((current) => Math.min(modelOptions.length - 1, current + 1));
        return;
      }
      if (key.return) {
        selectModelOption(modelMenuIndex);
        return;
      }
      const numeric = Number(value);
      if (Number.isInteger(numeric) && numeric >= 1 && numeric <= modelOptions.length) {
        selectModelOption(numeric - 1);
        return;
      }
      return;
    }
    if (commandMenuOpen && input.startsWith("/")) {
      if (key.upArrow || value === "\u001b[A") {
        setCommandMenuIndex((current) => Math.max(0, current - 1));
        return;
      }
      if (key.downArrow || value === "\u001b[B") {
        setCommandMenuIndex((current) => Math.min(commandOptions.length - 1, current + 1));
        return;
      }
    }
    if (key.escape) {
      if (input) {
        setInput("");
      } else if (helpOpen) {
        setHelpOpen(false);
      } else if (transcriptExpanded) {
        setTranscriptExpanded(false);
      } else if (selectedRun) {
        setFocusPane("worker");
        setNotice(`${isActive(selectedRun.status) ? "Type redirect, Enter interrupts" : "Typing to"} ${shortId(selectedRun.id)}`);
      }
      return;
    }
    if (key.upArrow || (input.length === 0 && value === "k")) {
      selectRelative(runs, selectedRunId, -1, setSelectedRunId);
      if (focusPane === "task") {
        setFocusPane("agents");
      }
      return;
    }
    if (key.downArrow || (input.length === 0 && value === "j")) {
      selectRelative(runs, selectedRunId, 1, setSelectedRunId);
      if (focusPane === "task") {
        setFocusPane("agents");
      }
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
      if (commandMenuOpen && shouldSelectCommand(input, commandOptions)) {
        selectCommandOption(commandMenuIndex);
      } else if (input.trim().startsWith("/")) {
        void handleCommand(input);
      } else {
        void submitTask(input);
      }
      return;
    }
    if ((key.meta && (key.backspace || key.delete)) || value === "\u001b\u007f" || value === "\u001b\b") {
      setInput((current) => deletePreviousWord(current));
      return;
    }
    if (key.ctrl && value === "w") {
      setInput((current) => deletePreviousWord(current));
      return;
    }
    if (key.backspace || key.delete || value === "\u007f" || value === "\b") {
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
      cycleBackend(backend, setBackend, setModel, setNotice);
      return;
    }
    if (input.length === 0 && value === "o") {
      setModelMenuOpen(true);
      setModelMenuIndex(0);
      setNotice(`Pick a ${backend} model`);
      return;
    }
    if (input.length === 0 && value === "c" && selectedRun) {
      setFocusPane("worker");
      setNotice(`${isActive(selectedRun.status) ? "Type redirect, Enter interrupts" : "Typing to"} ${shortId(selectedRun.id)}`);
      return;
    }
    if (input.length === 0 && value === "n") {
      setTargetRunId(undefined);
      setFocusPane("task");
      setNotice("Typing starts a new agent");
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
    if (input.length === 0 && value === "M") {
      void mergeReadyRuns(runs, false, setNotice, refresh);
      return;
    }
    if (focusPane === "agents" && value !== "/") {
      return;
    }
    if (focusPane === "worker" && !selectedRun && value !== "/") {
      setNotice("No agent selected");
      return;
    }
    if (isPrintable(value)) {
      setInput((current) => current + value);
      setCommandMenuIndex(0);
    }
  });

  const width = Math.max(80, size.columns);
  const height = Math.max(24, size.rows);
  const railWidth = Math.min(42, Math.max(30, Math.floor(width * 0.34)));
  const detailWidth = Math.max(30, width - railWidth - 1);
  const detailHeight = Math.max(8, height - 8);

  return (
    <Box flexDirection="column" width={width} height={height}>
      <Header width={width} repoRoot={repoRoot} branch={branch} backend={backend} model={model ?? modelForBackend(backend, config)} activeCount={activeCount} worktreeMode={worktreeMode} />
      <Box flexGrow={1} minHeight={0}>
        <RunRail runs={runs} selectedRunId={selectedRun?.id} targetRunId={targetRun?.id} width={railWidth} expandedRunIds={expandedRunIds} focused={focusPane === "agents"} />
        <Box flexDirection="column" flexGrow={1} marginLeft={1}>
          <DetailPane run={selectedRun} width={detailWidth} height={detailHeight} expanded={selectedExpanded} transcriptExpanded={transcriptExpanded} focused={focusPane === "worker"} />
        </Box>
      </Box>
      {helpOpen ? <Help /> : null}
      {modelMenuOpen ? <ModelMenu backend={backend} options={modelOptions} selectedIndex={modelMenuIndex} currentModel={model} /> : null}
      {commandMenuOpen ? <CommandMenu options={commandOptions} selectedIndex={commandMenuIndex} /> : null}
      <PromptDock input={input} backend={backend} model={model ?? modelForBackend(backend, config)} notice={notice} submitting={submitting} targetRun={targetRun} focused={focusPane === "task"} />
      <Footer focusPane={focusPane} />
    </Box>
  );
}

function Header(props: {
  width: number;
  repoRoot: string;
  branch: string;
  backend: BackendId;
  model?: string;
  activeCount: number;
  worktreeMode: "auto" | "always";
}): React.ReactElement {
  const contentWidth = Math.max(10, props.width - 4);
  const label = `rudder  ${shortenHome(props.repoRoot)} ${props.branch}  |  ${props.backend}${props.model ? ` ${props.model}` : ""}  |  worktree:${props.worktreeMode}  active:${props.activeCount}`;
  return (
    <Box borderStyle="single" borderColor="cyan" paddingX={1}>
      <Text bold color="cyan">{fitLine(label, contentWidth)}</Text>
    </Box>
  );
}

function RunRail(props: {
  runs: UiRun[];
  selectedRunId?: string;
  targetRunId?: string;
  width: number;
  expandedRunIds: Set<string>;
  focused: boolean;
}): React.ReactElement {
  const visible = props.runs.slice(0, 12);
  return (
    <Box flexDirection="column" width={props.width} borderStyle="single" borderColor={props.focused ? "cyan" : "gray"} paddingX={1}>
      <Box justifyContent="space-between">
        <Text bold color={props.focused ? "cyan" : undefined}>agents</Text>
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
          targeted={run.id === props.targetRunId}
          expanded={props.expandedRunIds.has(run.id)}
          width={props.width - 4}
        />
      ))}
    </Box>
  );
}

function RunCard(props: { run: UiRun; selected: boolean; targeted: boolean; expanded: boolean; width: number }): React.ReactElement {
  const tone = statusColor(props.run.status);
  const label = props.selected ? ">" : " ";
  const task = truncate(props.run.task, Math.max(12, props.width - 14));
  const progress = completionPercent(props.run);
  const summary = truncate(runSummary(props.run), Math.max(12, props.width - 8));
  const meta = `${progressBar(progress)} ${progress}%`;
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text wrap="truncate" color={props.selected ? "white" : "gray"} bold={props.selected}>
        {label} {meta} {statusGlyph(props.run.status)} {props.run.backend} {task}
      </Text>
      <Text wrap="truncate" color={tone}>  {props.run.worktree.enabled ? "wt" : "co"} {props.targeted ? "typing " : ""}{summary}</Text>
    </Box>
  );
}

function DetailPane(props: {
  run?: UiRun;
  width: number;
  height: number;
  expanded: boolean;
  transcriptExpanded: boolean;
  focused: boolean;
}): React.ReactElement {
  if (!props.run) {
    return (
      <Box width={props.width} height={props.height} borderStyle="single" borderColor={props.focused ? "cyan" : "gray"} paddingX={1} flexDirection="column">
        <Text color="gray">No agent selected.</Text>
      </Box>
    );
  }
  const workLimit = props.expanded ? 10 : 5;
  const outputHeight = props.transcriptExpanded ? Math.max(8, props.height - 7) : Math.max(5, Math.floor(props.height * 0.45));
  const contentWidth = Math.max(10, props.width - 4);
  const progress = completionPercent(props.run);
  return (
    <Box width={props.width} height={props.height} borderStyle="single" borderColor={props.focused ? "cyan" : statusColor(props.run.status)} paddingX={1} flexDirection="column">
      <Text> </Text>
      <Text wrap="truncate" color={statusColor(props.run.status)}>
        {fitLine(`${props.focused ? "focus  " : ""}${props.run.status}  ${progress}%  ${props.run.backend} ${shortId(props.run.id)}  ${props.run.task}`, contentWidth)}
      </Text>
      <Text wrap="truncate" color="gray">
        {fitLine(props.run.worktree.enabled ? shortenHome(props.run.worktree.path) : "current checkout", contentWidth)}
      </Text>
      <Text wrap="truncate" color={canMerge(props.run) ? "green" : "gray"}>
        {fitLine(canMerge(props.run) ? "[m] merge this  [M] merge all ready" : runSummary(props.run), contentWidth)}
      </Text>
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
      <Text><Text color="cyan">Tab</Text> focus agents/worker/task   <Text color="cyan">Enter</Text> submit focused input   <Text color="cyan">b</Text> switch backend   <Text color="cyan">j/k</Text> select run</Text>
      <Text><Text color="cyan">worker focus</Text> type to selected agent; running agents are interrupted on Enter   <Text color="cyan">n</Text> new task   <Text color="cyan">x</Text> expand   <Text color="cyan">l</Text> transcript</Text>
      <Text><Text color="cyan">o</Text> model picker   <Text color="cyan">/</Text> command search   <Text color="cyan">w</Text> worktree auto/always   <Text color="cyan">s</Text> stop   <Text color="cyan">m/M</Text> merge</Text>
      <Text color="gray">Slash: /backend claude|codex|acpx, /model, /model &lt;name&gt;, /agent, /interrupt, /new, /worktree, /stop, /merge, /merge-all, /exit</Text>
    </Box>
  );
}

function ModelMenu(props: {
  backend: BackendId;
  options: ModelOption[];
  selectedIndex: number;
  currentModel?: string;
}): React.ReactElement {
  return (
    <Box borderStyle="single" borderColor="magenta" paddingX={1} flexDirection="column">
      <Text bold color="magenta">model: {props.backend}</Text>
      {props.options.map((option, index) => {
        const selected = index === props.selectedIndex;
        const active = option.value === props.currentModel || (!option.value && !props.currentModel);
        const label = `${index + 1}. ${option.label}${active ? "  current" : ""}`;
        return (
          <Text key={`${option.label}-${index}`} color={selected ? "white" : "gray"} bold={selected} wrap="truncate">
            {selected ? "> " : "  "}{label.padEnd(28, " ")} {option.detail}
          </Text>
        );
      })}
      <Text color="gray">Enter selects, Esc cancels, j/k or arrows move. Type /model &lt;id&gt; for a custom model.</Text>
    </Box>
  );
}

function CommandMenu(props: { options: CommandOption[]; selectedIndex: number }): React.ReactElement {
  const visible = props.options.slice(0, 8);
  return (
    <Box borderStyle="single" borderColor="blue" paddingX={1} flexDirection="column">
      <Text bold color="blue">commands</Text>
      {visible.map((option, index) => {
        const selected = index === props.selectedIndex;
        return (
          <Text key={option.name} color={selected ? "white" : "gray"} bold={selected} wrap="truncate">
            {selected ? "> " : "  "}/{option.name.padEnd(12, " ")} {option.detail}
          </Text>
        );
      })}
      <Text color="gray">Tab completes, Enter runs exact commands, arrows move.</Text>
    </Box>
  );
}

function PromptDock(props: {
  input: string;
  backend: BackendId;
  model?: string;
  notice: string;
  submitting: boolean;
  targetRun?: UiRun;
  focused: boolean;
}): React.ReactElement {
  const label = props.targetRun ? `${isActive(props.targetRun.status) ? "interrupt" : "agent"} ${shortId(props.targetRun.id)}` : "task";
  return (
    <Box borderStyle="single" borderColor={props.focused ? "cyan" : props.targetRun ? "magenta" : "gray"} paddingX={1} justifyContent="space-between">
      <Text>
        <Text color={props.submitting ? "yellow" : props.targetRun ? "magenta" : "cyan"}>{props.submitting ? "starting" : label}</Text>
        <Text>  {props.input}</Text>
        <Text color="cyan">_</Text>
      </Text>
      <Text color="gray">{props.notice}  {props.backend}{props.model ? ` ${props.model}` : ""}</Text>
    </Box>
  );
}

function Footer(props: { focusPane: FocusPane }): React.ReactElement {
  return (
    <Box>
      <Text color="gray">focus:{props.focusPane}  Tab focus  b backend  o model  / commands  n new  c worker  j/k select  m/M merge  ? help</Text>
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
    if (event.type === "run.continued") {
      items.push({ label: "user follow-up", detail: event.message, tone: "info" });
      continue;
    }
    if (event.type === "steerer.waiting") {
      items.push({ label: "auto-steering wait", detail: "10s grace period", tone: "warning" });
      continue;
    }
    if (event.type === "steerer.prompt") {
      items.push({ label: "auto-steering", detail: "review prompt sent", tone: "info" });
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
  return fitLine(raw, width);
}

function fitLine(value: string, width: number): string {
  return truncate(value, width).padEnd(width, " ");
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

async function mergeReadyRuns(
  runs: UiRun[],
  allowDirty: boolean,
  setNotice: (notice: string) => void,
  refresh: () => Promise<void>,
): Promise<void> {
  const ready = runs.filter(canMerge);
  if (ready.length === 0) {
    setNotice("No completed worktree runs ready to merge");
    return;
  }
  setNotice(`Merging ${ready.length} run${ready.length === 1 ? "" : "s"}...`);
  let merged = 0;
  for (const run of ready) {
    await mergeRun(run.id, allowDirty, { silent: true });
    merged += 1;
  }
  setNotice(`Merged ${merged} run${merged === 1 ? "" : "s"}`);
  await refresh();
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

function nextFocusPane(current: FocusPane): FocusPane {
  if (current === "agents") {
    return "worker";
  }
  if (current === "worker") {
    return "task";
  }
  return "agents";
}

function cycleBackend(
  current: BackendId,
  setBackend: (backend: BackendId) => void,
  setModel: (model: string | undefined) => void,
  setNotice: (notice: string) => void,
): void {
  const index = BACKENDS.indexOf(current);
  chooseBackend(BACKENDS[(index + 1) % BACKENDS.length] ?? "claude", setBackend, setModel, setNotice);
}

function chooseBackend(
  backend: BackendId,
  setBackend: (backend: BackendId) => void,
  setModel: (model: string | undefined) => void,
  setNotice: (notice: string) => void,
): void {
  setBackend(backend);
  setModel(undefined);
  setNotice(`Backend ${backend}`);
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
    return config.backends.claude?.model === "opus" ? "sonnet" : config.backends.claude?.model;
  }
  if (backend === "codex") {
    return config.backends.codex?.model;
  }
  return config.backends.acpx?.model;
}

function notifyFinishedRuns(runs: UiRun[], ref: React.MutableRefObject<Set<string> | null>): void {
  const finished = new Set(runs.filter((run) => isTerminal(run.status)).map((run) => run.id));
  if (!ref.current) {
    ref.current = finished;
    return;
  }
  for (const run of runs) {
    if (isTerminal(run.status) && !ref.current.has(run.id)) {
      playCompletionSound();
      ref.current.add(run.id);
    }
  }
}

function playCompletionSound(): void {
  try {
    const player = process.platform === "darwin" ? "afplay" : "ffplay";
    const args = process.platform === "darwin"
      ? [COMPLETION_SOUND]
      : ["-nodisp", "-autoexit", "-loglevel", "quiet", COMPLETION_SOUND];
    const child = spawn(player, args, {
      detached: true,
      stdio: "ignore",
    });
    child.on("error", () => process.stdout.write("\u0007"));
    child.unref();
  } catch {
    process.stdout.write("\u0007");
  }
}

function resolveUiRun(runs: UiRun[], runId: string | undefined): UiRun | undefined {
  if (!runId) {
    return undefined;
  }
  return runs.find((run) => run.id === runId || run.id.startsWith(runId));
}

function filterCommands(input: string): CommandOption[] {
  if (!input.startsWith("/")) {
    return [];
  }
  const query = input.slice(1).trim().toLowerCase();
  if (!query) {
    return COMMANDS;
  }
  return COMMANDS.filter((command) => command.name.includes(query) || command.detail.toLowerCase().includes(query));
}

function shouldSelectCommand(input: string, options: CommandOption[]): boolean {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/") || trimmed.includes(" ")) {
    return false;
  }
  const query = trimmed.slice(1);
  return query.length === 0 || !options.some((option) => option.name === query);
}

function isBackend(value: string | undefined): value is BackendId {
  return value === "claude" || value === "codex" || value === "acpx";
}

function isPrintable(value: string): boolean {
  return value.length > 0 && !/[\u0000-\u001f\u007f]/.test(value);
}

function isActive(status: RunStatus): boolean {
  return status === "created" || status === "running" || status === "steering" || status === "verifying";
}

function isTerminal(status: RunStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled" || status === "merged" || status === "merge-conflict";
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
  if (status === "verifying" || status === "steering") {
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

function completionPercent(run: UiRun): number {
  if (run.status === "merged") {
    return 100;
  }
  if (run.status === "completed") {
    return 95;
  }
  if (run.status === "merge-conflict") {
    return 85;
  }
  if (run.status === "failed" || run.status === "cancelled") {
    return 50;
  }
  if (run.status === "steering") {
    return 88;
  }
  if (run.status === "verifying") {
    return 82;
  }
  const labels = new Set(run.work.map((item) => item.label));
  let value = 8;
  if (labels.has("worktree prepared") || labels.has("checkout claimed")) {
    value = 18;
  }
  if (labels.has("planner contract")) {
    value = 28;
  }
  if (labels.has("worker started")) {
    value = 45;
  }
  if (run.output.trim()) {
    value = Math.max(value, 60);
  }
  return value;
}

function progressBar(percent: number): string {
  const width = 6;
  const filled = Math.max(0, Math.min(width, Math.round((percent / 100) * width)));
  return `[${"#".repeat(filled)}${"-".repeat(width - filled)}]`;
}

function canMerge(run: UiRun): boolean {
  return run.status === "completed" && run.worktree.enabled;
}

function runSummary(run: UiRun): string {
  const latestWork = run.work.at(-1);
  if (run.status === "steering") {
    return "auto-steering after completion";
  }
  if (latestWork) {
    return `${latestWork.label}${latestWork.detail ? `: ${latestWork.detail}` : ""}`;
  }
  const latestLine = tailLines(run.output, 1)[0];
  if (latestLine && latestLine !== "No transcript yet.") {
    return latestLine;
  }
  return run.status;
}

function deletePreviousWord(value: string): string {
  return value.replace(/\s+$/, "").replace(/\S+$/, "");
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
