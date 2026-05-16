import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { currentBranch, currentCommit, findRepoRoot } from "./git.js";
import { cloudAuthPath } from "./state.js";
import type { CloudAuthState, CloudSail, JsonValue } from "./types.js";
import {
  ensureDir,
  commandExists,
  expandHome,
  newRunId,
  nowIso,
  pathExists,
  promptText,
  promptSelect,
  promptSecret,
  readJson,
  runCommand,
  shortenHome,
  shellQuote,
  writeJson,
} from "./util.js";

type CloudCommandOptions = {
  json?: boolean;
  homePaths?: string[];
  sshHost?: string;
  noAttach?: boolean;
  quietBanner?: boolean;
};

type LoginStartResponse = {
  loginUrl?: string;
  verificationUri?: string;
  pollUrl?: string;
  deviceCode?: string;
  interval?: number;
  expiresIn?: number;
};

type LoginPollResponse = {
  pending?: boolean;
  token?: string;
  accessToken?: string;
  accountId?: string;
  email?: string;
  expiresAt?: string;
  expiresIn?: number;
};

type SnapshotManifest = {
  version: 1;
  createdAt: string;
  repo: {
    root: string;
    branch: string;
    commit: string;
  };
  homePaths: string[];
  rudderState?: {
    runs: number;
    files: string[];
  };
};

type SnapshotOptions = {
  includeRudderState?: boolean;
};

type CloudClient = {
  baseUrl: string;
  request<T>(pathOrUrl: string, init: { method: string; body?: JsonValue }): Promise<T>;
};

type CloudRuntime = "fly" | "byo-vm";

const DEFAULT_LOGIN_INTERVAL_MS = 2000;
const DEFAULT_LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_CLOUD_URL = "https://rudder-cloud-control.fly.dev";
const GITHUB_CLI_CLIENT_ID = "178c6fc778ccc68e1d6a";
const MAX_HOME_SECRET_SCAN_BYTES = 1024 * 1024;
const DEFAULT_HOME_PATHS = [
  "~/.claude/.credentials.json",
  "~/.claude/settings.json",
  "~/.claude/CLAUDE.md",
  "~/.claude.json",
  "~/.codex/auth.json",
  "~/.codex/config.toml",
  "~/.codex/AGENTS.md",
  "~/.codex/hooks.json",
  "~/.codex/rules",
  "~/.config/gh",
  "~/.gitconfig",
  "~/.npmrc",
  "~/.vercel",
  "~/.config/vercel",
  "~/.config/hunk",
];
const SECRET_PATH_PARTS = new Set([
  ".aws",
  ".ssh",
  ".gnupg",
  ".kube",
  ".docker",
  "keychains",
]);
const BULKY_HOME_PATH_PARTS = new Set([
  "archived_sessions",
  "backups",
  "cache",
  "file-history",
  "log",
  "paste-cache",
  "plugins",
  "projects",
  "session",
  "sessions",
  "shell_snapshots",
  "skills",
  "telemetry",
  "todos",
  "worktrees",
]);
const SECRET_BASENAMES = new Set([
  ".env",
  ".env.local",
  ".env.production",
  ".env.development",
  "id_rsa",
  "id_ed25519",
  "credentials",
  "known_hosts",
]);
const BULKY_HOME_BASENAME_PATTERNS = [
  /^history\./,
  /^logs?_/,
  /^state_\d+\.sqlite/,
  /\.sqlite(?:-(?:wal|shm))?$/,
  /\.log$/,
  /\.jsonl$/,
];

export async function runCloudCommand(command: string, args: string[], options: CloudCommandOptions = {}): Promise<void> {
  const subcommand = args[0] ?? "";
  const rest = args.slice(1);

  if (command === "cloud" && subcommand === "help") {
    printCloudHelp();
    return;
  }

  switch (subcommand) {
    case "login":
      await login(options);
      return;
    case "launch":
      await launch(rest, options, "task");
      return;
    case "sail":
      await launch(rest, options);
      return;
    case "byoc":
      await setupByoc(rest, options);
      return;
    case "vm":
    case "byo-vm":
      await launch(rest, options, "task", "byo-vm");
      return;
    case "list":
    case "ls":
      await listSails(options);
      return;
    case "status":
      await status(options);
      return;
    case "logs":
      await logs(rest, options);
      return;
    case "attach":
      await attach(rest, options);
      return;
    case "workspace":
      await workspaceCommand(rest, options);
      return;
    case "onload":
      await onload(rest, options);
      return;
    case "bootstrap":
      await bootstrap(rest, options);
      return;
    case "pause":
      await mutateSail("pause", rest, options);
      return;
    case "resume":
      await mutateSail("resume", rest, options);
      return;
    case "stop":
      await mutateSail("stop", rest, options);
      return;
    case "setup-github":
      await setupOAuthProvider("github", rest, options);
      return;
    case "setup-google":
      await setupOAuthProvider("google", rest, options);
      return;
    case "setup-byoc":
      await setupByoc(rest, options);
      return;
    case "setup-vm":
      await setupByoc(rest, options);
      return;
    case "setup-fly":
      await configureDefaultRuntime("fly", options);
      return;
    case "setup":
      if (rest[0] === "byoc" || rest[0] === "vm" || rest[0] === "byo-vm") {
        await setupByoc(rest.slice(1), options);
        return;
      }
      if (rest[0] === "fly") {
        await configureDefaultRuntime("fly", options);
        return;
      }
      throw new Error("Usage: rudder cloud setup byoc | rudder cloud setup fly");
    case "runtime":
      await runtime(rest, options);
      return;
    default:
      await launch(command === "sail" ? args : [subcommand, ...rest], options);
      return;
  }
}

async function login(options: CloudCommandOptions): Promise<void> {
  const client = await cloudClient({ requireToken: false });
  const browserLogin = await tryBrowserLogin(client, options).catch((error) => {
    if (!options.json) {
      console.warn(`Browser login unavailable: ${error instanceof Error ? error.message : String(error)}`);
      console.warn("Trying local GitHub auth fallback...");
    }
    return null;
  });
  if (browserLogin?.token || browserLogin?.accessToken) {
    const token = browserLogin.token ?? browserLogin.accessToken;
    if (token) {
      await saveCloudLogin(client, browserLogin, token, options, "browser");
      return;
    }
  }

  const githubLogin = await tryGithubCliLogin(client).catch(() => null);
  if (githubLogin?.token || githubLogin?.accessToken) {
    const token = githubLogin.token ?? githubLogin.accessToken;
    if (token) {
      await saveCloudLogin(client, githubLogin, token, options, "GitHub CLI");
      return;
    }
  }

  const githubDeviceLogin = await tryGithubDeviceLogin(client, options).catch(() => null);
  if (githubDeviceLogin?.token || githubDeviceLogin?.accessToken) {
    const token = githubDeviceLogin.token ?? githubDeviceLogin.accessToken;
    if (token) {
      await saveCloudLogin(client, githubDeviceLogin, token, options, "GitHub device");
      return;
    }
  }
}

async function tryBrowserLogin(client: CloudClient, options: CloudCommandOptions): Promise<LoginPollResponse | null> {
  const response = await client.request<LoginStartResponse>("/api/cli/login", {
    method: "POST",
    body: {
      deviceName: os.hostname(),
      client: "rudder",
    },
  });
  const deviceCode = response.deviceCode;
  const loginUrl = response.loginUrl ?? response.verificationUri ?? withQuery(client.baseUrl, "/cli/login", deviceCode ? { device_code: deviceCode } : {});
  const pollPath = response.pollUrl ?? "/api/cli/login/poll";
  const intervalMs = Math.max(1000, (response.interval ?? DEFAULT_LOGIN_INTERVAL_MS / 1000) * 1000);
  const timeoutMs = Math.max(intervalMs, (response.expiresIn ?? DEFAULT_LOGIN_TIMEOUT_MS / 1000) * 1000);

  console.log(`Opening ${loginUrl}`);
  if (!options.json) {
    openBrowser(loginUrl);
  }
  console.log("Waiting for browser login to complete...");

  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    await sleep(intervalMs);
    const poll = await pollLogin(client, pollPath, deviceCode);
    const token = poll.token ?? poll.accessToken;
    if (token) {
      return poll;
    }
    if (poll.pending === false) {
      throw new Error("Cloud login was not approved.");
    }
  }
  throw new Error("Timed out waiting for cloud login.");
}

