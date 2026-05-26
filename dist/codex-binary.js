import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { commandExists, ensureDir, rudderHome } from "./util.js";
export const RUDDER_CODEX_REPOSITORY = "viraatdas/codex";
export const RUDDER_CODEX_RELEASE = "rudder-codex-v0.1.0-upstream-db9cb04";
export const RUDDER_CODEX_ASSET_SHA256 = "9f9577d244e83e5711b64b781527e32538b78d4005141dc33c6bed8f3296ded7";
export async function codexEnvVars() {
    const codex = await ensureRudderCodexBinary();
    return {
        RUDDER_CODEX_BIN: codex,
        RUDDER_CODEX_VERSION: RUDDER_CODEX_RELEASE,
        CODEX_RUDDER_SCROLLBACK_SAFE: "1",
    };
}
export async function codexLaunchEnv(base = process.env) {
    return {
        ...base,
        ...await codexEnvVars(),
    };
}
export async function ensureRudderCodexBinary() {
    const override = process.env.RUDDER_CODEX_BIN?.trim();
    if (override) {
        const resolved = expandCommandPath(override);
        if (await isRunnable(resolved)) {
            return resolved;
        }
        throw new Error(`RUDDER_CODEX_BIN is set but is not executable: ${override}`);
    }
    const assets = platformAssetNames();
    const dest = managedBinaryPath();
    if (await verifyCachedManagedBinary(dest)) {
        return dest;
    }
    await downloadManagedBinary(assets, dest);
    if (!await verifyCachedManagedBinary(dest)) {
        throw new Error(`Managed Rudder Codex install failed verification: ${dest}`);
    }
    return dest;
}
export function managedBinaryPath() {
    return path.join(rudderHome(), "bin", "codex", RUDDER_CODEX_RELEASE, "rudder-codex");
}
function managedChecksumPath() {
    return `${managedBinaryPath()}.sha256`;
}
function platformAssetNames() {
    if (process.platform === "darwin" && process.arch === "arm64") {
        return [
            "rudder-codex-darwin-arm64.gz.part-00",
            "rudder-codex-darwin-arm64.gz.part-01",
            "rudder-codex-darwin-arm64.gz.part-02",
            "rudder-codex-darwin-arm64.gz.part-03",
            "rudder-codex-darwin-arm64.gz.part-04",
            "rudder-codex-darwin-arm64.gz.part-05",
            "rudder-codex-darwin-arm64.gz.part-06",
            "rudder-codex-darwin-arm64.gz.part-07",
            "rudder-codex-darwin-arm64.gz.part-08",
            "rudder-codex-darwin-arm64.gz.part-09",
            "rudder-codex-darwin-arm64.gz.part-10",
            "rudder-codex-darwin-arm64.gz.part-11",
            "rudder-codex-darwin-arm64.gz.part-12",
            "rudder-codex-darwin-arm64.gz.part-13",
            "rudder-codex-darwin-arm64.gz.part-14",
            "rudder-codex-darwin-arm64.gz.part-15",
            "rudder-codex-darwin-arm64.gz.part-16",
            "rudder-codex-darwin-arm64.gz.part-17",
        ];
    }
    throw new Error(`Rudder's pinned Codex fork does not have a managed binary for ${process.platform}/${process.arch} yet. Set RUDDER_CODEX_BIN to an executable override.`);
}
async function downloadManagedBinary(assets, dest) {
    const repo = process.env.RUDDER_CODEX_REPO?.trim() || RUDDER_CODEX_REPOSITORY;
    const downloaded = Buffer.concat(await Promise.all(assets.map((asset) => downloadReleaseAsset(repo, asset))));
    if (RUDDER_CODEX_ASSET_SHA256) {
        const actual = createHash("sha256").update(downloaded).digest("hex");
        if (actual !== RUDDER_CODEX_ASSET_SHA256) {
            throw new Error(`Downloaded Rudder Codex checksum mismatch: expected ${RUDDER_CODEX_ASSET_SHA256}, got ${actual}`);
        }
    }
    const bytes = assets[0]?.includes(".gz") ? gunzipSync(downloaded) : downloaded;
    const binarySha = createHash("sha256").update(bytes).digest("hex");
    await ensureDir(path.dirname(dest));
    const temp = path.join(path.dirname(dest), `.rudder-codex.${process.pid}.${Date.now()}`);
    await fsp.writeFile(temp, bytes, { mode: 0o755 });
    await fsp.chmod(temp, 0o755);
    await fsp.rename(temp, dest);
    await fsp.writeFile(managedChecksumPath(), `${binarySha}\n`);
}
async function downloadReleaseAsset(repo, asset) {
    const url = `https://github.com/${repo}/releases/download/${RUDDER_CODEX_RELEASE}/${asset}`;
    const response = await fetch(url, { redirect: "follow" });
    if (!response.ok) {
        throw new Error(`Failed to download Rudder Codex ${RUDDER_CODEX_RELEASE} from ${url}: HTTP ${response.status}`);
    }
    return Buffer.from(await response.arrayBuffer());
}
async function verifyCachedManagedBinary(file) {
    if (!await isRunnable(file)) {
        return false;
    }
    const checksumFile = managedChecksumPath();
    try {
        const expected = (await fsp.readFile(checksumFile, "utf8")).trim();
        const actual = await sha256File(file);
        if (expected && actual === expected) {
            return true;
        }
    }
    catch {
        // Redownload below if the executable exists but its checksum marker is missing.
    }
    await fsp.rm(file, { force: true });
    await fsp.rm(checksumFile, { force: true });
    return false;
}
async function sha256File(file) {
    const hash = createHash("sha256");
    const stream = fs.createReadStream(file);
    for await (const chunk of stream) {
        hash.update(chunk);
    }
    return hash.digest("hex");
}
async function isRunnable(command) {
    if (!command.includes(path.sep)) {
        return commandExists(command);
    }
    try {
        await fsp.access(command, fs.constants.X_OK);
        return (await fsp.stat(command)).isFile();
    }
    catch {
        return false;
    }
}
function expandCommandPath(command) {
    return command.startsWith("~/") ? path.join(os.homedir(), command.slice(2)) : command;
}
//# sourceMappingURL=codex-binary.js.map