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
