const DEFAULT_MAX_CHARS = 56;

const LEADING_PATTERNS = [
  /^(?:ok(?:ay)?|hey)[, ]+/i,
  /^(?:also\s+)?(?:please\s+)?(?:can|could|would)\s+(?:you|u)\s+/i,
  /^(?:also\s+)?(?:please\s+)?(?:can|could|would)\s+we\s+/i,
  /^(?:please\s+)+/i,
  /^(?:i\s+)?(?:need|want)\s+(?:you\s+)?to\s+/i,
  /^(?:we\s+)?(?:need|should|have)\s+to\s+/i,
  /^another thing(?: for you to work on)? is\s+/i,
  /^the task is\s+/i,
];

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "but",
  "by",
  "for",
  "from",
  "gets",
  "have",
  "in",
  "is",
  "it",
  "its",
  "just",
  "of",
  "on",
  "or",
  "put",
  "puts",
  "putting",
  "right",
  "so",
  "than",
  "that",
  "the",
  "then",
  "this",
  "to",
  "user",
  "what",
  "when",
  "where",
  "with",
  "you",
  "your",
]);

export function summarizeTask(task: string, maxChars = DEFAULT_MAX_CHARS): string {
  const original = normalizeTaskText(task);
  if (!original) {
    return "agent";
  }

  let summary = stripLeadingScaffolding(original);
  summary = normalizeTaskText(summary)
    .replace(/\blsited\b/gi, "listed")
    .replace(/\brihgt\b/gi, "right")
    .replace(/\bthe task that (?:the )?user (?:puts|types|enters|entered)\b/gi, "the user task")
    .replace(/\btask that (?:the )?user (?:puts|types|enters|entered)\b/gi, "user task")
    .replace(/\band then (?:that's|that is) what gets (?:listed|shown|displayed) on\b/gi, "for")
    .replace(/\s+(?:right now|currently|at the moment|for now)\b.*$/i, "")
    .replace(/\s+/g, " ")
    .trim();

  summary = firstSentence(summary) || summary || original;
  summary = stripTerminalPunctuation(summary);

  if (summary.length <= maxChars) {
    return summary;
  }

  const compact = compactTitle(summary, maxChars);
  return compact || truncate(summary, maxChars);
}

export function taskDisplayLabel(run: { task: string; taskSummary?: string }, maxChars = DEFAULT_MAX_CHARS): string {
  const stored = normalizeTaskText(run.taskSummary ?? "");
  return truncate(stored || summarizeTask(run.task, maxChars), maxChars);
}

function stripLeadingScaffolding(value: string): string {
  let current = value;
  let changed = true;
  while (changed) {
    changed = false;
    for (const pattern of LEADING_PATTERNS) {
      const next = current.replace(pattern, "").trim();
      if (next !== current) {
        current = next;
        changed = true;
      }
    }
  }
  return current;
}

function firstSentence(value: string): string {
  const match = value.match(/^(.{12,}?[.!?])(?:\s|$)/);
  return match ? match[1] : value;
}

function compactTitle(value: string, maxChars: number): string {
  const words = value.match(/[A-Za-z0-9_./-]+/g) ?? [];
  const selected: string[] = [];
  for (const word of words) {
    const normalized = word.toLowerCase();
    if (STOP_WORDS.has(normalized)) {
      continue;
    }
    selected.push(word);
    const joined = selected.join(" ");
    if (joined.length >= maxChars - 1 || selected.length >= 8) {
      break;
    }
  }

  const compact = stripTerminalPunctuation(selected.join(" "));
  return compact && compact.length < value.length ? truncate(compact, maxChars) : "";
}

function normalizeTaskText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function stripTerminalPunctuation(value: string): string {
  return value.replace(/[.!?]+$/g, "").trim();
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

const LLM_TITLE_MAX = 80;

function cleanLlmTitle(raw: string): string | null {
  let text = raw.trim();
  if (!text) return null;
  // Strip enclosing quotes (straight + smart) and trailing punctuation.
  text = text.replace(/^["'`“”‘’]+/, "");
  text = text.replace(/["'`“”‘’]+$/, "");
  text = text.replace(/[.!?]+$/g, "").trim();
  if (!text) return null;
  // Some models prefix with "Title:". Drop common label prefixes.
  text = text.replace(/^(?:title|summary)\s*:\s*/i, "").trim();
  if (!text) return null;
  // Take only the first line to avoid multi-paragraph responses.
  text = text.split(/\r?\n/)[0]?.trim() ?? "";
  if (!text) return null;
  if (text.length > LLM_TITLE_MAX) {
    text = text.slice(0, LLM_TITLE_MAX).trimEnd();
  }
  return text;
}

const SUMMARY_PROMPT_PREFIX =
  "Generate a 5-12 word title for this coding task. Be direct, skip boilerplate. Return ONLY the title on one line, no punctuation, no quotes.\n\nTask: ";

async function summarizeViaApiKey(task: string, apiKey: string): Promise<string | null> {
  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 50,
        system:
          "Generate a 5-12 word title summarizing a coding task. Be direct, skip boilerplate. Return title only, no punctuation, no quotes.",
        messages: [{ role: "user", content: task }],
      }),
    });
    if (!response.ok) {
      return null;
    }
    const data = (await response.json()) as {
      content?: Array<{ type?: string; text?: string }>;
    };
    const first = data.content?.find((block) => typeof block?.text === "string");
    return cleanLlmTitle(first?.text ?? "");
  } catch {
    return null;
  }
}

async function summarizeViaClaudeCli(task: string): Promise<string | null> {
  const { spawn } = await import("node:child_process");
  return await new Promise<string | null>((resolve) => {
    let settled = false;
    const finish = (val: string | null) => {
      if (!settled) {
        settled = true;
        resolve(val);
      }
    };
    let child;
    try {
      child = spawn(
        "claude",
        ["-p", "--model", "claude-haiku-4-5-20251001"],
        { stdio: ["pipe", "pipe", "ignore"] },
      );
    } catch {
      finish(null);
      return;
    }
    let out = "";
    const timer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore
      }
      finish(null);
    }, 20000);
    child.stdout?.on("data", (d: Buffer) => {
      out += d.toString("utf8");
    });
    child.on("exit", () => {
      clearTimeout(timer);
      finish(cleanLlmTitle(out));
    });
    child.on("error", () => {
      clearTimeout(timer);
      finish(null);
    });
    try {
      child.stdin?.write(`${SUMMARY_PROMPT_PREFIX}${task}`);
      child.stdin?.end();
    } catch {
      // ignore — child error handler will fire
    }
  });
}

export async function llmSummarizeTask(task: string): Promise<string | null> {
  const trimmed = normalizeTaskText(task);
  if (!trimmed) {
    return null;
  }

  // Fast path: direct Anthropic API if an API key is sitting in env or in the
  // user's saved anthropic auth profile. ~1s per call.
  let apiKey = process.env.ANTHROPIC_API_KEY ?? "";
  if (!apiKey) {
    try {
      const { backendEnv } = await import("./backends.js");
      const env = await backendEnv("anthropic");
      apiKey = env.ANTHROPIC_API_KEY ?? "";
    } catch {
      // ignore — fall through to CLI fallback
    }
  }
  if (apiKey) {
    const title = await summarizeViaApiKey(trimmed, apiKey);
    if (title) return title;
  }

  // Fallback: shell out to the `claude` CLI itself. Slower (~3-5s) but works
  // for users who authenticate via the macOS Keychain / claude login flow
  // instead of a raw API key. Runs in the background relative to the dashboard
  // so the user does not feel the latency.
  return await summarizeViaClaudeCli(trimmed);
}
