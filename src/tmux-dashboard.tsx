import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, render, useInput, useWindowSize } from "ink";
import { currentBranch, findRepoRoot, hasChanges } from "./git.js";
import { discoverModelOptions, fallbackModelOptions, type ModelOption } from "./models.js";
import { startNativeRun, deleteRun, mergeRun, stopRun } from "./run-manager.js";
import { listRuns, loadConfig } from "./state.js";
import {
  loadTmuxDashboardState,
  updateTmuxDashboardState,
  type NativeBackendId,
} from "./tmux-state.js";
import { detachClient, resizePane, selectPane } from "./tmux.js";
import type { BackendId, RunRecord, RudderConfig } from "./types.js";
import { shortenHome } from "./util.js";

type PaneDefaults = {
  tmuxSessionName: string;
  backend?: BackendId;
  model?: string;
};

type SlashCommand = {
  label: string;
  detail: string;
  value: string;
  complete?: string;
};

const SLASH_COMMANDS: SlashCommand[] = [
  { label: "/backend claude", detail: "use Claude Code for new tasks", value: "/backend claude" },
  { label: "/backend codex", detail: "use Codex for new tasks", value: "/backend codex" },
  { label: "/model", detail: "pick from available models", value: "/model" },
  { label: "/model <id>", detail: "set model for new tasks", value: "/model ", complete: "/model " },
  { label: "/clear", detail: "clear the task input", value: "/clear" },
  { label: "/help", detail: "show available task commands", value: "/help" },
  { label: "/detach", detail: "detach the tmux session", value: "/detach" },
];

export async function runTmuxAgentPane(defaults: PaneDefaults): Promise<void> {
  const instance = render(<AgentPane defaults={defaults} />, {
    exitOnCtrlC: false,
    maxFps: 20,
  });
  await instance.waitUntilExit();
}

export async function runTmuxTaskPane(defaults: PaneDefaults): Promise<void> {
  const instance = render(<TaskPane defaults={defaults} />, {
    exitOnCtrlC: false,
    maxFps: 30,
  });
  await instance.waitUntilExit();
}

export async function runTmuxWorkerIdle(defaults: PaneDefaults): Promise<void> {
  const instance = render(<WorkerIdle defaults={defaults} />, {
    exitOnCtrlC: false,
    maxFps: 10,
  });
  await instance.waitUntilExit();
}

