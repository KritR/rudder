import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

function cachePath(): string {
  const base = process.env.XDG_CACHE_HOME?.trim() || path.join(os.homedir(), ".cache");
  return path.join(base, "rudder", "update-check.json");
}

function compareSemver(a: string, b: string): number {
  const split = (v: string) =>
    v
      .split("-")[0]!
      .split(".")
      .map((part) => Number.parseInt(part, 10) || 0);
  const aa = split(a);
  const bb = split(b);
  for (let i = 0; i < 3; i++) {
    const x = aa[i] ?? 0;
    const y = bb[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

async function readPackageVersion(): Promise<string | null> {
  // Try package.json relative to compiled dist/, then to source src/.
  const candidates = [
    path.join(moduleDir, "..", "package.json"),
    path.join(moduleDir, "..", "..", "package.json"),
  ];
  for (const candidate of candidates) {
    try {
      const raw = await fsp.readFile(candidate, "utf8");
      const parsed = JSON.parse(raw) as { version?: unknown; name?: unknown };
      if (parsed?.name === "@viraatdas/rudder" && typeof parsed.version === "string") {
        return parsed.version;
      }
    } catch {
      // ignore
    }
  }
  return null;
}

async function readCache(): Promise<{ latest: string; checkedAt: number } | null> {
  try {
    const raw = await fsp.readFile(cachePath(), "utf8");
    const parsed = JSON.parse(raw) as { latest?: unknown; checkedAt?: unknown };
    if (typeof parsed.latest === "string" && typeof parsed.checkedAt === "number") {
      return { latest: parsed.latest, checkedAt: parsed.checkedAt };
    }
  } catch {
    // ignore
  }
  return null;
}

async function writeCache(latest: string): Promise<void> {
  const file = cachePath();
  try {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, JSON.stringify({ latest, checkedAt: Date.now() }));
  } catch {
    // ignore
  }
}

async function fetchLatest(): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  try {
    const res = await fetch("https://registry.npmjs.org/@viraatdas/rudder/latest", {
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { version?: unknown };
    return typeof data?.version === "string" ? data.version : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Returns the latest published version if our local version is older, otherwise null.
 * Cached for 6h on disk so startup doesn't hit the network every launch. Never throws.
 * Disabled when RUDDER_DISABLE_UPDATE_CHECK is set.
 */
export async function getUpdateAvailable(): Promise<{ current: string; latest: string } | null> {
  if (process.env.RUDDER_DISABLE_UPDATE_CHECK) return null;
  const current = await readPackageVersion();
  if (!current) return null;

  const cached = await readCache();
  let latest: string | null = null;
  if (cached && Date.now() - cached.checkedAt < CACHE_TTL_MS) {
    latest = cached.latest;
  } else {
    latest = await fetchLatest();
    if (latest) {
      await writeCache(latest);
    } else if (cached) {
      latest = cached.latest;
    }
  }
  if (!latest) return null;
  return compareSemver(current, latest) < 0 ? { current, latest } : null;
}