async function tryGithubCliLogin(client: CloudClient): Promise<LoginPollResponse | null> {
  if (process.env.RUDDER_SKIP_GH_CLI === "1") {
    return null;
  }
  const gh = await runCommand("gh", ["auth", "token"], { allowFailure: true });
  const token = gh.stdout.trim();
  if (gh.code !== 0 || !token) {
    return null;
  }
  return await client.request<LoginPollResponse>("/api/cli/login/github-token", {
    method: "POST",
    body: { token },
  });
}

async function tryGithubDeviceLogin(client: CloudClient, options: CloudCommandOptions): Promise<LoginPollResponse | null> {
  const start = await githubOAuthRequest<{
    device_code?: string;
    user_code?: string;
    verification_uri?: string;
    verification_uri_complete?: string;
    expires_in?: number;
    interval?: number;
    error?: string;
    error_description?: string;
  }>("https://github.com/login/device/code", {
    client_id: GITHUB_CLI_CLIENT_ID,
    scope: "read:user user:email",
  });
  if (!start.device_code || !start.user_code || !start.verification_uri) {
    return null;
  }
  if (!options.json) {
    const url = start.verification_uri_complete ?? start.verification_uri;
    console.log(`Opening ${url}`);
    console.log(`GitHub code: ${start.user_code}`);
    openBrowser(url);
  }

  const intervalMs = Math.max(1000, (start.interval ?? 5) * 1000);
  const timeoutMs = Math.max(intervalMs, (start.expires_in ?? 900) * 1000);
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    await sleep(intervalMs);
    const poll = await githubOAuthRequest<{
      access_token?: string;
      token_type?: string;
      scope?: string;
      error?: string;
      error_description?: string;
      interval?: number;
    }>("https://github.com/login/oauth/access_token", {
      client_id: GITHUB_CLI_CLIENT_ID,
      device_code: start.device_code,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    });
    if (poll.access_token) {
      return await client.request<LoginPollResponse>("/api/cli/login/github-token", {
        method: "POST",
        body: { token: poll.access_token },
      });
    }
    if (poll.error === "authorization_pending") {
      continue;
    }
    if (poll.error === "slow_down") {
      await sleep(Math.max(intervalMs, (poll.interval ?? 5) * 1000));
      continue;
    }
    return null;
  }
  return null;
}

async function githubOAuthRequest<T>(url: string, body: Record<string, string>): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  const parsed = text ? parseJson(text) : null;
  if (!response.ok) {
    throw new Error(responseErrorMessage(parsed) ?? text.trim() ?? `${response.status} ${response.statusText}`);
  }
  return parsed as T;
}

async function saveCloudLogin(
  client: CloudClient,
  login: LoginPollResponse,
  token: string,
  options: CloudCommandOptions,
  source: string,
): Promise<void> {
  const previous = await loadCloudAuth();
  const previousRuntime = previous?.cloudUrl === client.baseUrl ? parseCloudRuntime(previous.defaultRuntime) : undefined;
  const previousByocHost = previous?.cloudUrl === client.baseUrl ? previous.byocSshHost : undefined;
  await saveCloudAuth({
    version: 1,
    token,
    cloudUrl: client.baseUrl,
    defaultRuntime: previousRuntime,
    byocSshHost: previousByocHost,
    accountId: login.accountId,
    email: login.email,
    expiresAt: login.expiresAt ?? (login.expiresIn ? new Date(Date.now() + login.expiresIn * 1000).toISOString() : undefined),
    updatedAt: nowIso(),
  });
  if (options.json) {
    const result: Record<string, JsonValue> = { ok: true, cloudUrl: client.baseUrl, source };
    if (login.email) {
      result.email = login.email;
    }
    if (login.accountId) {
      result.accountId = login.accountId;
    }
    printJson(result);
  } else {
    console.log(`Logged in to ${client.baseUrl}${login.email ? ` as ${login.email}` : ""} via ${source}.`);
  }
}

async function launch(
  args: string[],
  options: CloudCommandOptions,
  mode: "name" | "task" = "name",
  explicitRuntime?: CloudRuntime,
): Promise<void> {
  const raw = args.join(" ").trim();
  const repoRoot = findRepoRoot();
  const snapshot = await createSnapshot(repoRoot, options.homePaths ?? []);
  try {
    const client = await cloudClient({ requireToken: true });
    const runtime = await selectedCloudRuntime(explicitRuntime);
    const task = mode === "task" || runtime === "byo-vm" ? raw : "";
    const name = task ? cloudNameFromTask(task) : raw || randomCloudName();
    const body: Record<string, JsonValue> = {
      repoName: path.basename(repoRoot),
      name,
      snapshot: {
        name: path.basename(snapshot.archivePath),
        contentType: "application/gzip",
        base64: await fsp.readFile(snapshot.archivePath, "base64"),
        manifest: snapshot.manifest as unknown as JsonValue,
      },
    };
    if (runtime !== "fly") {
      body.runtime = runtime;
    }
    if (task) {
      body.task = task;
    }
    const result = await client.request<JsonValue>("/api/rudder/sail/launch", {
      method: "POST",
      body,
    });
    await printResult(result, options);
    await maybeAutoAttach(result, options);
  } finally {
    await fsp.rm(snapshot.tempDir, { recursive: true, force: true });
  }
}

async function onload(args: string[], options: CloudCommandOptions): Promise<void> {
  const runId = args[0];
  const repoRoot = findRepoRoot();
  const runRecord = runId
    ? await readJson<JsonValue>(path.join(repoRoot, ".rudder", "runs", runId, "run.json"))
    : null;
  const worktreePath = runRecord && typeof runRecord === "object" && !Array.isArray(runRecord)
    ? (runRecord as Record<string, JsonValue>).worktree
    : undefined;
  const sourceRoot = worktreePath && typeof worktreePath === "object" && !Array.isArray(worktreePath)
    ? ((worktreePath as Record<string, JsonValue>).path as string | undefined)
    : undefined;
  const snapshotRoot = sourceRoot && await pathExists(sourceRoot) ? sourceRoot : repoRoot;
  const snapshot = await createSnapshot(snapshotRoot, options.homePaths ?? [], { includeRudderState: !runId });
  try {
    const client = await cloudClient({ requireToken: true });
    const runtime = await selectedCloudRuntime();
    const name = runId ? undefined : `workspace-${path.basename(repoRoot)}`;
    const body: Record<string, JsonValue> = {
      repoName: path.basename(repoRoot),
      run: runRecord ?? null,
      workspace: !runId,
      snapshot: {
        name: path.basename(snapshot.archivePath),
        contentType: "application/gzip",
        base64: await fsp.readFile(snapshot.archivePath, "base64"),
        manifest: snapshot.manifest as unknown as JsonValue,
      },
    };
    if (runId) {
      body.runId = runId;
    } else {
      body.name = name ?? `workspace-${path.basename(repoRoot)}`;
    }
    if (runtime !== "fly") {
      body.runtime = runtime;
    }
    const result = await client.request<JsonValue>("/api/rudder/sail/onload", {
      method: "POST",
      body,
    });
    await printResult(result, options);
    await maybeAutoAttach(result, options);
  } finally {
    await fsp.rm(snapshot.tempDir, { recursive: true, force: true });
  }
}

