import path from "node:path";
import { projectStateDir } from "./state.js";
import { ensureDir, readJson, writeJson } from "./util.js";
export function tmuxDashboardStatePath(repoRoot, sessionName) {
    return path.join(projectStateDir(repoRoot), "tmux", `${sessionName}.json`);
}
export async function loadTmuxDashboardState(repoRoot, sessionName) {
    return await readJson(tmuxDashboardStatePath(repoRoot, sessionName));
}
export async function saveTmuxDashboardState(state) {
    await ensureDir(path.dirname(tmuxDashboardStatePath(state.repoRoot, state.sessionName)));
    await writeJson(tmuxDashboardStatePath(state.repoRoot, state.sessionName), state);
}
export async function updateTmuxDashboardState(repoRoot, sessionName, patch) {
    const current = await loadTmuxDashboardState(repoRoot, sessionName);
    if (!current) {
        return null;
    }
    const next = { ...current, ...patch };
    await saveTmuxDashboardState(next);
    return next;
}
//# sourceMappingURL=tmux-state.js.map