# rudder

[![npm version](https://img.shields.io/npm/v/@viraatdas/rudder.svg)](https://www.npmjs.com/package/@viraatdas/rudder)
[![npm downloads](https://img.shields.io/npm/dm/@viraatdas/rudder.svg)](https://www.npmjs.com/package/@viraatdas/rudder)
[![Node >=20](https://img.shields.io/badge/node-%3E%3D20-43853d.svg)](https://nodejs.org/)
[![CLI](https://img.shields.io/badge/interface-terminal-111827.svg)](#run)

Rudder is a Claude Code-style terminal command center for running coding agents
without letting parallel tasks fight over the same checkout. It opens a tmux
dashboard, creates one git worktree per task, and launches real Claude Code or
Codex terminal panes so you keep the full native agent experience.

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
- tmux, for the native multi-pane dashboard
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

Open the tmux dashboard:

```bash
rudder
```

The tmux UI has three real panes:

- left: the Rudder agent list
- right: the worker pane, respawned as a native `claude` or `codex` process for
  the selected task
- bottom: the task input pane for creating new agents

Focus the worker pane to use Claude Code or Codex directly, including their
slash commands, interrupts, copy/paste, model controls, resume behavior, and
terminal UI.

| Key | Action |
| --- | --- |
| `Enter` | Start a task, or focus the selected worker if the task box is empty |
| `Tab` | Move focus to the next tmux pane |
| `j` / `k` or arrows | Select an agent run |
| `f` | Focus the selected native worker pane |
| `o` or `/model` | Open the model picker |
| `s` | Stop selected run |
| `d` | Delete selected run, with an offer to merge first when there are changes |
| `m` | Merge selected completed worktree run |
| `Cmd+Backspace` / `Ctrl+U` | Clear the input line |
| `q` or `Ctrl+C` | Detach from the tmux session |

Inside a worker pane, Rudder is out of the way. You are in the real Claude Code
or Codex process. Use tmux mouse support, your terminal copy mode, or native
agent keybindings normally.

Slash commands:

```text
/backend claude|codex
/model
/model <model-id>
```

If tmux is not installed, or you pass `--no-tmux`, Rudder falls back to the
legacy full-screen stream TUI.

## Models

`/model` opens a bounded picker for the active backend. Rudder passes the
selected value straight through to the underlying CLI: Claude uses
`claude --model <value>`, and Codex uses `codex --model <value>`.

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

For tmux-launched agents, the contract is injected into the native process at
startup. The worker pane remains yours after the initial task, so you can keep
typing into Claude Code or Codex directly. Headless one-shot runs still use
Rudder's verifier and steering loop.

## One-Shot Commands

```bash
rudder "fix the failing tests"
rudder claude "fix the auth redirect bug"
rudder codex --model gpt-5.5 "refactor the parser"
rudder run -d "rewrite this module"
rudder tui
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