async function logs(args: string[], options: CloudCommandOptions): Promise<void> {
  const sailId = args[0];
  if (!sailId) {
    throw new Error("Usage: rudder cloud logs <id>");
  }
  const client = await cloudClient({ requireToken: true });
  const result = await client.request<JsonValue>("/api/rudder/sail", { method: "GET" });
  const sails = Array.isArray(result)
    ? result
    : result && typeof result === "object" && !Array.isArray(result) && Array.isArray((result as Record<string, JsonValue>).sails)
      ? (result as Record<string, JsonValue>).sails as JsonValue[]
      : [];
  const match = sails.find((item) =>
    item && typeof item === "object" && !Array.isArray(item) && (item as Record<string, JsonValue>).id === sailId
  );
  if (!match) {
    throw new Error(`Cloud worker not found: ${sailId}`);
  }
  if (options.json) {
    printJson(match);
    return;
  }
  console.log("Cloud log streaming is not available yet.");
  console.log("Worker status:");
  printSailList([match]);
}

async function listSails(options: CloudCommandOptions): Promise<void> {
  const client = await cloudClient({ requireToken: true });
  const result = await client.request<JsonValue>("/api/rudder/sail", { method: "GET" });
  await printResult(result, options);
}

async function status(options: CloudCommandOptions): Promise<void> {
  const client = await cloudClient({ requireToken: true });
  const state = await loadCloudAuth();
  const runtime = await selectedCloudRuntime();
  const sails = await client.request<JsonValue>("/api/rudder/sail", { method: "GET" });
  const sailRows = Array.isArray(sails)
    ? sails
    : sails && typeof sails === "object" && !Array.isArray(sails) && Array.isArray((sails as Record<string, JsonValue>).sails)
      ? (sails as Record<string, JsonValue>).sails as JsonValue[]
      : [];
  const sailCount = sailRows.length;
  const result: Record<string, JsonValue> = {
    ok: true,
    cloudUrl: client.baseUrl,
    runtime,
    sails: sailCount,
  };
  if (state?.cloudUrl === client.baseUrl) {
    if (state.email) {
      result.email = state.email;
    }
    if (state.accountId) {
      result.accountId = state.accountId;
    }
    if (state.byocSshHost) {
      result.byocSshHost = state.byocSshHost;
    }
  }
  if (options.json) {
    printJson(result);
    return;
  }
  console.log(`Logged in to ${client.baseUrl}${state?.email ? ` as ${state.email}` : ""}.`);
  console.log(`Runtime: ${runtime}`);
  if (state?.byocSshHost) {
    console.log(`BYOC SSH host: ${state.byocSshHost}`);
  }
  console.log(`Cloud workers: ${sailCount}`);
}

async function bootstrap(args: string[], options: CloudCommandOptions): Promise<void> {
  const sailId = args[0];
  if (!sailId) {
    throw new Error("Missing sail id. Usage: rudder cloud bootstrap <id>");
  }
  const client = await cloudClient({ requireToken: true });
  const result = await client.request<JsonValue>(`/api/rudder/sail/${encodeURIComponent(sailId)}/bootstrap`, {
    method: "POST",
    body: {},
  });
  await printResult(result, options);
}

async function mutateSail(action: "onload" | "pause" | "resume" | "stop", args: string[], options: CloudCommandOptions): Promise<void> {
  const sailId = args[0];
  if (!sailId) {
    throw new Error(`Missing sail id. Usage: rudder sail ${action} <id>`);
  }
  const client = await cloudClient({ requireToken: true });
  const result = await client.request<JsonValue>(`/api/rudder/sail/${encodeURIComponent(sailId)}/${action}`, {
    method: "POST",
    body: args.length > 1 ? { args: args.slice(1) } : {},
  });
  await printResult(result, options);
}

async function setupOAuthProvider(
  provider: "github" | "google",
  args: string[],
  options: CloudCommandOptions,
): Promise<void> {
  const envPrefix = provider === "github" ? "RUDDER_GITHUB" : "RUDDER_GOOGLE";
  const clientId = args[0]?.trim() || process.env[`${envPrefix}_CLIENT_ID`]?.trim();
  const clientSecret =
    process.env[`${envPrefix}_CLIENT_SECRET`]?.trim() ||
    args[1]?.trim() ||
    await promptSecret(`${provider === "github" ? "GitHub App" : "Google OAuth"} client secret`);
  if (!clientId || !clientSecret) {
    throw new Error([
      `Missing ${provider === "github" ? "GitHub" : "Google"} OAuth credentials.`,
      `Usage: rudder cloud setup-${provider} <client-id>`,
      `Or set ${envPrefix}_CLIENT_ID and ${envPrefix}_CLIENT_SECRET.`,
    ].join("\n"));
  }
  const client = await cloudClient({ requireToken: true });
  const result = await client.request<JsonValue>(`/api/rudder/setup/${provider}`, {
    method: "POST",
    body: {
      clientId,
      clientSecret,
    },
  });
  await printResult(result, options);
}

async function setupByoc(args: string[], options: CloudCommandOptions): Promise<void> {
  const sshConfigPath = path.join(os.homedir(), ".ssh", "config");
  const configuredHosts = await listSshConfigHosts(sshConfigPath);
  const host = (options.sshHost ?? args.join(" ").trim()) || await chooseByocHost(configuredHosts);
  if (!host) {
    throw new Error([
      "Missing BYOC SSH host.",
      "Add your workstation/server to ~/.ssh/config, then run:",
      "",
      "  rudder cloud byoc <ssh-host>",
      "",
      "Example ~/.ssh/config:",
      "  Host rudder-workstation",
      "    HostName 203.0.113.10",
      "    User ubuntu",
      "    IdentityFile ~/.ssh/id_ed25519",
      "",
      configuredHosts.length
        ? `Detected SSH hosts: ${configuredHosts.slice(0, 12).join(", ")}`
        : `No usable hosts found in ${shortenHome(sshConfigPath)}.`,
    ].join("\n"));
  }

  const configMentionsHost = configuredHosts.includes(host) || await sshConfigMentions(sshConfigPath, host);
  const diagnostics = await checkByocHost(host);
  const client = await cloudClient({ requireToken: true });
  const state = await loadCloudAuth();
  if (!state || state.cloudUrl !== client.baseUrl) {
    throw new Error("Not logged in to this Rudder Cloud control plane. Run `rudder login` first.");
  }
  await saveCloudAuth({
    ...state,
    defaultRuntime: state.defaultRuntime === "byo-vm" ? "fly" : state.defaultRuntime,
    byocSshHost: host,
    updatedAt: nowIso(),
  });

  if (options.json) {
    const result: Record<string, JsonValue> = {
      ok: true,
      cloudUrl: client.baseUrl,
      byocSshHost: host,
    };
    const defaultRuntime = state.defaultRuntime === "byo-vm" ? "fly" : state.defaultRuntime;
    if (defaultRuntime) {
      result.defaultRuntime = defaultRuntime;
    }
    printJson(result);
    return;
  }

  console.log(`Rudder BYOC host set to ${host}.`);
  console.log("Plain `rudder cloud` and dashboard `/cloud` continue to use Fly by default.");
  console.log("Use `rudder cloud vm <task>` when you want to run a task on this BYOC host.");

  if (!configMentionsHost) {
    console.log(`\nNote: ${shortenHome(sshConfigPath)} does not appear to define Host ${host}.`);
    console.log("Rudder can still use it if SSH resolves it, but a ~/.ssh/config entry is recommended:");
    console.log(`  Host ${host}`);
    console.log("    HostName <server-ip-or-dns>");
    console.log("    User <user>");
    console.log("    IdentityFile ~/.ssh/<private-key>");
  }
  if (diagnostics.ok) {
    console.log(`SSH check passed for ${host}. Docker is available on the BYOC host.`);
  } else {
    console.log(`\nSSH check did not fully pass for ${host}: ${diagnostics.message}`);
    console.log("Fix SSH/Docker before launching, or run the printed Docker command manually on that host.");
  }
}

