import { runCommand } from "./util.js";
const FALLBACK_EFFORTS = ["low", "medium", "high", "xhigh"];
export async function discoverEffortOptions(backend) {
    const values = backend === "claude"
        ? await discoverClaudeEfforts()
        : await discoverCodexEfforts();
    return [
        { label: "auto", value: undefined, detail: "let the selected model choose" },
        ...values.map((value) => ({
            label: value,
            value,
            detail: effortDetail(value),
        })),
    ];
}
export function fallbackEffortOptions(backend) {
    return [
        { label: "auto", value: undefined, detail: "let the selected model choose" },
        ...(backend === "claude" ? [...FALLBACK_EFFORTS, "max"] : FALLBACK_EFFORTS)
            .map((value) => ({ label: value, value, detail: effortDetail(value) })),
    ];
}
export function normalizeEffortForBackend(backend, effort) {
    if (!effort) {
        return undefined;
    }
    if (backend === "codex" && effort === "max") {
        return "xhigh";
    }
    return effort;
}
async function discoverClaudeEfforts() {
    const help = await runCommand("claude", ["--help"], { allowFailure: true });
    const values = parseEfforts(help.stdout || help.stderr);
    return values.length ? values : [...FALLBACK_EFFORTS, "max"];
}
async function discoverCodexEfforts() {
    const help = await runCommand("codex", ["exec", "--help"], { allowFailure: true });
    const values = parseEfforts(help.stdout || help.stderr).filter((value) => value !== "max");
    return values.length ? values : FALLBACK_EFFORTS;
}
function parseEfforts(text) {
    const found = new Set();
    const effortLine = text
        .split(/\r?\n/)
        .find((line) => /effort|reasoning/i.test(line)) ?? "";
    for (const value of ["low", "medium", "high", "xhigh", "max"]) {
        if (new RegExp(`\\b${value}\\b`, "i").test(effortLine)) {
            found.add(value);
        }
    }
    return [...found];
}
function effortDetail(value) {
    if (value === "low")
        return "fastest explicit override";
    if (value === "medium")
        return "balanced explicit override";
    if (value === "high")
        return "deeper explicit override";
    if (value === "xhigh")
        return "extra explicit override";
    return "maximum explicit override";
}
//# sourceMappingURL=effort.js.map