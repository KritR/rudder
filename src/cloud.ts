import { spawn } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { currentBranch, currentCommit, findRepoRoot } from "./git.js";
import { cloudAuthPath } from "./state.js";
import type { CloudAuthState, CloudSail, JsonValue } from "./types.js";
import {
  ensureDir,
  expandHome,
  newRunId,
  nowIso,
  pathExists,
  readJson,
  runCommand,
  shortenHome,
  writeJson,
} from "./util.js";

type CloudCommandOptions = {
  json?: boolean;
  homePaths?: string[];
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
};

type CloudClient = {
  baseUrl: string;
  request<T>(pathOrUrl: string, init: { method: string; body?: JsonValue }): Promise<T>;
};

const DEFAULT_LOGIN_INTERVAL_MS = 2000;
const DEFAULT_LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_CLOUD_URL = "https://mpd2pmnpep.us-east-1.awsapprunner.com";
const MAX_HOME_SECRET_SCAN_BYTES = 1024 * 1024;
const DEFAULT_HOME_PATHS = [
  "~/.claude",
  "~/.codex",
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

export async function runCloudCommand(command: string, args: string[], options: CloudCommandOptions = {}): Promise<void> {
  const subcommand = args[0] ?? (command === "sail" ? "list" : "");
  const rest = args.slice(1);

  if (command === "cloud" && (!subcommand || subcommand === "help")) {
    printCloudHelp();
    return;
  }

  switch (subcommand) {
    case "login":
      await login(options);
      return;
    case "sail":
    case "launch":
      await launch(rest, options);
      return;
    case "list":
    case "ls":
      await listSails(options);
      return;
    case "onload":
      await onload(rest, options);
      return;
    case "pause":
      await mutateSail("pause", rest, options);
      return;
    case "resume":
      await mutateSail("resume", rest, options);
      return;
    default:
      await launch(command === "sail" ? args : [subcommand, ...rest], options);
      return;
  }
}

async function login(options: CloudCommandOptions): Promise<void> {
  const client = await cloudClient({ requireToken: false });
  const githubLogin = await tryGithubCliLogin(client).catch(() => null);
  if (githubLogin?.token || githubLogin?.accessToken) {
    const token = githubLogin.token ?? githubLogin.accessToken;
    if (token) {
      await saveCloudLogin(client, githubLogin, token, options, "GitHub CLI");
      return;
    }
  }

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
  openBrowser(loginUrl);
  console.log("Waiting for browser login to complete...");

  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    await sleep(intervalMs);
    const poll = await pollLogin(client, pollPath, deviceCode);
    const token = poll.token ?? poll.accessToken;
    if (token) {
      await saveCloudLogin(client, poll, token, options, "browser");
      return;
    }
    if (poll.pending === false) {
      throw new Error("Cloud login was not approved.");
    }
  }
  throw new Error("Timed out waiting for cloud login.");
}