async function chooseByocHost(hosts: string[]): Promise<string> {
  if (hosts.length === 0) {
    return await promptText("SSH host from ~/.ssh/config");
  }
  return await promptSelect(
    "Choose a BYOC SSH host from ~/.ssh/config",
    hosts.slice(0, 24).map((host) => ({ value: host, label: host })),
    hosts[0],
  );
}

async function configureDefaultRuntime(runtime: CloudRuntime, options: CloudCommandOptions, byocSshHost?: string): Promise<void> {
  const client = await cloudClient({ requireToken: true });
  const state = await loadCloudAuth();
  if (!state || state.cloudUrl !== client.baseUrl) {
    throw new Error("Not logged in to this Rudder Cloud control plane. Run `rudder login` first.");
  }
  await saveCloudAuth({
    ...state,
    defaultRuntime: runtime,
    byocSshHost: runtime === "byo-vm" ? byocSshHost ?? state.byocSshHost : undefined,
    updatedAt: nowIso(),
  });
  const result: Record<string, JsonValue> = {
    ok: true,
    cloudUrl: client.baseUrl,
    defaultRuntime: runtime,
  };
  const savedByocHost = byocSshHost ?? state.byocSshHost;
  if (runtime === "byo-vm" && savedByocHost) {
    result.byocSshHost = savedByocHost;
  }
  const envRuntime = envCloudRuntime();
  if (envRuntime) {
    result.envOverride = envRuntime;
  }
  if (options.json) {
    printJson(result);
    return;
  }
  console.log(`Rudder Cloud runtime set to ${runtime}.`);
  if (runtime === "byo-vm") {
    const host = byocSshHost ?? state.byocSshHost;
    console.log("Future `rudder cloud <task>` and `/sail <task>` launches will prepare a BYOC worker instead of creating a Fly Machine.");
    console.log(host
      ? `Rudder will try to start the worker over SSH on ${host}.`
      : "Run `rudder cloud byoc <ssh-host>` to let Rudder start workers over SSH.");
  } else {
    console.log("Future `rudder cloud <task>` and `/sail <task>` launches will create Fly Machines.");
  }
  if (envRuntime) {
    console.log(`RUDDER_CLOUD_RUNTIME=${envRuntime} is set and will override this saved default.`);
  }
}

async function runtime(args: string[], options: CloudCommandOptions): Promise<void> {
  const next = args[0] ? parseCloudRuntime(args[0]) : undefined;
  if (args[0] && !next) {
    throw new Error("Runtime must be `fly`, `byoc`, or `byo-vm`.");
  }
  if (next) {
    await configureDefaultRuntime(next, options);
    return;
  }
  const client = await cloudClient({ requireToken: true });
  const current = await selectedCloudRuntime();
  const state = await loadCloudAuth();
  const savedRuntime = parseCloudRuntime(state?.defaultRuntime);
  const result: Record<string, JsonValue> = {
    cloudUrl: client.baseUrl,
    runtime: current,
  };
  const envRuntime = envCloudRuntime();
  if (state?.cloudUrl === client.baseUrl && savedRuntime) {
    result.savedDefaultRuntime = savedRuntime;
  }
  if (state?.cloudUrl === client.baseUrl && state.byocSshHost) {
    result.byocSshHost = state.byocSshHost;
  }
  if (envRuntime) {
    result.envOverride = envRuntime;
  }
  if (options.json) {
    printJson(result);
  } else {
    console.log(`Rudder Cloud runtime: ${current}`);
    if (envRuntime) {
      console.log(`Set by RUDDER_CLOUD_RUNTIME=${envRuntime}.`);
    } else if (state?.cloudUrl === client.baseUrl && savedRuntime) {
      console.log("Set in local Rudder Cloud config.");
    } else {
      console.log("Using default Fly Machines runtime.");
    }
    if (state?.cloudUrl === client.baseUrl && state.byocSshHost) {
      console.log(`BYOC SSH host: ${state.byocSshHost}`);
    }
  }
}

async function sshConfigMentions(configPath: string, host: string): Promise<boolean> {
  const text = await fsp.readFile(configPath, "utf8").catch(() => "");
  if (!text.trim()) {
    return false;
  }
  const target = host.toLowerCase();
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const match = /^Host\s+(.+)$/i.exec(trimmed);
    if (!match) {
      continue;
    }
    const patterns = match[1].split(/\s+/).map((part) => part.toLowerCase());
    if (patterns.includes(target)) {
      return true;
    }
  }
  return false;
}

async function listSshConfigHosts(configPath: string): Promise<string[]> {
  const text = await fsp.readFile(configPath, "utf8").catch(() => "");
  const hosts: string[] = [];
  const seen = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const match = /^Host\s+(.+)$/i.exec(trimmed);
    if (!match) {
      continue;
    }
    for (const host of match[1].split(/\s+/)) {
      if (!host || host.includes("*") || host.includes("?") || host.startsWith("!")) {
        continue;
      }
      if (seen.has(host)) {
        continue;
      }
      seen.add(host);
      hosts.push(host);
    }
  }
  return hosts;
}

async function checkByocHost(host: string): Promise<{ ok: boolean; message: string }> {
  if (!commandExists("ssh")) {
    return { ok: false, message: "ssh is not installed or not on PATH" };
  }
  const result = await runCommand("ssh", [
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=8",
    host,
    "command -v docker >/dev/null && docker info >/dev/null 2>&1",
  ], { allowFailure: true });
  if (result.code === 0) {
    return { ok: true, message: "ok" };
  }
  const detail = (result.stderr || result.stdout || `ssh exited ${result.code}`).trim();
  return { ok: false, message: detail };
}

async function startByocWorkerOverSsh(host: string, bootstrapCommand: string): Promise<void> {
  if (!commandExists("ssh")) {
    throw new Error("ssh is not installed or not on PATH");
  }
  const remoteCommand = [
    "mkdir -p ~/.rudder/byoc",
    `nohup sh -lc ${shellQuote(nonInteractiveDockerCommand(bootstrapCommand))} > ~/.rudder/byoc/worker.log 2>&1 < /dev/null &`,
  ].join(" && ");
  await runCommand("ssh", [
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=10",
    host,
    remoteCommand,
  ]);
}

function nonInteractiveDockerCommand(command: string): string {
  return command
    .replace(/\bdocker run --rm -it\b/g, "docker run --rm")
    .replace(/\bdocker run --rm -i -t\b/g, "docker run --rm")
    .replace(/\bdocker run --rm -t -i\b/g, "docker run --rm");
}