function AgentPane({ defaults }: { defaults: PaneDefaults }): React.ReactElement {
  const size = useWindowSize();
  const [repoRoot, setRepoRoot] = useState(() => findRepoRoot());
  const [branch, setBranch] = useState("HEAD");
  const [config, setConfig] = useState<RudderConfig | null>(null);
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | undefined>();
  const [notice, setNotice] = useState("");
  const [deleteIntent, setDeleteIntent] = useState<{ runId: string; canMerge: boolean } | null>(null);

  const refresh = useCallback(async () => {
    const root = findRepoRoot();
    const [nextBranch, nextConfig, nextRuns, state] = await Promise.all([
      currentBranch(root),
      loadConfig(),
      listRuns(root),
      loadTmuxDashboardState(root, defaults.tmuxSessionName),
    ]);
    setRepoRoot(root);
    setBranch(nextBranch);
    setConfig(nextConfig);
    setRuns(nextRuns);
    setSelectedRunId((current) => state?.selectedRunId ?? current ?? nextRuns[0]?.id);
  }, [defaults.tmuxSessionName]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 1000);
    return () => clearInterval(timer);
  }, [refresh]);

  const selectedIndex = Math.max(0, runs.findIndex((run) => run.id === selectedRunId));
  const selectedRun = runs[selectedIndex];

  const selectRun = useCallback(async (run: RunRecord | undefined) => {
    if (!run) {
      return;
    }
    setSelectedRunId(run.id);
    await updateTmuxDashboardState(repoRoot, defaults.tmuxSessionName, { selectedRunId: run.id });
  }, [defaults.tmuxSessionName, repoRoot]);

  useInput((chunk, key) => {
    if (key.ctrl && chunk === "c") {
      void detachClient(defaults.tmuxSessionName);
      return;
    }
    if (deleteIntent) {
      if (key.escape) {
        setDeleteIntent(null);
        setNotice("");
        return;
      }
      if (chunk === "m" && deleteIntent.canMerge) {
        void deleteRun(deleteIntent.runId, { mergeFirst: true, force: true, silent: true })
          .then(() => {
            setDeleteIntent(null);
            setNotice(`deleted ${shortId(deleteIntent.runId)}`);
            return refresh();
          })
          .catch((error) => setNotice(error instanceof Error ? error.message : String(error)));
        return;
      }
      if (chunk === "d") {
        void deleteRun(deleteIntent.runId, { force: true, silent: true })
          .then(() => {
            setDeleteIntent(null);
            setNotice(`deleted ${shortId(deleteIntent.runId)}`);
            return refresh();
          })
          .catch((error) => setNotice(error instanceof Error ? error.message : String(error)));
        return;
      }
      return;
    }
    if (key.upArrow || chunk === "k") {
      void selectRun(runs[Math.max(0, selectedIndex - 1)]);
      return;
    }
    if (key.downArrow || chunk === "j") {
      void selectRun(runs[Math.min(runs.length - 1, selectedIndex + 1)]);
      return;
    }
    if (key.return || chunk === "f") {
      if (selectedRun?.terminal?.paneId) {
        void selectPane(selectedRun.terminal.paneId);
      }
      return;
    }
    if (chunk === "m" && selectedRun) {
      void mergeRun(selectedRun.id, false, { silent: true })
        .then(() => setNotice(`merged ${shortId(selectedRun.id)}`))
        .catch((error) => setNotice(error instanceof Error ? error.message : String(error)));
      return;
    }
    if (chunk === "s" && selectedRun) {
      void stopRun(selectedRun.id, { silent: true }).then(refresh);
      return;
    }
    if (chunk === "d" && selectedRun) {
      void hasChanges(selectedRun.worktree.path)
        .then((canMerge) => {
          setDeleteIntent({ runId: selectedRun.id, canMerge: selectedRun.worktree.enabled && canMerge });
          setNotice(selectedRun.worktree.enabled && canMerge
            ? "delete? press m to merge then delete, d to delete, Esc cancel"
            : "delete? press d to delete, Esc cancel");
        })
        .catch((error) => setNotice(error instanceof Error ? error.message : String(error)));
      return;
    }
    if (chunk === "q") {
      void detachClient(defaults.tmuxSessionName);
    }
  });

  const width = Math.max(24, size.columns);
  const maxRuns = Math.max(1, Math.floor((size.rows - 5) / 3));
  const visibleRuns = runs.slice(0, maxRuns);

  return (
    <Box flexDirection="column">
      <Text bold>rudder</Text>
      <Text color="gray">{summarize(`${shortenHome(repoRoot)} ${branch}`, width)}</Text>
      <Text>agents <Text color="gray">{runs.length} runs</Text></Text>
      {visibleRuns.length === 0 ? <Text color="gray">No agents yet.</Text> : visibleRuns.map((run) => (
        <Box key={run.id} flexDirection="column">
          <Text color={run.id === selectedRun?.id ? "cyan" : taskColor(run)}>
            {run.id === selectedRun?.id ? "> " : "  "}{summarize(run.task, width - 3)}
          </Text>
          <Text>
            <Text color={statusColor(run)}>  {statusMark(run)}</Text>
            <Text color="gray">  {run.backend} </Text>
            <Text color="magenta">{modelLabel(run, config)}</Text>
          </Text>
        </Box>
      ))}
      {notice ? <Text color={deleteIntent ? "red" : "yellow"}>{summarize(notice, width)}</Text> : null}
      <Text color="gray">j/k select  Enter focus  m merge  d delete</Text>
    </Box>
  );
}

