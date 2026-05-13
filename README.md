# rudder

[![npm version](https://img.shields.io/npm/v/@viraatdas/rudder.svg)](https://www.npmjs.com/package/@viraatdas/rudder)
[![npm downloads](https://img.shields.io/npm/dm/@viraatdas/rudder.svg)](https://www.npmjs.com/package/@viraatdas/rudder)
[![Node >=20](https://img.shields.io/badge/node-%3E%3D20-43853d.svg)](https://nodejs.org/)
[![CLI](https://img.shields.io/badge/interface-terminal-111827.svg)](#run)

Rudder is a Claude Code-style terminal app for running coding agents without
letting parallel tasks fight over the same checkout. It gives you a focused TUI,
OpenClaw-style credential detection, background runs, saved transcripts,
worktree isolation, model picking, agent steering, and one-command merging.

## Quick Start

```bash
npm install -g @viraatdas/rudder@latest
rudder onboard
rudder
```

Then type a task and press `Enter`:

```text
fix the failing tests
```

Upgrade later with:

```bash
npm install -g @viraatdas/rudder@latest
```

Run without installing globally:

```bash
npx @viraatdas/rudder@latest --help
```

## Requirements

- Node.js 20 or newer
- Git, for run tracking and worktree isolation
- Claude Code and/or Codex installed and logged in

Check your setup:

```bash
rudder doctor
```

## Onboarding

```bash
rudder onboard
```

Rudder detects existing agent auth and mirrors what it can into
`~/.rudder/auth-profiles.json`. It also writes normal config to
`~/.rudder/config.json`.

Detected auth sources:

- Claude Code auth from macOS Keychain or `~/.claude/.credentials.json`
- Codex auth from `~/.codex/auth.json`
- `ANTHROPIC_API_KEY` and `OPENAI_API_KEY`

## Run

Open the full-screen UI:

```bash
rudder
```

The UI has three focus panes. The focused pane has a double cyan border and a
focus badge so it is clear where input goes.

| Key | Action |
| --- | --- |
| `Tab` | Switch focus between agents, worker, and task panes |
| `Enter` | Submit the current input |
| `j` / `k` or arrows | Select an agent run |
| `c` or `Esc` | Focus the selected worker |
| `n` | Return to new-task mode |
| `o` or `/model` | Open the model picker |
| `/` | Open searchable slash commands |
| `x` | Expand/collapse selected run |
| `l` | Expand/collapse transcript |
| `s` | Stop selected run |
| `d` | Delete selected run, with an offer to merge completed work first |
| `y` | Copy the selected worker transcript to the clipboard |
| `m` | Merge selected completed worktree run |
| `M` | Merge all completed worktree runs |
| `Cmd+Backspace` / `Ctrl+U` | Clear the input line |
| `?` | Help |
| `q` | Quit |

Worker focus is intentionally direct: the input moves into the selected worker
pane, so a completed run feels like a resumable standalone session. Type there
and press `Enter` to continue that agent. If the agent is still running, `Enter`
interrupts and redirects it. Press `Esc` from an empty worker input to return to
new-task mode.

Paste works directly in the task and worker input. For long pasted prompts,
Rudder normalizes line breaks into spaces so the prompt stays inside the input
box.

Slash commands:

```text
/backend claude|codex
/model
/model <model-id>
/agent [runId]
/interrupt [runId]
/new
/worktree auto|always
/stop [runId]
/delete [runId]
/copy [runId]
/merge [runId] [--allow-dirty]
/merge-all [--allow-dirty]
/clear
/exit
```

Typing `/` opens command search. Use arrows to move, then press `Enter` to run
or complete the selected command.

## Models

`/model` opens a bounded picker for the active backend. Rudder passes the
selected value straight through to the underlying CLI: Claude uses
`claude --model <value>`, and Codex uses `codex exec --model <value>`.

- Claude is alias-first like Claude Code itself: `sonnet`, `sonnet[1m]`,
  `opus`, `opus[1m]`, and `haiku` appear before explicit model IDs.
- Codex shows Codex-relevant OpenAI model IDs.
- Explicit Claude and Codex model IDs are fetched from
  `https://models.dev/api.json`, the same public model registry used by
  opencode.
- The fetched registry is cached in `~/.rudder/models-dev.json`.
- If the network is unavailable, Rudder falls back to local Claude session
  history and Codex's `~/.codex/models_cache.json`.
- `/model <model-id>` still accepts any custom model id.

## Worktrees And Merging

Rudder enforces one active agent per checkout. If you start another task in the
same repo, Rudder creates a separate git worktree and runs the agent there.

```bash
rudder run --worktree "try the alternate implementation"
rudder merge <runId>
rudder cleanup
```

`rudder merge` uses normal git merge semantics. Clean merges become merge
commits. Conflicts are left in the standard git conflict state for you to
resolve.

## Agent Steering

Each run gets a lightweight Rudder contract with:

- repository instructions from `AGENTS.md`, `CLAUDE.md`, and `README.md`
- active-agent context from `.rudder/agent-context.md`
- acceptance criteria for the task
- suggested verification commands

After an agent finishes, Rudder verifies basic completion signals. If there are
clear gaps, it can send a follow-up steering prompt. It does not auto-steer
simple no-op greetings.

## One-Shot Commands

```bash
rudder "fix the failing tests"
rudder claude "fix the auth redirect bug"
rudder codex --model gpt-5.5 "refactor the parser"
rudder run -d "rewrite this module"
```

## Run Management

```bash
rudder status
rudder runs
rudder watch <runId>
rudder logs <runId> --follow
rudder stop <runId>
rudder delete <runId>
rudder merge <runId>
rudder cleanup
```

## Troubleshooting

```bash
rudder doctor
rudder onboard
npm install -g @viraatdas/rudder@latest
```

If Codex models look stale, open Codex once or refresh its login, then reopen
Rudder. If Claude models look stale, run a Claude Code session once; Rudder reads
local Claude session history to populate explicit Claude model ids.

## Development

```bash
git clone https://github.com/viraatdas/rudder.git
cd rudder
npm install
npm run check
npm run build
npm link
```