async function cloudClient(options: { requireToken: boolean }): Promise<CloudClient> {
  const baseUrl = normalizeCloudUrl(process.env.RUDDER_CLOUD_URL);
  const state = await loadCloudAuth();
  const envToken = process.env.RUDDER_CLOUD_TOKEN?.trim();
  const token = envToken || (state?.cloudUrl === baseUrl ? state.token : undefined);
  if (options.requireToken && !token) {
    throw new Error("Not logged in to Rudder Cloud. Run `rudder login` first.");
  }
  return {
    baseUrl,
    async request<T>(pathOrUrl: string, init: { method: string; body?: JsonValue }) {
      const url = pathOrUrl.startsWith("http://") || pathOrUrl.startsWith("https://")
        ? pathOrUrl
        : new URL(pathOrUrl, `${baseUrl}/`).toString();
      const headers: Record<string, string> = {
        Accept: "application/json",
      };
      let body: string | undefined;
      if (init.body !== undefined) {
        headers["Content-Type"] = "application/json";
        body = JSON.stringify(init.body);
      }
      if (token) {
        headers.Authorization = `Bearer ${token}`;
      }
      const response = await fetch(url, {
        method: init.method,
        headers,
        body,
      });
      const text = await response.text();
      const parsed = text ? parseJson(text) : null;
      if (!response.ok) {
        const message = responseErrorMessage(parsed) ?? text.trim() ?? `${response.status} ${response.statusText}`;
        throw new Error(`Rudder Cloud request failed: ${message}`);
      }
      return parsed as T;
    },
  };
}

function normalizeCloudUrl(raw: string | undefined): string {
  const value = raw?.trim() || DEFAULT_CLOUD_URL;
  if (!value) {
    throw new Error("RUDDER_CLOUD_URL is not configured. Set it to your Rudder Cloud control plane URL.");
  }
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("bad protocol");
    }
    url.hash = "";
    url.search = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    throw new Error("RUDDER_CLOUD_URL must be a valid http(s) URL.");
  }
}

async function selectedCloudRuntime(explicit?: CloudRuntime): Promise<CloudRuntime> {
  if (explicit) {
    return explicit;
  }
  const envRuntime = envCloudRuntime();
  if (envRuntime) {
    return envRuntime;
  }
  const baseUrl = normalizeCloudUrl(process.env.RUDDER_CLOUD_URL);
  const state = await loadCloudAuth();
  const savedRuntime = parseCloudRuntime(state?.defaultRuntime);
  return state?.cloudUrl === baseUrl && savedRuntime ? savedRuntime : "fly";
}

function parseCloudRuntime(raw: string | undefined): CloudRuntime | undefined {
  const value = raw?.trim().toLowerCase();
  if (!value) {
    return undefined;
  }
  if (value === "fly" || value === "fly-machine" || value === "fly-machines") {
    return "fly";
  }
  if (value === "byo" || value === "byoc" || value === "byo-vm" || value === "manual" || value === "self-hosted" || value === "vm") {
    return "byo-vm";
  }
  return undefined;
}

function envCloudRuntime(): CloudRuntime | undefined {
  const runtime = parseCloudRuntime(process.env.RUDDER_CLOUD_RUNTIME);
  if (process.env.RUDDER_CLOUD_RUNTIME?.trim() && !runtime) {
    throw new Error("RUDDER_CLOUD_RUNTIME must be `fly`, `byoc`, or `byo-vm`.");
  }
  return runtime;
}

async function pollLogin(
  client: CloudClient,
  pollPath: string,
  deviceCode: string | undefined,
): Promise<LoginPollResponse> {
  if (pollPath.startsWith("http://") || pollPath.startsWith("https://") || !deviceCode) {
    return await client.request<LoginPollResponse>(pollPath, { method: "GET" });
  }
  return await client.request<LoginPollResponse>(pollPath, {
    method: "POST",
    body: { deviceCode },
  });
}

async function loadCloudAuth(): Promise<CloudAuthState | null> {
  const state = await readJson<CloudAuthState>(cloudAuthPath());
  return state?.version === 1 && typeof state.token === "string" ? state : null;
}

async function saveCloudAuth(state: CloudAuthState): Promise<void> {
  await writeJson(cloudAuthPath(), state, { mode: 0o600 });
}

async function createSnapshot(repoRoot: string, requestedHomePaths: string[], options: SnapshotOptions = {}): Promise<{
  tempDir: string;
  archivePath: string;
  manifest: SnapshotManifest;
}> {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "rudder-cloud-"));
  const stageDir = path.join(tempDir, "snapshot");
  const repoStage = path.join(stageDir, "repo");
  const homeStage = path.join(stageDir, "home");
  await ensureDir(repoStage);
  await copyRepoFiles(repoRoot, repoStage);
  const rudderState = options.includeRudderState ? await copyRudderState(repoRoot, repoStage) : undefined;

  const homePaths = normalizeHomePaths(requestedHomePaths);
  const includedHomePaths: string[] = [];
  for (const homePath of homePaths) {
    const copied = await copyHomePath(homePath, homeStage);
    if (copied) {
      includedHomePaths.push(shortenHome(homePath));
    }
  }

  const manifest: SnapshotManifest = {
    version: 1,
    createdAt: nowIso(),
    repo: {
      root: path.basename(repoRoot),
      branch: await currentBranch(repoRoot),
      commit: await currentCommit(repoRoot),
    },
    homePaths: includedHomePaths,
    ...(rudderState ? { rudderState } : {}),
  };
  await writeJson(path.join(stageDir, "manifest.json"), manifest);

  const archivePath = path.join(tempDir, `${newRunId("cloud-snapshot")}.tgz`);
  await runCommand("tar", ["-czf", archivePath, "-C", stageDir, "."], { cwd: stageDir });
  return { tempDir, archivePath, manifest };
}

async function copyRudderState(repoRoot: string, repoStage: string): Promise<{ runs: number; files: string[] }> {
  const copied: string[] = [];
  const rudderMd = path.join(repoRoot, "RUDDER.md");
  if (await pathExists(rudderMd)) {
    const target = path.join(repoStage, "RUDDER.md");
    await fsp.cp(rudderMd, target, { force: true });
    copied.push("RUDDER.md");
  }

  const runsDir = path.join(repoRoot, ".rudder", "runs");
  const entries = await fsp.readdir(runsDir, { withFileTypes: true }).catch(() => []);
  let runs = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.includes("/") || entry.name.includes("\\")) {
      continue;
    }
    const runJson = path.join(runsDir, entry.name, "run.json");
    if (!(await pathExists(runJson))) {
      continue;
    }
    const relative = path.join(".rudder", "runs", entry.name, "run.json");
    const target = path.join(repoStage, relative);
    if (!isInside(repoRoot, runJson) || !isInside(repoStage, target)) {
      continue;
    }
    await ensureDir(path.dirname(target));
    await fsp.cp(runJson, target, { force: true });
    copied.push(relative);
    runs += 1;
  }
  return { runs, files: copied };
}

async function copyRepoFiles(repoRoot: string, repoStage: string): Promise<void> {
  const result = await runCommand("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: repoRoot,
    allowFailure: true,
  });
  const files = result.code === 0
    ? result.stdout.split("\0").filter(Boolean)
    : await listFiles(repoRoot);
  for (const relative of files) {
    if (!relative || relative.startsWith(".git/") || relative.startsWith(".rudder/")) {
      continue;
    }
    const source = path.join(repoRoot, relative);
    const target = path.join(repoStage, relative);
    if (!isInside(repoRoot, source) || !isInside(repoStage, target)) {
      continue;
    }
    const stat = await fsp.lstat(source).catch(() => null);
    if (!stat || stat.isDirectory() || !(await shouldIncludeSnapshotPath(source))) {
      continue;
    }
    await ensureDir(path.dirname(target));
    await fsp.cp(source, target, { dereference: false, force: true });
  }
}

async function listFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  async function walk(current: string): Promise<void> {
    const entries = await fsp.readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.name === ".git" || entry.name === ".rudder" || entry.name === "node_modules") {
        continue;
      }
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else {
        files.push(path.relative(dir, full));
      }
    }
  }
  await walk(dir);
  return files;
}