function TaskPane({ defaults }: { defaults: PaneDefaults }): React.ReactElement {
  const [repoRoot, setRepoRoot] = useState(() => findRepoRoot());
  const [config, setConfig] = useState<RudderConfig | null>(null);
  const [backend, setBackend] = useState<NativeBackendId>(toNativeBackend(defaults.backend ?? "claude"));
  const [model, setModel] = useState<string | undefined>(defaults.model);
  const [input, setInput] = useState("");
  const inputRef = useRef("");
  const [notice, setNotice] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [commandIndex, setCommandIndex] = useState(0);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [modelIndex, setModelIndex] = useState(0);
  const [claudeModels, setClaudeModels] = useState<ModelOption[]>([]);
  const [codexModels, setCodexModels] = useState<ModelOption[]>([]);
  const [taskPaneId, setTaskPaneId] = useState<string | undefined>();

  const refresh = useCallback(async () => {
    const root = findRepoRoot();
    const [nextConfig, state] = await Promise.all([
      loadConfig(),
      loadTmuxDashboardState(root, defaults.tmuxSessionName),
    ]);
    setRepoRoot(root);
    setConfig(nextConfig);
    setBackend(state?.backend ?? toNativeBackend(defaults.backend ?? nextConfig.lastUsedBackend ?? nextConfig.defaultBackend));
    setModel(state?.model ?? defaults.model);
    setTaskPaneId(state?.taskPaneId);
  }, [defaults.backend, defaults.model, defaults.tmuxSessionName]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 1500);
    return () => clearInterval(timer);
  }, [refresh]);

  const commandOptions = useMemo(() => filterSlashCommands(input), [input]);
  const commandMenuOpen = !modelPickerOpen && input.startsWith("/") && !isExactRunnableCommand(input) && commandOptions.length > 0;
  const claudeDefault = config?.backends.claude?.model;
  const codexDefault = config?.backends.codex?.model;
  const modelOptions = useMemo(
    () => {
      const primary = backend === "claude"
        ? withBackend(claudeModels.length ? claudeModels : fallbackModelOptions("claude", claudeDefault), "claude")
        : withBackend(codexModels.length ? codexModels : fallbackModelOptions("codex", codexDefault), "codex");
      const secondary = backend === "claude"
        ? withBackend(codexModels.length ? codexModels : fallbackModelOptions("codex", codexDefault), "codex")
        : withBackend(claudeModels.length ? claudeModels : fallbackModelOptions("claude", claudeDefault), "claude");
      return [...primary, ...secondary];
    },
    [backend, claudeDefault, claudeModels, codexDefault, codexModels],
  );

  const setTaskInput = useCallback((next: string | ((current: string) => string)) => {
    const value = typeof next === "function" ? next(inputRef.current) : next;
    inputRef.current = value;
    setInput(value);
  }, []);

  useEffect(() => {
    setCommandIndex(0);
  }, [input]);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      discoverModelOptions("claude", claudeDefault).catch(() => fallbackModelOptions("claude", claudeDefault)),
      discoverModelOptions("codex", codexDefault).catch(() => fallbackModelOptions("codex", codexDefault)),
    ]).then(([nextClaudeModels, nextCodexModels]) => {
        if (!cancelled) {
          setClaudeModels(nextClaudeModels);
          setCodexModels(nextCodexModels);
          setModelIndex(0);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [claudeDefault, codexDefault]);

  useEffect(() => {
    if (!taskPaneId) {
      return;
    }
    void resizePane(taskPaneId, modelPickerOpen ? 10 : 3);
  }, [modelPickerOpen, taskPaneId]);

  const submit = useCallback(async (override?: string) => {
    const task = (override ?? inputRef.current).trim();
    if (!task || submitting) {
      return;
    }
    const resolvedCommand = resolveSlashCommand(task);
    if (resolvedCommand && resolvedCommand.value !== task && !resolvedCommand.complete) {
      await submit(resolvedCommand.value);
      return;
    }
    if (task === "/model") {
      setTaskInput("");
      setNotice("");
      setModelPickerOpen(true);
      setModelIndex(0);
      return;
    }
    if (task.startsWith("/model ")) {
      const nextModel = task.slice("/model ".length).trim() || undefined;
      setModel(nextModel);
      await updateTmuxDashboardState(repoRoot, defaults.tmuxSessionName, { model: nextModel });
      setTaskInput("");
      setNotice("");
      return;
    }
    if (task === "/backend claude" || task === "/backend codex") {
      const nextBackend = task.endsWith("codex") ? "codex" : "claude";
      setBackend(nextBackend);
      setModel(undefined);
      await updateTmuxDashboardState(repoRoot, defaults.tmuxSessionName, { backend: nextBackend, model: undefined });
      setTaskInput("");
      setNotice("");
      setModelPickerOpen(false);
      return;
    }
    if (task === "/clear") {
      setTaskInput("");
      setNotice("");
      return;
    }
    if (task === "/help") {
      setTaskInput("");
      setNotice("/backend claude|codex, /model, /model <id>, /clear, /detach");
      return;
    }
    if (task === "/detach") {
      await detachClient(defaults.tmuxSessionName);
      return;
    }
    if (task.startsWith("/")) {
      setNotice("Unknown command. Type / to see commands.");
      return;
    }
    const state = await loadTmuxDashboardState(repoRoot, defaults.tmuxSessionName);
    if (!state) {
      setNotice("Rudder tmux state is missing. Reopen rudder.");
      return;
    }
    setSubmitting(true);
    try {
      const run = await startNativeRun({
        task,
        backend,
        model,
        tmuxSessionName: defaults.tmuxSessionName,
        workerPaneId: state.workerPaneId,
        focus: true,
        silent: true,
      });
      await updateTmuxDashboardState(repoRoot, defaults.tmuxSessionName, { selectedRunId: run.id, backend, model });
      setTaskInput("");
      setNotice("");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setSubmitting(false);
    }
  }, [backend, defaults.tmuxSessionName, model, repoRoot, setTaskInput, submitting]);

  useInput((chunk, key) => {
    if (key.ctrl && chunk === "c") {
      void detachClient(defaults.tmuxSessionName);
      return;
    }
    if (modelPickerOpen) {
      if (key.escape) {
        setModelPickerOpen(false);
        setNotice("");
        return;
      }
      if (key.upArrow || chunk === "k") {
        setModelIndex((current) => Math.max(0, current - 1));
        return;
      }
      if (key.downArrow || chunk === "j") {
        setModelIndex((current) => Math.min(modelOptions.length - 1, current + 1));
        return;
      }
      if (key.return) {
        const option = modelOptions[modelIndex];
        const nextBackend = toNativeBackend(option?.backend ?? backend);
        const nextModel = option?.value;
        setBackend(nextBackend);
        setModel(nextModel);
        void updateTmuxDashboardState(repoRoot, defaults.tmuxSessionName, { backend: nextBackend, model: nextModel });
        setModelPickerOpen(false);
        setTaskInput("");
        setNotice("");
        return;
      }
      return;
    }
    const returnIndex = chunk.search(/[\r\n]/);
    if (returnIndex >= 0 && !key.ctrl && !key.meta) {
      const beforeReturn = stripControlInput(chunk.slice(0, returnIndex));
      if (beforeReturn) {
        setTaskInput((current) => current + beforeReturn);
      }
      void submit();
      return;
    }
    if (isLineClear(chunk, key)) {
      setTaskInput("");
      setNotice("");
      return;
    }
    if (isWordDelete(chunk, key)) {
      setTaskInput((current) => deletePreviousWord(current));
      return;
    }
    if (commandMenuOpen) {
      if (key.upArrow || chunk === "k") {
        setCommandIndex((current) => Math.max(0, current - 1));
        return;
      }
      if (key.downArrow || chunk === "j") {
        setCommandIndex((current) => Math.min(commandOptions.length - 1, current + 1));
        return;
      }
      if (key.escape) {
        setTaskInput("");
        setNotice("");
        return;
      }
    }
    if (key.return) {
      if (commandMenuOpen) {
        const command = commandOptions[commandIndex];
        if (command?.complete) {
          setTaskInput(command.complete);
          setNotice("");
          return;
        }
        if (command) {
          void submit(command.value);
          return;
        }
      }
      void submit();
      return;
    }
    if (key.backspace || key.delete || chunk === "\u007f" || chunk === "\b") {
      setTaskInput((current) => current.slice(0, -1));
      return;
    }
    if (chunk && !key.ctrl && !key.meta) {
      setTaskInput((current) => current + chunk);
    }
  });

  const configured = model || (backend === "claude" ? config?.backends.claude?.model : config?.backends.codex?.model) || "default";

  return (
    <Box flexDirection="column">
      <Text>
        <Text color="cyan" bold>TASK</Text> {input}<Text color="cyan">_</Text>
        {submitting ? <Text color="gray">  starting...</Text> : null}
        {!submitting && notice ? <Text color="yellow">  {notice}</Text> : null}
      </Text>
      {commandMenuOpen ? (
        <CommandMenu commands={commandOptions} selected={commandIndex} />
      ) : modelPickerOpen ? (
        <ModelMenu options={modelOptions} selected={modelIndex} backend={backend} />
      ) : (
        <Text color="gray">Enter start  Tab focus pane  / commands  {backend} {configured}</Text>
      )}
    </Box>
  );
}

function CommandMenu({ commands, selected }: { commands: SlashCommand[]; selected: number }): React.ReactElement {
  const command = commands[Math.max(0, Math.min(selected, commands.length - 1))];
  return <Text color="cyan">{command ? `> ${command.label}  ${command.detail}` : "No command"}</Text>;
}

function ModelMenu({ options, selected, backend }: { options: ModelOption[]; selected: number; backend: NativeBackendId }): React.ReactElement {
  const start = Math.max(0, Math.min(selected - 2, Math.max(0, options.length - 7)));
  const visible = options.slice(start, start + 7);
  return (
    <Box flexDirection="column">
      <Text color="gray">Pick a model. Claude and Codex are both listed.</Text>
      {visible.map((option, index) => {
        const absoluteIndex = start + index;
        const optionBackend = toNativeBackend(option.backend ?? backend);
        return (
          <Text key={`${optionBackend}-${option.value ?? "default"}-${absoluteIndex}`} color={absoluteIndex === selected ? "cyan" : "gray"}>
            {absoluteIndex === selected ? "> " : "  "}
            <Text color={optionBackend === "claude" ? "cyan" : "green"}>{optionBackend}</Text>
            {"  "}{option.label}{option.detail ? `  ${option.detail}` : ""}
          </Text>
        );
      })}
    </Box>
  );
}

function WorkerIdle(_props: { defaults: PaneDefaults }): React.ReactElement {
  return <Box />;
}

function toNativeBackend(backend: BackendId): NativeBackendId {
  return backend === "codex" ? "codex" : "claude";
}

function statusMark(run: RunRecord): string {
  if (run.status === "merged") return "merged";
  if (run.status === "completed") return "done";
  if (run.status === "failed" || run.status === "merge-conflict") return "failed";
  if (run.status === "cancelled") return "stopped";
  if (run.status === "running" || run.status === "steering" || run.status === "verifying") return "running";
  return "queued";
}

function statusColor(run: RunRecord): string {
  if (run.status === "merged" || run.status === "completed") return "green";
  if (run.status === "failed" || run.status === "merge-conflict") return "red";
  if (run.status === "cancelled") return "yellow";
  if (run.status === "running" || run.status === "steering" || run.status === "verifying") return "yellow";
  return "gray";
}

function taskColor(run: RunRecord): string | undefined {
  if (run.status === "merged" || run.status === "completed") return "green";
  if (run.status === "running" || run.status === "steering" || run.status === "verifying") return "yellow";
  if (run.status === "failed" || run.status === "merge-conflict") return "red";
  return undefined;
}

function modelLabel(run: RunRecord, config: RudderConfig | null): string {
  const model = run.model
    ?? (run.backend === "claude"
      ? config?.backends.claude?.model
      : config?.backends.codex?.model)
    ?? "default";
  return summarize(model, 18);
}

function modelForBackend(backend: NativeBackendId, config: RudderConfig | null): string | undefined {
  return backend === "claude" ? config?.backends.claude?.model : config?.backends.codex?.model;
}

function withBackend(options: ModelOption[], backend: NativeBackendId): ModelOption[] {
  return options.map((option) => ({ ...option, backend }));
}

function filterSlashCommands(input: string): SlashCommand[] {
  if (!input.startsWith("/")) {
    return [];
  }
  const query = input.toLowerCase();
  const matches = SLASH_COMMANDS.filter((command) => command.label.toLowerCase().startsWith(query));
  return matches.length ? matches : SLASH_COMMANDS.filter((command) => command.label.toLowerCase().includes(query.slice(1)));
}

function isExactRunnableCommand(input: string): boolean {
  const trimmed = input.trim();
  return SLASH_COMMANDS.some((command) => !command.complete && command.value === trimmed);
}

function resolveSlashCommand(input: string): SlashCommand | undefined {
  if (!input.startsWith("/") || input.startsWith("/model ")) {
    return undefined;
  }
  if (isExactRunnableCommand(input)) {
    return undefined;
  }
  return filterSlashCommands(input)[0];
}

function isLineClear(chunk: string, key: { ctrl?: boolean; meta?: boolean; backspace?: boolean; delete?: boolean }): boolean {
  return (key.ctrl && chunk === "u") || chunk === "\u0015" || chunk === "\u001b\u0015";
}

function isWordDelete(chunk: string, key: { ctrl?: boolean; meta?: boolean; backspace?: boolean; delete?: boolean }): boolean {
  return Boolean(
    (key.ctrl && chunk === "w") ||
    chunk === "\u0017" ||
    chunk === "\u001b\u007f" ||
    chunk === "\u001b\b" ||
    (key.meta && (key.backspace || key.delete || chunk === "\u007f" || chunk === "\b"))
  );
}

function deletePreviousWord(value: string): string {
  return value.trimEnd().replace(/\s*\S+$/, "");
}

function stripControlInput(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}

function shortId(id: string): string {
  return id.slice(0, 14);
}

function summarize(value: string, width: number): string {
  const clean = value.replace(/\s+/g, " ").trim();
  if (clean.length <= width) {
    return clean;
  }
  return `${clean.slice(0, Math.max(0, width - 1))}…`;
}
