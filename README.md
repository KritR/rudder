# rudder

Rudder is a Claude Code-style terminal app for running Claude Code, Codex, and
`acpx` agents. It keeps the existing tools underneath, then adds OpenClaw-style
onboarding, a full-screen agent console, background runs, saved transcripts, and
git worktree isolation so multiple prompts do not fight over the same checkout.

## Install

From npm:

```bash
npm install -g @viraatdas/rudder
```

Or run without a global install:

```bash
npx @viraatdas/rudder@latest --help
```

Verify the installed CLI:

```bash
rudder --help
rudder doctor
```

Upgrade an existing install:

```bash
npm install -g @viraatdas/rudder@latest
```

Local development:

```bash
npm install
npm run build
npm link
```

## Setup

```bash
rudder onboard
rudder doctor
```

Rudder stores config in `~/.rudder/config.json` and OpenClaw-shaped auth
profiles in `~/.rudder/auth-profiles.json`.

It detects and can mirror:

- Claude Code auth from macOS Keychain or `~/.claude/.credentials.json`
- Codex auth from macOS Keychain or `~/.codex/auth.json`
- `ANTHROPIC_API_KEY` and `OPENAI_API_KEY`

It also offers setup-token/API-key fallback paths during onboarding.

## Run

Open the full-screen terminal UI:

```bash
rudder
```

Type a task in the prompt dock and press `Enter`. Rudder starts the agent in the
background, keeps its transcript visible, and tracks planner/verifier work in
the agent pane. TUI runs default to isolated worktrees so parallel agents do not
touch the same checkout.

```text
Enter    submit task or slash command
Tab      switch focus between agents, worker, and task panes
b        switch backend
o        open the model picker
j/k      select agent run
x        expand or collapse selected run
l        expand transcript
Esc/c    focus the selected worker; if it is running, Enter interrupts and redirects it
n        return to new-agent mode
w        toggle worktree auto/always
s        stop selected run
m        merge selected worktree run
M        merge all completed worktree runs
?        help
q        quit
```

Slash commands are available inside the TUI:

```text
/backend claude|codex|acpx
/model
/model <model>
/agent [runId]
/interrupt [runId]
/new
/worktree auto|always
/stop [runId]
/merge [runId] [--allow-dirty]
/merge-all [--allow-dirty]
/clear
/exit
```

Typing `/` opens a searchable command picker. Use arrows to move in the picker.
Press `Enter` on a partial command such as `/mo` to complete the selected
command.

`/model` opens a picker for the active backend. Claude options are discovered
from local Claude Code session history plus the aliases exposed by the installed
Claude CLI. Codex options are read from `~/.codex/models_cache.json`. `/model
<id>` still accepts any custom model id.

After an agent finishes, Rudder waits 10 seconds for user input and then sends
an automatic steering prompt asking what remains, whether the work looks good,
and whether the relevant checks were run. Each run also updates
`.rudder/agent-context.md`; that generated file is injected into new agent
prompts so agents can see what other agents are working on. The full-screen UI
plays a short completion sound when a run finishes while Rudder is open.

Codex runs use `codex exec` with `danger-full-access`, bypassed approvals,
`approval_policy="never"`, xhigh reasoning effort, detailed reasoning
summaries, and the experimental `goals` feature enabled. Claude runs use
Claude Code's print mode with `bypassPermissions`, `--dangerously-skip-permissions`,
xhigh effort, verbose stream JSON, and session resume/fork support.

Direct one-shot commands still work:

```bash
rudder "fix the failing tests"
rudder claude "fix the auth redirect bug"
rudder codex --model gpt-5.5 "refactor the parser"
rudder run -d "rewrite this module"
```

For the old line-oriented shell:

```bash
rudder legacy-shell
```

## Manage Runs

```bash
rudder status
rudder runs
rudder watch <runId>
rudder logs <runId> --follow
rudder stop <runId>
```

## Worktrees

Rudder enforces one active agent per checkout. If you start a second task in the
same repo while one is already running, Rudder creates a git worktree on a
`rudder/<run>` branch and runs the agent there.

```bash
rudder run --worktree "try the alternate implementation"
rudder merge <runId>
rudder cleanup
```

`rudder merge` uses normal git merge semantics. Clean merges are committed as a
merge commit; conflicts are left in the standard git conflict state for you to
resolve.