function normalizeHomePaths(requested: string[]): string[] {
  const raw = [
    ...DEFAULT_HOME_PATHS,
    ...requested,
    ...(process.env.RUDDER_CLOUD_HOME_PATHS?.split(",") ?? []),
  ];
  const home = os.homedir();
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const item of raw) {
    const trimmed = item.trim();
    if (!trimmed) {
      continue;
    }
    const resolved = path.resolve(expandHome(trimmed));
    if (!isInside(home, resolved) || seen.has(resolved)) {
      continue;
    }
    seen.add(resolved);
    paths.push(resolved);
  }
  return paths;
}

async function copyHomePath(source: string, homeStage: string): Promise<boolean> {
  if (!(await pathExists(source)) || !(await shouldIncludeSnapshotPath(source))) {
    return false;
  }
  const relative = path.relative(os.homedir(), source);
  const target = path.join(homeStage, relative);
  if (!isInside(homeStage, target)) {
    return false;
  }
  await fsp.cp(source, target, {
    dereference: false,
    recursive: true,
    force: true,
    filter: async (candidate) => await shouldIncludeSnapshotPath(candidate),
  });
  return true;
}

async function shouldIncludeSnapshotPath(candidate: string): Promise<boolean> {
  const normalized = path.resolve(candidate);
  const parts = normalized.split(path.sep).map((part) => part.toLowerCase());
  const basename = path.basename(normalized).toLowerCase();
  if (basename.startsWith("._")) {
    return false;
  }
  if (parts.some((part) => SECRET_PATH_PARTS.has(part)) || SECRET_BASENAMES.has(basename)) {
    return false;
  }
  if (isInside(os.homedir(), normalized)) {
    if (parts.some((part) => BULKY_HOME_PATH_PARTS.has(part))) {
      return false;
    }
    if (BULKY_HOME_BASENAME_PATTERNS.some((pattern) => pattern.test(basename))) {
      return false;
    }
  }
  const stat = await fsp.lstat(normalized).catch(() => null);
  if (!stat || !stat.isFile() || stat.size > MAX_HOME_SECRET_SCAN_BYTES) {
    return true;
  }
  const text = await fsp.readFile(normalized, "utf8").catch(() => "");
  return !/(aws_access_key_id|aws_secret_access_key|aws_session_token|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN)/.test(text);
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function openBrowser(url: string): void {
  const platform = process.platform;
  const command = platform === "darwin" ? "open" : platform === "win32" ? "cmd" : "xdg-open";
  const args = platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore",
  });
  child.on("error", () => undefined);
  child.unref();
}

function withQuery(baseUrl: string, pathname: string, query: Record<string, string>): string {
  const url = new URL(pathname, `${baseUrl}/`);
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

function parseJson(text: string): JsonValue {
  try {
    return JSON.parse(text) as JsonValue;
  } catch {
    return text;
  }
}

function responseErrorMessage(value: JsonValue | null): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, JsonValue>;
  return typeof record.error === "string"
    ? record.error
    : typeof record.message === "string"
      ? record.message
      : undefined;
}

async function printResult(result: JsonValue, options: CloudCommandOptions): Promise<void> {
  if (options.json) {
    printJson(result);
    return;
  }
  if (Array.isArray(result)) {
    printSailList(result);
    return;
  }
  if (result && typeof result === "object" && !Array.isArray(result)) {
    const record = result as Record<string, JsonValue>;
    if (typeof record.bootstrapCommand === "string") {
      const id = typeof record.id === "string" ? record.id : "BYOC sail";
      const status = typeof record.status === "string" ? record.status : undefined;
      const state = await loadCloudAuth();
      const host = options.sshHost ?? state?.byocSshHost;
      console.log(`${id}${status ? ` (${status})` : ""} is ready for BYOC.`);
      if (host && process.env.RUDDER_BYOC_AUTOSTART !== "0") {
        try {
          await startByocWorkerOverSsh(host, record.bootstrapCommand);
          console.log(`Started BYOC worker over SSH on ${host}.`);
          console.log(`Remote log: ssh ${host} 'tail -f ~/.rudder/byoc/worker.log'`);
        } catch (error) {
          console.log(`Could not start BYOC worker over SSH on ${host}: ${error instanceof Error ? error.message : String(error)}`);
          console.log("Run this manually on your workstation/server:");
          console.log(record.bootstrapCommand);
        }
      } else {
        console.log("Run this on your workstation/server:");
        console.log(record.bootstrapCommand);
        if (!host) {
          console.log("\nTip: run `rudder cloud byoc <ssh-host>` to have Rudder start this over SSH next time.");
        }
      }
      if (typeof record.updatedAt === "string") {
        console.log(`\nIf the command expires, run: rudder cloud bootstrap ${id}`);
      }
      return;
    }
    const sails = record.sails ?? record.items;
    if (Array.isArray(sails)) {
      printSailList(sails);
      return;
    }
    if (typeof record.id === "string" && (typeof record.status === "string" || typeof record.runtime === "string")) {
      const parts = [
        record.id,
        typeof record.status === "string" ? record.status : undefined,
        typeof record.runtime === "string" ? record.runtime : undefined,
        typeof record.repoName === "string" ? record.repoName : undefined,
      ].filter(Boolean);
      console.log(parts.join("  "));
      if (record.workspace === true || (record.run === null && typeof record.task !== "string")) {
        console.log("Rudder workspace uploaded. Use /cloud list to track it.");
      } else {
        console.log("Cloud worker created. Use /cloud list to track it.");
      }
      return;
    }
  }
  console.log(JSON.stringify(result, null, 2));
}

function printSailList(items: JsonValue[]): void {
  if (items.length === 0) {
    console.log("No cloud sails.");
    return;
  }
  for (const item of items) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      console.log(String(item));
      continue;
    }
    const sail = item as CloudSail;
    console.log([
      sail.id,
      sail.status,
      sail.runtime,
      typeof sail.task === "string" && sail.task ? sail.task : undefined,
      typeof sail.repoName === "string" && sail.repoName ? sail.repoName : undefined,
      sail.branch,
      sail.url,
      sail.updatedAt ?? sail.createdAt,
    ].filter(Boolean).join("  "));
  }
}

