import fsp from "node:fs/promises";
import path from "node:path";
import { runCommand, runCommandSync, slugify } from "./util.js";
import { listRuns, saveRunRecord, worktreePath } from "./state.js";
export function findRepoRoot(cwd = process.cwd()) {
    const result = runCommandSync("git", ["rev-parse", "--show-toplevel"], {
        cwd,
        allowFailure: true,
    });
    return result.code === 0 ? result.stdout.trim() : path.resolve(cwd);
}
export function isGitRepo(cwd) {
    return (runCommandSync("git", ["rev-parse", "--is-inside-work-tree"], {
        cwd,
        allowFailure: true,
    }).stdout.trim() === "true");
}
export async function currentBranch(repoRoot) {
    const result = await runCommand("git", ["branch", "--show-current"], {
        cwd: repoRoot,
        allowFailure: true,
    });
    return result.stdout.trim() || "HEAD";
}
export async function currentCommit(repoRoot) {
    const result = await runCommand("git", ["rev-parse", "HEAD"], {
        cwd: repoRoot,
        allowFailure: true,
    });
    return result.stdout.trim() || "";
}
export async function gitStatus(repoRoot) {
    const result = await runCommand("git", ["status", "--short"], {
        cwd: repoRoot,
        allowFailure: true,
    });
    return result.stdout
        .split(/\r?\n/)
        .map((line) => line.trimEnd())
        .filter(Boolean)
        .filter((line) => {
        const file = line.slice(3).trim();
        return file !== ".rudder" && !file.startsWith(".rudder/");
    });
}
export async function gitDiff(repoRoot) {
    const status = await gitStatus(repoRoot);
    const result = await runCommand("git", ["diff", "--stat", "--", "."], {
        cwd: repoRoot,
        allowFailure: true,
    });
    const patch = await runCommand("git", ["diff", "--", "."], {
        cwd: repoRoot,
        allowFailure: true,
    });
    return [
        status.length ? `status:\n${status.join("\n")}` : "",
        result.stdout.trim(),
        patch.stdout.trim(),
    ]
        .filter(Boolean)
        .join("\n\n");
}
export async function hasChanges(repoRoot) {
    return (await gitStatus(repoRoot)).length > 0;
}
export function processAlive(pid) {
    if (!pid) {
        return false;
    }
    try {
        process.kill(pid, 0);
        return true;
    }
    catch {
        return false;
    }
}
export async function activeRunsForCheckout(repoRoot, checkoutPath) {
    const runs = await listRuns(repoRoot);
    return runs.filter((run) => {
        if (!["created", "running", "verifying"].includes(run.status)) {
            return false;
        }
        if (path.resolve(run.worktree.path) !== path.resolve(checkoutPath)) {
            return false;
        }
        return processAlive(run.process?.pid);
    });
}
export async function createRunWorktree(params) {
    const branch = `rudder/${params.runId.slice(0, 14)}-${slugify(params.task, "task").slice(0, 32)}`;
    const targetPath = worktreePath(params.repoRoot, params.runId);
    await fsp.mkdir(path.dirname(targetPath), { recursive: true });
    await runCommand("git", ["branch", branch, params.baseCommit], {
        cwd: params.repoRoot,
        allowFailure: true,
    });
    await runCommand("git", ["worktree", "add", targetPath, branch], {
        cwd: params.repoRoot,
    });
    return { branch, path: targetPath };
}
export async function removeWorktree(repoRoot, targetPath, force = false) {
    await runCommand("git", ["worktree", "remove", ...(force ? ["--force"] : []), targetPath], {
        cwd: repoRoot,
        allowFailure: force,
    });
}
export async function mergeRunIntoCurrentBranch(run, allowDirty = false) {
    if (!run.worktree.branch) {
        throw new Error("Run has no worktree branch to merge.");
    }
    if (!allowDirty && (await hasChanges(run.repoRoot))) {
        throw new Error("Target branch is dirty. Commit/stash changes or pass --allow-dirty.");
    }
    run.merge = {
        status: "not-started",
        attemptedAt: new Date().toISOString(),
        targetBranch: await currentBranch(run.repoRoot),
    };
    await saveRunRecord(run);
    await commitWorktreeChanges(run);
    const merge = await runCommand("git", ["merge", "--no-ff", run.worktree.branch], {
        cwd: run.repoRoot,
        allowFailure: true,
    });
    if (merge.code === 0) {
        run.status = "merged";
        run.merge = {
            ...run.merge,
            status: "merged",
        };
        await saveRunRecord(run);
        return run;
    }
    const conflicted = await conflictedFiles(run.repoRoot);
    run.status = "merge-conflict";
    run.merge = {
        ...run.merge,
        status: "conflict",
        conflictedFiles: conflicted,
        error: merge.stderr.trim() || merge.stdout.trim(),
    };
    await saveRunRecord(run);
    return run;
}
async function commitWorktreeChanges(run) {
    if (!(await hasChanges(run.worktree.path))) {
        return;
    }
    await runCommand("git", ["add", "-A"], {
        cwd: run.worktree.path,
    });
    const message = `rudder: ${run.task.slice(0, 72)}`;
    const commit = await runCommand("git", ["commit", "-m", message], {
        cwd: run.worktree.path,
        allowFailure: true,
    });
    if (commit.code !== 0) {
        const stillChanged = await hasChanges(run.worktree.path);
        if (stillChanged) {
            throw new Error(commit.stderr.trim() || commit.stdout.trim() || "Failed to commit worktree changes.");
        }
    }
}
export async function conflictedFiles(repoRoot) {
    const result = await runCommand("git", ["diff", "--name-only", "--diff-filter=U"], {
        cwd: repoRoot,
        allowFailure: true,
    });
    return result.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
}
export async function worktreeList(repoRoot) {
    const result = await runCommand("git", ["worktree", "list"], {
        cwd: repoRoot,
        allowFailure: true,
    });
    return result.stdout.trim();
}
//# sourceMappingURL=git.js.map