async function tryGithubCliLogin(client: CloudClient): Promise<LoginPollResponse | null> {
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

async function saveCloudLogin(
  client: CloudClient,
  login: LoginPollResponse,
  token: string,
  options: CloudCommandOptions,
  source: string,
): Promise<void> {
  await saveCloudAuth({
    version: 1,
    token,
    cloudUrl: client.baseUrl,
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

async function launch(args: string[], options: CloudCommandOptions): Promise<void> {
  const task = args.join(" ").trim();
  const repoRoot = findRepoRoot();
  const snapshot = await createSnapshot(repoRoot, options.homePaths ?? []);
  try {
    const client = await cloudClient({ requireToken: true });
    const body: Record<string, JsonValue> = {
      repoName: path.basename(repoRoot),
      snapshot: {
        name: path.basename(snapshot.archivePath),
        contentType: "application/gzip",
        base64: await fsp.readFile(snapshot.archivePath, "base64"),
        manifest: snapshot.manifest as unknown as JsonValue,
      },
    };
    if (task) {
      body.task = task;
    }
    const result = await client.request<JsonValue>("/api/rudder/sail/launch", {
      method: "POST",
      body,
    });
    printResult(result, options);
  } finally {
    await fsp.rm(snapshot.tempDir, { recursive: true, force: true });
  }
}

async function onload(args: string[], options: CloudCommandOptions): Promise<void> {
  const runId = args[0];
  if (!runId) {
    throw new Error("Missing run id. Usage: rudder cloud onload <runId>");
  }
  const repoRoot = findRepoRoot();
  const runRecord = await readJson<JsonValue>(path.join(repoRoot, ".rudder", "runs", runId, "run.json"));
  const worktreePath = runRecord && typeof runRecord === "object" && !Array.isArray(runRecord)
    ? (runRecord as Record<string, JsonValue>).worktree
    : undefined;
  const sourceRoot = worktreePath && typeof worktreePath === "object" && !Array.isArray(worktreePath)
    ? ((worktreePath as Record<string, JsonValue>).path as string | undefined)
    : undefined;
  const snapshotRoot = sourceRoot && await pathExists(sourceRoot) ? sourceRoot : repoRoot;
  const snapshot = await createSnapshot(snapshotRoot, options.homePaths ?? []);
  try {
    const client = await cloudClient({ requireToken: true });
    const result = await client.request<JsonValue>("/api/rudder/sail/onload", {
      method: "POST",
      body: {
        runId,
        repoName: path.basename(repoRoot),
        run: runRecord ?? null,
        snapshot: {
          name: path.basename(snapshot.archivePath),
          contentType: "application/gzip",
          base64: await fsp.readFile(snapshot.archivePath, "base64"),
          manifest: snapshot.manifest as unknown as JsonValue,
        },
      },
    });
    printResult(result, options);
  } finally {
    await fsp.rm(snapshot.tempDir, { recursive: true, force: true });
  }
}

async function listSails(options: CloudCommandOptions): Promise<void> {
  const client = await cloudClient({ requireToken: true });
  const result = await client.request<JsonValue>("/api/rudder/sail", { method: "GET" });
  printResult(result, options);
}

async function mutateSail(action: "onload" | "pause" | "resume", args: string[], options: CloudCommandOptions): Promise<void> {
  const sailId = args[0];
  if (!sailId) {
    throw new Error(`Missing sail id. Usage: rudder sail ${action} <id>`);
  }
  const client = await cloudClient({ requireToken: true });
  const result = await client.request<JsonValue>(`/api/rudder/sail/${encodeURIComponent(sailId)}/${action}`, {
    method: "POST",
    body: args.length > 1 ? { args: args.slice(1) } : {},
  });
  printResult(result, options);
}

async function cloudClient(options: { requireToken: boolean }): Promise<CloudClient> {
  const baseUrl = normalizeCloudUrl(process.env.RUDDER_CLOUD_URL);
  const state = await loadCloudAuth();
  const envToken = process.env.RUDDER_CLOUD_TOKEN?.trim();
  const token = envToken || (state?.cloudUrl === baseUrl ? state.token : undefined);
  if (options.requireToken && !token) {
    throw new Error("Not logged in to Rudder Cloud. Run `rudder cloud login` first.");
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

async function createSnapshot(repoRoot: string, requestedHomePaths: string[]): Promise<{
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
  };
  await writeJson(path.join(stageDir, "manifest.json"), manifest);

  const archivePath = path.join(tempDir, `${newRunId("cloud-snapshot")}.tgz`);
  await runCommand("tar", ["-czf", archivePath, "-C", stageDir, "."], { cwd: stageDir });
  return { tempDir, archivePath, manifest };
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
  if (parts.some((part) => SECRET_PATH_PARTS.has(part)) || SECRET_BASENAMES.has(basename)) {
    return false;
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

function printResult(result: JsonValue, options: CloudCommandOptions): void {
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
    const sails = record.sails ?? record.items;
    if (Array.isArray(sails)) {
      printSailList(sails);
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

function printCloudHelp(): void {
  console.log(`rudder cloud

Usage:
  rudder cloud login
  rudder cloud <name or task>
  rudder cloud launch [--home-path <path>] ["task"]
  rudder cloud list
  rudder cloud onload <runId>
  rudder sail <name or task>
  rudder sail list
  rudder sail pause <id>
  rudder sail resume <id>

Environment:
  RUDDER_CLOUD_URL              Cloud control plane URL (defaults to ${DEFAULT_CLOUD_URL})
  RUDDER_CLOUD_HOME_PATHS       Extra comma-separated HOME paths to include in snapshots
`);
}