function printJson(value: JsonValue): void {
  console.log(JSON.stringify(value, null, 2));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function workspaceCommand(args: string[], options: CloudCommandOptions): Promise<void> {
  const sub = args[0] ?? "";
  const rest = args.slice(1);
  if (sub === "" || sub === "attach") {
    await workspaceAttach(rest, options);
    return;
  }
  if (sub === "share") {
    await workspaceShare(options);
    return;
  }
  if (sub === "status") {
    await workspaceStatus(options);
    return;
  }
  if (sub === "stop") {
    await workspaceMutate("stop", rest, options);
    return;
  }
  if (sub === "list" || sub === "ls") {
    await workspaceList(options);
    return;
  }
  throw new Error("Usage: rudder cloud workspace [attach [id]|share|status|stop|list]");
}

function computeWorkspaceKey(repoRoot: string): string {
  const normalized = path.resolve(repoRoot);
  return createHash("sha256").update(normalized).digest("hex").slice(0, 32);
}

async function workspaceAttach(args: string[], options: CloudCommandOptions): Promise<void> {
  const explicitId = args[0];
  if (explicitId) {
    await workspaceAttachById(explicitId, options);
    return;
  }
  const repoRoot = findRepoRoot();
  const workspaceKey = computeWorkspaceKey(repoRoot);
  const repoName = path.basename(repoRoot);
  const client = await cloudClient({ requireToken: true });

  if (!options.json) {
    process.stderr.write(`Resolving cloud workspace for ${repoName}...\n`);
  }
  const baseBody: Record<string, JsonValue> = { workspaceKey, repoName };
  let result: JsonValue | null = null;
  try {
    result = await client.request<JsonValue>("/api/rudder/workspace/attach", {
      method: "POST",
      body: baseBody,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/snapshot/i.test(message)) {
      throw error;
    }
    if (!options.json) {
      process.stderr.write(`Uploading workspace snapshot...\n`);
    }
    const snapshot = await createSnapshot(repoRoot, options.homePaths ?? []);
    try {
      const body: Record<string, JsonValue> = {
        ...baseBody,
        snapshot: {
          name: path.basename(snapshot.archivePath),
          contentType: "application/gzip",
          base64: await fsp.readFile(snapshot.archivePath, "base64"),
          manifest: snapshot.manifest as unknown as JsonValue,
        } as JsonValue,
      };
      result = await client.request<JsonValue>("/api/rudder/workspace/attach", {
        method: "POST",
        body,
      });
    } finally {
      await fsp.rm(snapshot.tempDir, { recursive: true, force: true });
    }
  }
  if (!result) {
    throw new Error("Workspace attach returned no result");
  }
  await attachToWorkspaceResult(result, options);
}

async function attachToWorkspaceResult(result: JsonValue, options: CloudCommandOptions): Promise<void> {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new Error("Unexpected workspace response from cloud");
  }
  const record = result as Record<string, JsonValue>;
  const workspaceId = typeof record.id === "string" ? record.id : undefined;
  if (!workspaceId) {
    throw new Error("Workspace response is missing id");
  }
  if (options.json) {
    printJson(record);
    return;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write(`Workspace ${workspaceId} is ready. Run \`rudder cloud workspace attach\` from a TTY to take over.\n`);
    return;
  }
  if (process.env.RUDDER_CLOUD_NO_ATTACH === "1") {
    return;
  }
  await waitForWorkspaceWorker(workspaceId);
  await runAttach({ kind: "workspace", id: workspaceId, label: `workspace ${workspaceId}` }, { ...options, quietBanner: false });
}

async function waitForWorkspaceWorker(workspaceId: string): Promise<void> {
  // Give the Fly machine a moment to boot before the WS attach so users see the dashboard, not a wait-for-worker banner.
  await new Promise((resolve) => setTimeout(resolve, 1500));
  void workspaceId;
}

async function workspaceAttachById(workspaceId: string, options: CloudCommandOptions): Promise<void> {
  if (options.json) {
    printJson({ id: workspaceId, attaching: true });
  } else if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write(`Workspace ${workspaceId}: attach requires a TTY.\n`);
    return;
  }
  if (process.env.RUDDER_CLOUD_NO_ATTACH === "1") {
    return;
  }
  await runAttach(
    { kind: "workspace", id: workspaceId, label: `workspace ${workspaceId}` },
    { ...options, quietBanner: false },
  );
}

async function lookupWorkspaceForRepo(
  options: CloudCommandOptions,
): Promise<Record<string, JsonValue> | null> {
  void options;
  const repoRoot = findRepoRoot();
  const workspaceKey = computeWorkspaceKey(repoRoot);
  const client = await cloudClient({ requireToken: true });
  try {
    const result = await client.request<JsonValue>(
      `/api/rudder/workspace/lookup?key=${encodeURIComponent(workspaceKey)}`,
      { method: "GET" },
    );
    if (result && typeof result === "object" && !Array.isArray(result)) {
      return result as Record<string, JsonValue>;
    }
    return null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/not found/i.test(message) || /404/.test(message)) {
      return null;
    }
    throw error;
  }
}

async function workspaceShare(options: CloudCommandOptions): Promise<void> {
  const workspace = await lookupWorkspaceForRepo(options);
  if (!workspace) {
    if (options.json) {
      printJson({ workspace: null });
      return;
    }
    console.log("No cloud workspace exists for this repo yet. Run `rudder cloud workspace attach` to create one.");
    return;
  }
  const id = typeof workspace.id === "string" ? workspace.id : "";
  if (!id) {
    throw new Error("Workspace lookup returned no id");
  }
  if (options.json) {
    printJson({
      id,
      attachCommand: `rudder cloud workspace attach ${id}`,
      status: workspace.status ?? null,
    });
    return;
  }
  console.log("Share this workspace with a teammate by sending them:");
  console.log("");
  console.log(`  rudder cloud workspace attach ${id}`);
  console.log("");
  console.log("They must already be logged in to Rudder Cloud with their own account (run `rudder cloud login` if not).");
}

async function workspaceStatus(options: CloudCommandOptions): Promise<void> {
  if (process.env.RUDDER_OFFLINE === "1") {
    if (options.json) {
      printJson({ offline: true, workspace: null });
    } else {
      console.log("RUDDER_OFFLINE is set; skipping cloud workspace status check.");
    }
    return;
  }
  const workspace = await lookupWorkspaceForRepo(options).catch((error) => {
    if (!options.json) {
      console.warn(`Could not reach Rudder Cloud: ${error instanceof Error ? error.message : String(error)}`);
    }
    return null;
  });
  if (!workspace) {
    if (options.json) {
      printJson({ workspace: null });
    } else {
      console.log("No cloud workspace for this repo.");
    }
    return;
  }
  const id = typeof workspace.id === "string" ? workspace.id : "";
  const status = typeof workspace.status === "string" ? workspace.status : "unknown";
  const clientCount = typeof workspace.clientCount === "number" ? workspace.clientCount : 0;
  const lastActivityAt = typeof workspace.lastActivityAt === "string" ? workspace.lastActivityAt : undefined;
  const idleMinutes = computeIdleMinutes(lastActivityAt);
  const activeAgents = clientCount > 0 || (idleMinutes !== null && idleMinutes < 5);
  if (options.json) {
    printJson({
      id,
      status,
      clientCount,
      lastActivityAt: lastActivityAt ?? null,
      idleMinutes,
      activeAgents,
      repoName: typeof workspace.repoName === "string" ? workspace.repoName : null,
    });
    return;
  }
  const idlePart = idleMinutes !== null ? `  idle ${idleMinutes}m` : "";
  console.log(`workspace ${id}  ${status}  clients=${clientCount}${idlePart}`);
  if (activeAgents) {
    console.log("Active agents likely running.");
  } else {
    console.log("No recent activity.");
  }
}

function computeIdleMinutes(lastActivityAt: string | undefined): number | null {
  if (!lastActivityAt) {
    return null;
  }
  const ms = Date.parse(lastActivityAt);
  if (!Number.isFinite(ms)) {
    return null;
  }
  const diff = Date.now() - ms;
  if (diff < 0) {
    return 0;
  }
  return Math.floor(diff / 60_000);
}

async function workspaceMutate(action: "stop", args: string[], options: CloudCommandOptions): Promise<void> {
  const id = args[0];
  if (!id) {
    throw new Error(`Usage: rudder cloud workspace ${action} <id>`);
  }
  const client = await cloudClient({ requireToken: true });
  const result = await client.request<JsonValue>(`/api/rudder/workspace/${encodeURIComponent(id)}/${action}`, {
    method: "POST",
    body: {} as JsonValue,
  });
  await printResult(result, options);
}

async function workspaceList(options: CloudCommandOptions): Promise<void> {
  const client = await cloudClient({ requireToken: true });
  const result = await client.request<JsonValue>("/api/rudder/workspace", { method: "GET" });
  await printResult(result, options);
}

async function attach(args: string[], options: CloudCommandOptions): Promise<void> {
  const sailId = args[0];
  if (!sailId) {
    throw new Error("Usage: rudder cloud attach <id>");
  }
  await runAttach({ kind: "sail", id: sailId, label: sailId }, options);
}

type AttachTarget = {
  kind: "sail" | "workspace";
  id: string;
  label: string;
};

type AttachResult = "exited" | "failed";

