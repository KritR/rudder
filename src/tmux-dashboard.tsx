import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Box, Text, render, useApp, useInput, useWindowSize } from "ink";
import { currentBranch, findRepoRoot, hasChanges } from "./git.js";
import { discoverModelOptions, fallbackModelOptions, type ModelOption } from "./models.js";
import {
  deleteRun,
  mergeRun,
  startNativeRun,
  stopRun,
} from "./run-manager.js";
import { listRuns, loadConfig } from "./state.js";
import { detachClient, selectPane } from "./tmux.js";
import type { BackendId, RunRecord, RudderConfig } from "./types.js";
import { shortenHome } from "./util.js";

type DashboardDefaults = {
  tmuxSessionName: string;
  backend?: BackendId;
  model?: string;
};

type DeleteIntent = {
  runId: string;
  canMerge: boolean;
};

const BACKENDS: Array<Exclude<BackendId, "acpx">> = ["claude", "codex"];

export async function runTmuxDashboard(defaults: DashboardDefaults): Promise<void> {
  const instance = render(<TmuxDashboard defaults={defaults} />, {
    exitOnCtrlC: false,
    maxFps: 30,
  });
  await instance.waitUntilExit();
}

function TmuxDashboard({ defaults }: { defaults: DashboardDefaults }): React.ReactElement {
  const app = useApp();
  const size = useWindowSize();
  const [repoRoot, setRepoRoot] = useState(() => findRepoRoot());
  const [branch, setBranch] = useState("HEAD");
  const [config, setConfig] = useState<RudderConfig | null>(null);
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | undefined>();
  const [backend, setBackend] = useState<Exclude<BackendId, "acpx">>(
    toNativeBackend(defaults.backend ?? "claude"),
  );
  const [model, setModel] = useState<string | undefined>(defaults.model);
  const [input, setInput] = useState("");
  const [notice, setNotice] = useState("Type a task and press Enter. New agents open as real terminal panes.");
  const [submitting, setSubmitting] = useState(false);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [modelIndex, setModelIndex] = useState(0);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [deleteIntent, setDeleteIntent] = useState<DeleteIntent | null>(null);
  const [preferencesLoaded, setPreferencesLoaded] = useState(false);

  const refresh = useCallback(async () => {
    const root = findRepoRoot();
    const [nextConfig, nextBranch, nextRuns] = await Promise.all([
      loadConfig(),
      currentBranch(root),
      listRuns(root),
    ]);
    setRepoRoot(root);
    setBranch(nextBranch);
    setConfig(nextConfig);
    setRuns(nextRuns);
    if (!preferencesLoaded) {
      setBackend(toNativeBackend(defaults.backend ?? nextConfig.lastUsedBackend ?? nextConfig.defaultBackend));
      setModel(defaults.model);
      setPreferencesLoaded(true);
    }
    setSelectedRunId((current) => current ?? nextRuns[0]?.id);
  }, [defaults.backend, defaults.model, preferencesLoaded]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 1000);
    return () => clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    let cancelled = false;
    const configuredDefault = modelForBackend(backend, config);
    void discoverModelOptions(backend, configuredDefault)
      .then((options) => {
        if (!cancelled) {
          setModels(options);
          setModelIndex(0);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setModels(fallbackModelOptions(backend, configuredDefault));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [backend, config]);

  const selectedIndex = Math.max(0, runs.findIndex((run) => run.id === selectedRunId));
  const selectedRun = runs[selectedIndex];
  const modelOptions = useMemo(
    () => models.length ? models : fallbackModelOptions(backend, modelForBackend(backend, config)),
    [backend, config, models],
  );

  const submitTask = useCallback(async () => {
    const task = input.trim();
    if (!task || submitting) {
      return;
    }
    if (task === "/model") {
      setInput("");
      setModelMenuOpen(true);
      return;
    }
    if (task.startsWith("/model ")) {
      setModel(task.slice("/model ".length).trim() || undefined);
      setInput("");
      return;
    }
    if (task === "/backend claude" || task === "/backend codex") {
      const next = task.endsWith("codex") ? "codex" : "claude";
      setBackend(next);
      setModel(undefined);
      setInput("");
      setNotice(`Backend ${next}`);
      return;
    }
    setSubmitting(true);
    setNotice(`Starting ${backend}...`);
    try {
      const run = await startNativeRun({
        task,
        backend,
        model,
        tmuxSessionName: defaults.tmuxSessionName,
        focus: true,
        silent: true,
      });
      setInput("");
      setSelectedRunId(run.id);
      setNotice(`Started ${shortId(run.id)} in pane ${run.terminal?.paneId ?? ""}`);
      await refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setSubmitting(false);
    }
  }, [backend, defaults.tmuxSessionName, input, model, refresh, submitting]);

  const focusSelected = useCallback(async () => {
    if (!selectedRun?.terminal?.paneId) {
      setNotice("Selected run has no live terminal pane.");
      return;
    }
    await selectPane(selectedRun.terminal.paneId);
  }, [selectedRun]);

  const mergeSelected = useCallback(async (runOverride?: RunRecord) => {
    const run = runOverride ?? selectedRun;
    if (!run) {
      return;
    }
    try {
      await mergeRun(run.id, false, { silent: true });
      setNotice(`Merged ${shortId(run.id)}`);
      await refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  }, [refresh, selectedRun]);

  const requestDelete = useCallback(async () => {
    if (!selectedRun) {
      return;
    }
    setDeleteIntent({
      runId: selectedRun.id,
      canMerge: selectedRun.worktree.enabled && await hasChanges(selectedRun.worktree.path),
    });
  }, [selectedRun]);

  const deleteSelected = useCallback(async (mergeFirst: boolean) => {
    if (!deleteIntent) {
      return;
    }
    try {
      await deleteRun(deleteIntent.runId, { mergeFirst, force: true, silent: true });
      setDeleteIntent(null);
      setNotice(`Deleted ${shortId(deleteIntent.runId)}`);
      await refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  }, [deleteIntent, refresh]);

  useInput((chunk, key) => {
    if (key.ctrl && chunk === "c") {
      void detachClient(defaults.tmuxSessionName);
      return;
    }
    if (deleteIntent) {
      if (key.escape) {
        setDeleteIntent(null);
        return;
      }
      if (chunk === "m" && deleteIntent.canMerge) {
        void deleteSelected(true);
        return;
      }
      if (chunk === "d") {
        void deleteSelected(false);
        return;
      }
      return;
    }
    if (modelMenuOpen) {
      if (key.escape) {
        setModelMenuOpen(false);
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
        setModel(option?.value);
        setModelMenuOpen(false);
        setNotice(option?.value ? `Model ${option.value}` : "Using CLI default model");
        return;
      }
      return;
    }
    if (key.tab) {
      const next = BACKENDS[(BACKENDS.indexOf(backend) + 1) % BACKENDS.length] ?? "claude";
      setBackend(next);
      setModel(undefined);
      setNotice(`Backend ${next}`);
      return;
    }
    if (key.upArrow || (chunk === "k" && !input)) {
      const next = Math.max(0, selectedIndex - 1);
      setSelectedRunId(runs[next]?.id);
      return;
    }
    if (key.downArrow || (chunk === "j" && !input)) {
      const next = Math.min(runs.length - 1, selectedIndex + 1);
      setSelectedRunId(runs[next]?.id);
      return;
    }
    if (!input && chunk === "o") {
      setModelMenuOpen(true);
      return;
    }
    if (!input && chunk === "f") {
      void focusSelected();
      return;
    }
    if (!input && chunk === "m") {
      void mergeSelected();
      return;
    }
    if (!input && chunk === "d") {
      void requestDelete();
      return;
    }
    if (!input && chunk === "s" && selectedRun) {
      void stopRun(selectedRun.id, { silent: true }).then(refresh);
      return;
    }
    if (!input && chunk === "q") {
      void detachClient(defaults.tmuxSessionName);
      app.exit();
      return;
    }
    if (key.return) {
      if (input.trim()) {
        void submitTask();
      } else {
        void focusSelected();
      }
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
    if (chunk === "/" && !input) {
      setNotice("/model opens model picker. /backend claude|codex switches backend.");
      setInput("/");
      return;
    }
    if (chunk && !key.ctrl && !key.meta) {
      setInput((current) => current + chunk);
    }
  });

  const width = Math.max(80, size.columns);
  const height = Math.max(24, size.rows);
  const leftWidth = Math.max(30, Math.min(42, Math.floor(width * 0.28)));
  const rightWidth = Math.max(42, width - leftWidth - 3);
  const visibleRuns = runs.slice(0, Math.max(1, height - 9));
  const header = summarize(
    `rudder  ${shortenHome(repoRoot)} ${branch}  |  ${backend} ${model || "default"}  |  tmux ${defaults.tmuxSessionName}`,
    width - 4,
  );

  return (
    <Box flexDirection="column" height={height}>
      <Box borderStyle="round" borderColor="cyan" paddingX={1}>
        <Text bold>{header}</Text>
      </Box>
      <Box flexGrow={1}>
        <Box width={leftWidth} borderStyle="round" borderColor="gray" flexDirection="column" paddingX={1}>
          <Text bold>agents <Text color="gray">{runs.length} runs</Text></Text>
          {visibleRuns.length === 0 ? <Text color="gray">No agents yet.</Text> : visibleRuns.map((run) => (
            <Box key={run.id} flexDirection="column">
              <Text color={run.id === selectedRun?.id ? "cyan" : undefined}>
                {run.id === selectedRun?.id ? "> " : "  "}
                {statusMark(run)} {run.backend} {summarize(run.task, leftWidth - 14)}
              </Text>
              <Text color="gray">  {run.terminal?.paneId ? `pane ${run.terminal.paneId}` : run.status}</Text>
            </Box>
          ))}
        </Box>
        <Box width={rightWidth} borderStyle="round" borderColor={selectedRun ? "cyan" : "gray"} flexDirection="column" paddingX={1}>
          {selectedRun ? (
            <>
              <Text bold>{selectedRun.backend} {shortId(selectedRun.id)} <Text color="gray">{selectedRun.status}</Text></Text>
              <Text color="gray">{shortenHome(selectedRun.worktree.path)}</Text>
              <Text>{selectedRun.task}</Text>
              <Box marginTop={1}>
                <Text color="gray">Enter/f focus pane   m merge   d delete   s stop pane</Text>
              </Box>
              <Box marginTop={1}>
                <Text color="gray">The selected worker is a native terminal pane. Focus it to use Claude Code or Codex directly, including slash commands, interrupting, copy/paste, resume, and model-native controls.</Text>
              </Box>
            </>
          ) : (
            <Text color="gray">Start an agent to create a native worker pane.</Text>
          )}
        </Box>
      </Box>
      {deleteIntent ? (
        <Box borderStyle="round" borderColor="red" paddingX={1}>
          <Text>Delete {shortId(deleteIntent.runId)}? </Text>
          {deleteIntent.canMerge ? <Text color="green">m merge then delete  </Text> : null}
          <Text color="red">d delete  </Text>
          <Text color="gray">Esc cancel</Text>
        </Box>
      ) : modelMenuOpen ? (
        <ModelMenu options={modelOptions} selected={modelIndex} backend={backend} />
      ) : null}
      <Box borderStyle="round" borderColor="cyan" paddingX={1}>
        <Text color="cyan" bold>TASK</Text>
        <Text> {input}</Text>
        <Text color="cyan">_</Text>
        <Text color="gray">  {submitting ? "starting..." : notice}</Text>
      </Box>
      <Box>
        <Text color="gray">Enter start/focus  Tab backend  o model  j/k select  m merge  d delete  q detach</Text>
      </Box>
    </Box>
  );
}

function ModelMenu({ options, selected, backend }: { options: ModelOption[]; selected: number; backend: string }): React.ReactElement {
  return (
    <Box borderStyle="round" borderColor="yellow" flexDirection="column" paddingX={1}>
      <Text bold>Pick a {backend} model</Text>
      {options.slice(0, 10).map((option, index) => (
        <Text key={`${option.value ?? "default"}-${index}`} color={index === selected ? "cyan" : undefined}>
          {index === selected ? "> " : "  "}{option.label}{option.detail ? <Text color="gray">  {option.detail}</Text> : null}
        </Text>
      ))}
      <Text color="gray">Enter selects, Esc cancels. Type /model &lt;id&gt; for a custom model.</Text>
    </Box>
  );
}

function modelForBackend(backend: Exclude<BackendId, "acpx">, config: RudderConfig | null): string | undefined {
  return backend === "claude" ? config?.backends.claude?.model : config?.backends.codex?.model;
}

function toNativeBackend(backend: BackendId): Exclude<BackendId, "acpx"> {
  return backend === "codex" ? "codex" : "claude";
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

function statusMark(run: RunRecord): string {
  if (run.status === "merged") return "ok";
  if (run.status === "failed" || run.status === "merge-conflict") return "!!";
  if (run.status === "cancelled") return "--";
  if (run.terminal?.paneId) return "tm";
  return "..";
}
