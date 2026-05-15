import { spawn } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { currentBranch, currentCommit, findRepoRoot } from "./git.js";
import { cloudAuthPath } from "./state.js";
import { ensureDir, commandExists, expandHome, newRunId, nowIso, pathExists, promptText, promptSelect, promptSecret, readJson, runCommand, shortenHome, shellQuote, writeJson, } from "./util.js";
const DEFAULT_LOGIN_INTERVAL_MS = 2000;
const DEFAULT_LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_CLOUD_URL = "https://mpd2pmnpep.us-east-1.awsapprunner.com";
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
export async function runCloudCommand(command, args, options = {}) {
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
        case "vm":
        case "byoc":
        case "byo-vm":
            await launch(rest, options, "task", "byo-vm");
            return;
        case "list":
        case "ls":
            await listSails(options);
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
async function login(options) {
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
async function tryBrowserLogin(client, options) {
    const response = await client.request("/api/cli/login", {
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
async function tryGithubCliLogin(client) {
    if (process.env.RUDDER_SKIP_GH_CLI === "1") {
        return null;
    }
    const gh = await runCommand("gh", ["auth", "token"], { allowFailure: true });
    const token = gh.stdout.trim();
    if (gh.code !== 0 || !token) {
        return null;
    }
    return await client.request("/api/cli/login/github-token", {
        method: "POST",
        body: { token },
    });
}
async function tryGithubDeviceLogin(client, options) {
    const start = await githubOAuthRequest("https://github.com/login/device/code", {
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
        const poll = await githubOAuthRequest("https://github.com/login/oauth/access_token", {
            client_id: GITHUB_CLI_CLIENT_ID,
            device_code: start.device_code,
            grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        });
        if (poll.access_token) {
            return await client.request("/api/cli/login/github-token", {
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
async function githubOAuthRequest(url, body) {
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
    return parsed;
}
async function saveCloudLogin(client, login, token, options, source) {
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
        const result = { ok: true, cloudUrl: client.baseUrl, source };
        if (login.email) {
            result.email = login.email;
        }
        if (login.accountId) {
            result.accountId = login.accountId;
        }
        printJson(result);
    }
    else {
        console.log(`Logged in to ${client.baseUrl}${login.email ? ` as ${login.email}` : ""} via ${source}.`);
    }
}
async function launch(args, options, mode = "name", explicitRuntime) {
    const raw = args.join(" ").trim();
    const repoRoot = findRepoRoot();
    const snapshot = await createSnapshot(repoRoot, options.homePaths ?? []);
    try {
        const client = await cloudClient({ requireToken: true });
        const runtime = await selectedCloudRuntime(explicitRuntime);
        const task = mode === "task" || runtime === "byo-vm" ? raw : "";
        const name = task ? cloudNameFromTask(task) : raw || randomCloudName();
        const body = {
            repoName: path.basename(repoRoot),
            name,
            snapshot: {
                name: path.basename(snapshot.archivePath),
                contentType: "application/gzip",
                base64: await fsp.readFile(snapshot.archivePath, "base64"),
                manifest: snapshot.manifest,
            },
        };
        if (runtime !== "fly") {
            body.runtime = runtime;
        }
        if (task) {
            body.task = task;
        }
        const result = await client.request("/api/rudder/sail/launch", {
            method: "POST",
            body,
        });
        await printResult(result, options);
    }
    finally {
        await fsp.rm(snapshot.tempDir, { recursive: true, force: true });
    }
}
async function onload(args, options) {
    const runId = args[0];
    if (!runId) {
        throw new Error("Missing run id. Usage: rudder cloud onload <runId>");
    }
    const repoRoot = findRepoRoot();
    const runRecord = await readJson(path.join(repoRoot, ".rudder", "runs", runId, "run.json"));
    const worktreePath = runRecord && typeof runRecord === "object" && !Array.isArray(runRecord)
        ? runRecord.worktree
        : undefined;
    const sourceRoot = worktreePath && typeof worktreePath === "object" && !Array.isArray(worktreePath)
        ? worktreePath.path
        : undefined;
    const snapshotRoot = sourceRoot && await pathExists(sourceRoot) ? sourceRoot : repoRoot;
    const snapshot = await createSnapshot(snapshotRoot, options.homePaths ?? []);
    try {
        const client = await cloudClient({ requireToken: true });
        const runtime = await selectedCloudRuntime();
        const result = await client.request("/api/rudder/sail/onload", {
            method: "POST",
            body: {
                runId,
                repoName: path.basename(repoRoot),
                run: runRecord ?? null,
                ...(runtime !== "fly" ? { runtime } : {}),
                snapshot: {
                    name: path.basename(snapshot.archivePath),
                    contentType: "application/gzip",
                    base64: await fsp.readFile(snapshot.archivePath, "base64"),
                    manifest: snapshot.manifest,
                },
            },
        });
        await printResult(result, options);
    }
    finally {
        await fsp.rm(snapshot.tempDir, { recursive: true, force: true });
    }
}
async function listSails(options) {
    const client = await cloudClient({ requireToken: true });
    const result = await client.request("/api/rudder/sail", { method: "GET" });
    await printResult(result, options);
}
async function bootstrap(args, options) {
    const sailId = args[0];
    if (!sailId) {
        throw new Error("Missing sail id. Usage: rudder cloud bootstrap <id>");
    }
    const client = await cloudClient({ requireToken: true });
    const result = await client.request(`/api/rudder/sail/${encodeURIComponent(sailId)}/bootstrap`, {
        method: "POST",
        body: {},
    });
    await printResult(result, options);
}
async function mutateSail(action, args, options) {
    const sailId = args[0];
    if (!sailId) {
        throw new Error(`Missing sail id. Usage: rudder sail ${action} <id>`);
    }
    const client = await cloudClient({ requireToken: true });
    const result = await client.request(`/api/rudder/sail/${encodeURIComponent(sailId)}/${action}`, {
        method: "POST",
        body: args.length > 1 ? { args: args.slice(1) } : {},
    });
    await printResult(result, options);
}
async function setupOAuthProvider(provider, args, options) {
    const envPrefix = provider === "github" ? "RUDDER_GITHUB" : "RUDDER_GOOGLE";
    const clientId = args[0]?.trim() || process.env[`${envPrefix}_CLIENT_ID`]?.trim();
    const clientSecret = process.env[`${envPrefix}_CLIENT_SECRET`]?.trim() ||
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
    const result = await client.request(`/api/rudder/setup/${provider}`, {
        method: "POST",
        body: {
            clientId,
            clientSecret,
        },
    });
    await printResult(result, options);
}
async function setupByoc(args, options) {
    const sshConfigPath = path.join(os.homedir(), ".ssh", "config");
    const configuredHosts = await listSshConfigHosts(sshConfigPath);
    const host = (options.sshHost ?? args.join(" ").trim()) || await chooseByocHost(configuredHosts);
    if (!host) {
        throw new Error([
            "Missing BYOC SSH host.",
            "Add your workstation/server to ~/.ssh/config, then run:",
            "",
            "  rudder cloud setup-byoc <ssh-host>",
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
    await configureDefaultRuntime("byo-vm", options, host);
    if (options.json) {
        return;
    }
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
    }
    else {
        console.log(`\nSSH check did not fully pass for ${host}: ${diagnostics.message}`);
        console.log("Fix SSH/Docker before launching, or run the printed Docker command manually on that host.");
    }
}
async function chooseByocHost(hosts) {
    if (hosts.length === 0) {
        return await promptText("SSH host from ~/.ssh/config");
    }
    return await promptSelect("Choose a BYOC SSH host from ~/.ssh/config", hosts.slice(0, 24).map((host) => ({ value: host, label: host })), hosts[0]);
}
async function configureDefaultRuntime(runtime, options, byocSshHost) {
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
    const result = {
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
            : "Run `rudder cloud setup-byoc <ssh-host>` to let Rudder start workers over SSH.");
    }
    else {
        console.log("Future `rudder cloud <task>` and `/sail <task>` launches will create Fly Machines.");
    }
    if (envRuntime) {
        console.log(`RUDDER_CLOUD_RUNTIME=${envRuntime} is set and will override this saved default.`);
    }
}
async function runtime(args, options) {
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
    const result = {
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
    }
    else {
        console.log(`Rudder Cloud runtime: ${current}`);
        if (envRuntime) {
            console.log(`Set by RUDDER_CLOUD_RUNTIME=${envRuntime}.`);
        }
        else if (state?.cloudUrl === client.baseUrl && savedRuntime) {
            console.log("Set in local Rudder Cloud config.");
        }
        else {
            console.log("Using default Fly Machines runtime.");
        }
        if (state?.cloudUrl === client.baseUrl && state.byocSshHost) {
            console.log(`BYOC SSH host: ${state.byocSshHost}`);
        }
    }
}
async function sshConfigMentions(configPath, host) {
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
async function listSshConfigHosts(configPath) {
    const text = await fsp.readFile(configPath, "utf8").catch(() => "");
    const hosts = [];
    const seen = new Set();
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
async function checkByocHost(host) {
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
async function startByocWorkerOverSsh(host, bootstrapCommand) {
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
function nonInteractiveDockerCommand(command) {
    return command
        .replace(/\bdocker run --rm -it\b/g, "docker run --rm")
        .replace(/\bdocker run --rm -i -t\b/g, "docker run --rm")
        .replace(/\bdocker run --rm -t -i\b/g, "docker run --rm");
}
async function cloudClient(options) {
    const baseUrl = normalizeCloudUrl(process.env.RUDDER_CLOUD_URL);
    const state = await loadCloudAuth();
    const envToken = process.env.RUDDER_CLOUD_TOKEN?.trim();
    const token = envToken || (state?.cloudUrl === baseUrl ? state.token : undefined);
    if (options.requireToken && !token) {
        throw new Error("Not logged in to Rudder Cloud. Run `rudder login` first.");
    }
    return {
        baseUrl,
        async request(pathOrUrl, init) {
            const url = pathOrUrl.startsWith("http://") || pathOrUrl.startsWith("https://")
                ? pathOrUrl
                : new URL(pathOrUrl, `${baseUrl}/`).toString();
            const headers = {
                Accept: "application/json",
            };
            let body;
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
            return parsed;
        },
    };
}
function normalizeCloudUrl(raw) {
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
    }
    catch {
        throw new Error("RUDDER_CLOUD_URL must be a valid http(s) URL.");
    }
}
async function selectedCloudRuntime(explicit) {
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
function parseCloudRuntime(raw) {
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
function envCloudRuntime() {
    const runtime = parseCloudRuntime(process.env.RUDDER_CLOUD_RUNTIME);
    if (process.env.RUDDER_CLOUD_RUNTIME?.trim() && !runtime) {
        throw new Error("RUDDER_CLOUD_RUNTIME must be `fly`, `byoc`, or `byo-vm`.");
    }
    return runtime;
}
async function pollLogin(client, pollPath, deviceCode) {
    if (pollPath.startsWith("http://") || pollPath.startsWith("https://") || !deviceCode) {
        return await client.request(pollPath, { method: "GET" });
    }
    return await client.request(pollPath, {
        method: "POST",
        body: { deviceCode },
    });
}
async function loadCloudAuth() {
    const state = await readJson(cloudAuthPath());
    return state?.version === 1 && typeof state.token === "string" ? state : null;
}
async function saveCloudAuth(state) {
    await writeJson(cloudAuthPath(), state, { mode: 0o600 });
}
async function createSnapshot(repoRoot, requestedHomePaths) {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "rudder-cloud-"));
    const stageDir = path.join(tempDir, "snapshot");
    const repoStage = path.join(stageDir, "repo");
    const homeStage = path.join(stageDir, "home");
    await ensureDir(repoStage);
    await copyRepoFiles(repoRoot, repoStage);
    const homePaths = normalizeHomePaths(requestedHomePaths);
    const includedHomePaths = [];
    for (const homePath of homePaths) {
        const copied = await copyHomePath(homePath, homeStage);
        if (copied) {
            includedHomePaths.push(shortenHome(homePath));
        }
    }
    const manifest = {
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
async function copyRepoFiles(repoRoot, repoStage) {
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
async function listFiles(dir) {
    const files = [];
    async function walk(current) {
        const entries = await fsp.readdir(current, { withFileTypes: true }).catch(() => []);
        for (const entry of entries) {
            if (entry.name === ".git" || entry.name === ".rudder" || entry.name === "node_modules") {
                continue;
            }
            const full = path.join(current, entry.name);
            if (entry.isDirectory()) {
                await walk(full);
            }
            else {
                files.push(path.relative(dir, full));
            }
        }
    }
    await walk(dir);
    return files;
}
function normalizeHomePaths(requested) {
    const raw = [
        ...DEFAULT_HOME_PATHS,
        ...requested,
        ...(process.env.RUDDER_CLOUD_HOME_PATHS?.split(",") ?? []),
    ];
    const home = os.homedir();
    const seen = new Set();
    const paths = [];
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
async function copyHomePath(source, homeStage) {
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
async function shouldIncludeSnapshotPath(candidate) {
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
function isInside(parent, child) {
    const relative = path.relative(path.resolve(parent), path.resolve(child));
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
function openBrowser(url) {
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
function withQuery(baseUrl, pathname, query) {
    const url = new URL(pathname, `${baseUrl}/`);
    for (const [key, value] of Object.entries(query)) {
        url.searchParams.set(key, value);
    }
    return url.toString();
}
function parseJson(text) {
    try {
        return JSON.parse(text);
    }
    catch {
        return text;
    }
}
function responseErrorMessage(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return undefined;
    }
    const record = value;
    return typeof record.error === "string"
        ? record.error
        : typeof record.message === "string"
            ? record.message
            : undefined;
}
async function printResult(result, options) {
    if (options.json) {
        printJson(result);
        return;
    }
    if (Array.isArray(result)) {
        printSailList(result);
        return;
    }
    if (result && typeof result === "object" && !Array.isArray(result)) {
        const record = result;
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
                }
                catch (error) {
                    console.log(`Could not start BYOC worker over SSH on ${host}: ${error instanceof Error ? error.message : String(error)}`);
                    console.log("Run this manually on your workstation/server:");
                    console.log(record.bootstrapCommand);
                }
            }
            else {
                console.log("Run this on your workstation/server:");
                console.log(record.bootstrapCommand);
                if (!host) {
                    console.log("\nTip: run `rudder cloud setup-byoc <ssh-host>` to have Rudder start this over SSH next time.");
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
    }
    console.log(JSON.stringify(result, null, 2));
}
function printSailList(items) {
    if (items.length === 0) {
        console.log("No cloud sails.");
        return;
    }
    for (const item of items) {
        if (!item || typeof item !== "object" || Array.isArray(item)) {
            console.log(String(item));
            continue;
        }
        const sail = item;
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
function printJson(value) {
    console.log(JSON.stringify(value, null, 2));
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
function printCloudHelp() {
    console.log(`rudder cloud

Usage:
  rudder cloud login
  rudder cloud help
  rudder cloud [name or task]
  rudder cloud launch [--home-path <path>] ["task"]
  rudder cloud byoc ["task"]
  rudder cloud list
  rudder cloud onload <runId>
  rudder cloud bootstrap <id>
  rudder cloud runtime [fly|byoc]
  rudder cloud setup-byoc <ssh-host>
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
function randomCloudName() {
    const seed = Date.now() + process.pid + Math.floor(Math.random() * 1_000_000);
    return [
        CLOUD_ADJECTIVES[Math.abs(seed) % CLOUD_ADJECTIVES.length],
        CLOUD_NOUNS[Math.abs(Math.floor(seed / CLOUD_ADJECTIVES.length)) % CLOUD_NOUNS.length],
    ].join("-");
}
function cloudNameFromTask(task) {
    const slug = task
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 36)
        .replace(/-+$/g, "");
    return slug || randomCloudName();
}
//# sourceMappingURL=cloud.js.map