async function runAttach(target: AttachTarget, options: CloudCommandOptions): Promise<AttachResult> {
  const client = await cloudClient({ requireToken: true });
  const baseUrl = client.baseUrl;
  const state = await loadCloudAuth();
  const envToken = process.env.RUDDER_CLOUD_TOKEN?.trim();
  const token = envToken || (state?.cloudUrl === baseUrl ? state.token : undefined);
  if (!token) {
    throw new Error("Not logged in to Rudder Cloud. Run `rudder login` first.");
  }
  const wsUrl = baseUrl.replace(/^http/, "ws").replace(/\/$/, "")
    + `/api/rudder/${target.kind}/${encodeURIComponent(target.id)}/attach`;

  const stdin = process.stdin;
  const stdout = process.stdout;
  const isInteractive = Boolean(stdin.isTTY && stdout.isTTY);

  return await new Promise<AttachResult>((resolve, reject) => {
    const socket = new WebSocket(wsUrl, {
      headers: { authorization: `Bearer ${token}` },
    });
    socket.binaryType = "nodebuffer";
    let opened = false;
    let cleaned = false;
    let result: AttachResult = "exited";

    const sendResize = () => {
      if (socket.readyState !== WebSocket.OPEN) {
        return;
      }
      const cols = stdout.columns ?? 120;
      const rows = stdout.rows ?? 32;
      socket.send(JSON.stringify({ type: "resize", cols, rows }));
    };

    const onStdin = (chunk: Buffer | string) => {
      if (socket.readyState !== WebSocket.OPEN) {
        return;
      }
      const buffer = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      socket.send(buffer, { binary: true });
    };

    const onResize = () => sendResize();

    const cleanup = () => {
      if (cleaned) {
        return;
      }
      cleaned = true;
      stdin.off("data", onStdin);
      stdout.off("resize", onResize);
      if (isInteractive && stdin.isTTY) {
        try {
          stdin.setRawMode(false);
        } catch {
          // ignore
        }
      }
      stdin.pause();
    };

    socket.on("open", () => {
      opened = true;
      if (!options.json && !options.quietBanner) {
        const tail = isInteractive ? " (Ctrl+C sends to remote; close this pane to detach)" : "";
        process.stderr.write(`Attached to ${target.label}${tail}\n`);
      }
      sendResize();
      if (isInteractive) {
        try {
          stdin.setRawMode(true);
        } catch {
          // ignore
        }
      }
      stdin.resume();
      stdin.on("data", onStdin);
      stdout.on("resize", onResize);
    });

    socket.on("message", (data, isBinary) => {
      if (isBinary && Buffer.isBuffer(data)) {
        stdout.write(data);
        return;
      }
      const text = Buffer.isBuffer(data)
        ? data.toString("utf8")
        : Array.isArray(data)
          ? Buffer.concat(data).toString("utf8")
          : Buffer.from(data as ArrayBuffer).toString("utf8");
      handleControlText(text);
    });

    socket.on("close", (code, reason) => {
      cleanup();
      if (!opened) {
        const reasonText = reason && reason.length ? reason.toString("utf8") : "";
        reject(new Error(`Cloud attach failed (code ${code}${reasonText ? `: ${reasonText}` : ""})`));
        return;
      }
      resolve(result);
    });

    socket.on("error", (err) => {
      if (!opened) {
        cleanup();
        reject(new Error(`Cloud attach failed: ${err.message}`));
      }
    });

    function handleControlText(text: string): void {
      let payload: unknown;
      try {
        payload = JSON.parse(text);
      } catch {
        stdout.write(text);
        return;
      }
      if (!payload || typeof payload !== "object") {
        return;
      }
      const message = payload as { type?: string; state?: string; code?: number };
      if (message.type === "exit") {
        result = message.code === 0 ? "exited" : "failed";
        if (typeof process.exitCode !== "number" && message.code !== undefined) {
          process.exitCode = message.code;
        }
        return;
      }
      if (message.type === "status" && !options.json && !options.quietBanner) {
        if (message.state === "worker-disconnected") {
          process.stderr.write("\nCloud worker disconnected; waiting for reconnect...\n");
        } else if (message.state === "worker-connected") {
          process.stderr.write("Cloud worker connected.\n");
        }
      }
    }
  });
}

async function maybeAutoAttach(result: JsonValue, options: CloudCommandOptions): Promise<void> {
  if (options.json || options.noAttach) {
    return;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return;
  }
  if (process.env.RUDDER_CLOUD_NO_ATTACH === "1") {
    return;
  }
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return;
  }
  const record = result as Record<string, JsonValue>;
  if (typeof record.bootstrapCommand === "string") {
    return;
  }
  const sailId = extractSailId(record);
  if (!sailId) {
    return;
  }
  try {
    await runAttach({ kind: "sail", id: sailId, label: sailId }, { ...options, quietBanner: false });
  } catch (error) {
    console.warn(`Could not attach to ${sailId}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function extractSailId(record: Record<string, JsonValue>): string | undefined {
  if (typeof record.id === "string" && record.id) {
    return record.id;
  }
  return undefined;
}

function printCloudHelp(): void {
  console.log(`rudder cloud

Usage:
  rudder cloud login
  rudder cloud help
  rudder cloud [name or task]
  rudder cloud launch [--home-path <path>] ["task"]
  rudder cloud byoc [ssh-host]
  rudder cloud vm ["task"]
  rudder cloud list
  rudder cloud onload [runId]
      no runId uploads the current Rudder workspace state
  rudder cloud logs <id>
  rudder cloud attach <id>
      stream the live cloud worker terminal into this pane
  rudder cloud workspace [attach [id]|share|status [--json]|stop <id>|list]
      shared cloud workspace for this repo
  rudder cloud bootstrap <id>
  rudder cloud runtime [fly|byoc]
  rudder cloud setup-byoc <ssh-host>   compatibility alias
  rudder cloud setup-fly
  rudder sail [name or task]
  rudder sail list
  rudder sail pause <id>
  rudder sail resume <id>
  rudder cloud setup-github <client-id>
  rudder cloud setup-google <client-id>

Environment:
  RUDDER_CLOUD_URL              Cloud control plane URL (defaults to ${DEFAULT_CLOUD_URL})
  RUDDER_CLOUD_RUNTIME          fly, byoc, or byo-vm (overrides saved local default)
  RUDDER_CLOUD_HOME_PATHS       Extra comma-separated HOME paths to include in snapshots
  RUDDER_GITHUB_CLIENT_ID       GitHub App OAuth client ID for setup-github
  RUDDER_GITHUB_CLIENT_SECRET   GitHub App OAuth client secret for setup-github
  RUDDER_GOOGLE_CLIENT_ID       Google OAuth client ID for setup-google
  RUDDER_GOOGLE_CLIENT_SECRET   Google OAuth client secret for setup-google
`);
}

const CLOUD_ADJECTIVES = [
  "amber",
  "bright",
  "calm",
  "clear",
  "cosmic",
  "gentle",
  "golden",
  "lucky",
  "rapid",
  "silver",
  "steady",
  "swift",
];

const CLOUD_NOUNS = [
  "atlas",
  "harbor",
  "signal",
  "summit",
  "orbit",
  "ranger",
  "river",
  "rocket",
  "sparrow",
  "station",
  "voyager",
  "wave",
];

function randomCloudName(): string {
  const seed = Date.now() + process.pid + Math.floor(Math.random() * 1_000_000);
  return [
    CLOUD_ADJECTIVES[Math.abs(seed) % CLOUD_ADJECTIVES.length],
    CLOUD_NOUNS[Math.abs(Math.floor(seed / CLOUD_ADJECTIVES.length)) % CLOUD_NOUNS.length],
  ].join("-");
}

function cloudNameFromTask(task: string): string {
  const slug = task
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 36)
    .replace(/-+$/g, "");
  return slug || randomCloudName();
}
