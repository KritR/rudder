import React, { useCallback, useEffect, useState } from "react";
import { Box, Text, render, useInput, useWindowSize } from "ink";
import { currentBranch, findRepoRoot, hasChanges } from "./git.js";
import { startNativeRun, deleteRun, mergeRun, stopRun } from "./run-manager.js";
import { listRuns, loadConfig } from "./state.js";
import {
  loadTmuxDashboardState,
  updateTmuxDashboardState,
  type NativeBackendId,
} from "./tmux-state.js";
import { detachClient, selectPane } from "./tmux.js";
import type { BackendId, RunRecord, RudderConfig } from "./types.js";
import { shortenHome } from "./util.js";

type PaneDefaults = {
  tmuxSessionName: string;
  backend?: BackendId;
  model?: string;
};

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
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | undefined>();
  const [notice, setNotice] = useState("");
  const [deleteIntent, setDeleteIntent] = useState<{ runId: string; canMerge: boolean } | null>(null);

  const refresh = useCallback(async () => {
    const root = findRepoRoot();
    const [nextBranch, nextRuns, state] = await Promise.all([
      currentBranch(root),
      listRuns(root),
      loadTmuxDashboardState(root, defaults.tmuxSessionName),
    ]);
    setRepoRoot(root);
    setBranch(nextBranch);
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
  const maxRuns = Math.max(2, size.rows - 5);
  const visibleRuns = runs.slice(0, maxRuns);

  return (
    <Box flexDirection="column">
      <Text bold>rudder</Text>
      <Text color="gray">{summarize(`${shortenHome(repoRoot)} ${branch}`, width)}</Text>
      <Text>agents <Text color="gray">{runs.length} runs</Text></Text>
      {visibleRuns.length === 0 ? <Text color="gray">No agents yet.</Text> : visibleRuns.map((run) => (
        <Box key={run.id} flexDirection="column">
          <Text color={run.id === selectedRun?.id ? "cyan" : undefined}>
            {run.id === selectedRun?.id ? "> " : "  "}{statusMark(run)} {run.backend} {summarize(run.task, width - 14)}
          </Text>
          <Text color="gray">  {run.terminal?.paneId ? `pane ${run.terminal.paneId}` : run.status}</Text>
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
  const [notice, setNotice] = useState("Type a task. Tab moves focus between panes.");
  const [submitting, setSubmitting] = useState(false);

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
  }, [defaults.backend, defaults.model, defaults.tmuxSessionName]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 1500);
    return () => clearInterval(timer);
  }, [refresh]);

  const submit = useCallback(async () => {
    const task = input.trim();
    if (!task || submitting) {
      return;
    }
    if (task === "/model") {
      setNotice("Use /model <id>. Examples: sonnet, opus, gpt-5.5");
      setInput("");
      return;
    }
    if (task.startsWith("/model ")) {
      const nextModel = task.slice("/model ".length).trim() || undefined;
      setModel(nextModel);
      await updateTmuxDashboardState(repoRoot, defaults.tmuxSessionName, { model: nextModel });
      setInput("");
      setNotice(nextModel ? `model ${nextModel}` : "model default");
      return;
    }
    if (task === "/backend claude" || task === "/backend codex") {
      const nextBackend = task.endsWith("codex") ? "codex" : "claude";
      setBackend(nextBackend);
      setModel(undefined);
      await updateTmuxDashboardState(repoRoot, defaults.tmuxSessionName, { backend: nextBackend, model: undefined });
      setInput("");
      setNotice(`backend ${nextBackend}`);
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
      setInput("");
      setNotice(`started ${shortId(run.id)} in worker pane`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setSubmitting(false);
    }
  }, [backend, defaults.tmuxSessionName, input, model, repoRoot, submitting]);

  useInput((chunk, key) => {
    if (key.ctrl && chunk === "c") {
      void detachClient(defaults.tmuxSessionName);
      return;
    }
    if (key.return) {
      void submit();
      return;
    }
    if (key.backspace || key.delete) {
      setInput((current) => current.slice(0, -1));
      return;
    }
    if ((key.ctrl && chunk === "u") || chunk === "\u0015") {
      setInput("");
      return;
    }
    if ((key.ctrl && chunk === "w") || chunk === "\u0017" || (key.meta && (key.backspace || key.delete))) {
      setInput((current) => current.trimEnd().replace(/\s*\S+$/, ""));
      return;
    }
    if (chunk && !key.ctrl && !key.meta) {
      setInput((current) => current + chunk);
    }
  });

  const configured = model || (backend === "claude" ? config?.backends.claude?.model : config?.backends.codex?.model) || "default";

  return (
    <Box flexDirection="column">
      <Text>
        <Text color="cyan" bold>TASK</Text> {input}<Text color="cyan">_</Text>
        <Text color="gray">  {submitting ? "starting..." : notice}</Text>
      </Text>
      <Text color="gray">Enter start  Tab focus pane  /backend claude|codex  /model &lt;id&gt;  {backend} {configured}</Text>
    </Box>
  );
}

function WorkerIdle({ defaults }: { defaults: PaneDefaults }): React.ReactElement {
  const [repoRoot, setRepoRoot] = useState(() => findRepoRoot());
  const [stateReady, setStateReady] = useState(false);

  useEffect(() => {
    const timer = setInterval(async () => {
      const root = findRepoRoot();
      setRepoRoot(root);
      setStateReady(Boolean(await loadTmuxDashboardState(root, defaults.tmuxSessionName)));
    }, 750);
    return () => clearInterval(timer);
  }, [defaults.tmuxSessionName]);

  return (
    <Box flexDirection="column">
      <Text bold>worker</Text>
      <Text color="gray">{shortenHome(repoRoot)}</Text>
      <Text>{stateReady ? "Start a task in the bottom pane. Claude Code or Codex will run here." : "Preparing Rudder panes..."}</Text>
      <Text color="gray">Tab cycles focus. Once the worker is focused, this pane is the native agent process.</Text>
    </Box>
  );
}

function toNativeBackend(backend: BackendId): NativeBackendId {
  return backend === "codex" ? "codex" : "claude";
}

function statusMark(run: RunRecord): string {
  if (run.status === "merged") return "ok";
  if (run.status === "failed" || run.status === "merge-conflict") return "!!";
  if (run.status === "cancelled") return "--";
  if (run.status === "running") return "tm";
  return "..";
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
