# rudder

<p>
  <a href="https://rudder.viraat.dev">
    <img src="https://rudder.viraat.dev/favicon.svg" width="36" height="36" alt="Rudder logo" />
  </a>
</p>

[![npm version](https://img.shields.io/npm/v/@viraatdas/rudder.svg)](https://www.npmjs.com/package/@viraatdas/rudder)
[![npm downloads](https://img.shields.io/npm/dm/@viraatdas/rudder.svg)](https://www.npmjs.com/package/@viraatdas/rudder)
[![Node >=20](https://img.shields.io/badge/node-%3E%3D20-43853d.svg)](https://nodejs.org/)
[![Website](https://img.shields.io/badge/site-rudder.viraat.dev-111111.svg)](https://rudder.viraat.dev)

Rudder is a terminal command center for running local coding agents. It opens a
native three-pane dashboard, creates an isolated git worktree for each task, and
runs real Claude Code or Codex processes in the worker pane.

## Install

```bash
npm install -g @viraatdas/rudder@latest
rudder
```

Upgrade with the same command:

```bash
npm install -g @viraatdas/rudder@latest
```

Run without a global install:

```bash
npx @viraatdas/rudder@latest
```

## Requirements

- Node.js 20 or newer
- Git
- Claude Code and/or Codex installed and logged in
- macOS, Linux, or another Unix-like terminal environment

Check the local setup:

```bash
rudder doctor
```

## Onboarding

```bash
rudder onboard
```

Onboarding checks for `claude`, `codex`, git, auth files, env vars, and acpx.
It uses the auth you already have whenever possible:

- Claude Code auth from macOS Keychain or `~/.claude/.credentials.json`
- Codex auth from `~/.codex/auth.json`
- `ANTHROPIC_API_KEY` and `OPENAI_API_KEY`

If auth is missing, Rudder lets you skip it and set up the backend later. It
does not require API keys when you already use Claude Code or Codex login.

Config is written to `~/.rudder/config.json`. Mirrored auth metadata is written
to `~/.rudder/auth-profiles.json`.

## Dashboard

Start the native dashboard:

```bash
rudder
```

The dashboard has three panes:

- `agents`: the left pane with one row per task, its backend, model, effort, and
  completion status
- `worker`: the right pane with the actual Claude Code or Codex terminal
- `task`: the bottom input for starting a new agent

Type a task in the task pane and press `Enter`. Rudder creates a worktree,
writes the current agent context to `RUDDER.md`, and starts the selected backend
inside the worker pane.

When the worker pane is focused, your keystrokes go directly to Claude Code or
Codex. Their slash commands, cursor movement, copy/paste, interrupts, and
terminal UI continue to work normally.

## Keys

| Key | Action |
| --- | --- |
| `Enter` | Start the typed task, or focus the selected worker when the task input is empty |
| `Tab` / `Shift+Tab` | Cycle focus across agents, worker, and task panes |
| `Alt-1` / `Alt-2` / `Alt-3` | Focus agents, worker, or task directly |
| `Ctrl-G` | Toggle Rudder nav mode while focused inside a worker |
| `j` / `k` or arrows | Move through agents when the agents pane is focused |
| `/model` | Open the provider-first model picker |
| `/help` | Show the short command hint |
| `v` | Open the selected agent's Hunk review view |
| `m` | Merge the selected completed worktree |
| `M` | Merge all completed worktrees |
| `d` | Delete the selected agent; if its worktree has changes, Rudder asks you to merge or confirm discard |
| `q` | Quit when the worker is not consuming input |

Use `Ctrl-G` before a Rudder shortcut if the worker pane is focused and you want
the key handled by Rudder instead of by Claude Code or Codex.

## Models

Run `/model` in the task pane. Rudder first asks for the provider, then the
model, then the effort level supported by that model.

- Claude models include Claude Code aliases such as `sonnet`, `sonnet[1m]`,
  `opus`, `opus[1m]`, and `haiku`, plus explicit Claude model IDs when
  discovered.
- Codex models include Codex-relevant OpenAI model IDs such as `gpt-5.5`,
  `gpt-5.4-codex`, and other discovered GPT-5/Codex models.
- `auto` effort means Rudder does not pass an effort override.

Rudder refreshes model metadata from `https://models.dev/api.json` before the
dashboard starts and caches it in `~/.rudder/models-dev.json`. If the network is
unavailable, it falls back to local Claude session history and Codex's local
model cache.

## Agent Launch

Native dashboard workers launch the official CLIs directly.

Claude Code:

```bash
claude --permission-mode bypassPermissions --model <model> --effort <effort> "<task>"
```

Codex:

```bash
codex --ask-for-approval never --sandbox danger-full-access \
  -c model_reasoning_summary="detailed" \
  -c model_supports_reasoning_summaries=true \
  -c model_reasoning_effort="<effort>" \
  -m <model> "<task>"
```

The exact model and effort flags are omitted when set to `auto`.

## Worktrees And Merging

Every dashboard task runs in its own git worktree under
`~/.rudder-worktrees/...`, so parallel agents do not edit the same checkout.

Press `m` to merge the selected completed agent back into the original branch.
Press `M` to merge all completed agents. Rudder uses normal git merge semantics;
clean merges become merge commits, and conflicts are left in git's standard
conflict state for you to resolve.

Command-line equivalents:

```bash
rudder merge <runId>
rudder cleanup
```

## Steering

Before a task starts, Rudder writes `RUDDER.md` into the worktree and adds it to
`.gitignore` once. The file lists active agents, their worktrees, and what they
are doing. The worker prompt tells Claude Code or Codex to read it first.

After a worker appears to finish, Rudder can wait briefly and send a focused
follow-up asking the same agent to verify what remains. When an agent finishes
or fails, Rudder plays the bundled completion sound.

## Review

Press `v` on an agent to open Hunk against that agent's worktree:

```bash
hunk diff --watch
```

Hunk provides the multi-file review UI, sidebar navigation, mouse support,
watch mode, and untracked-file handling. If `hunk` is not installed, Rudder
installs it with `npm install -g hunkdiff@latest` before opening the review.

While focused in the review pane, keys go to Hunk. Press `Ctrl-G`, then `v`, to
return to the live Claude Code or Codex worker.

## One-Shot Commands

```bash
rudder "fix the failing tests"
rudder claude "fix the auth redirect bug"
rudder codex --model gpt-5.5 "refactor the parser"
rudder run --worktree "try the alternate implementation"
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

## Legacy Interfaces

The native dashboard is the default. Older interfaces are still available:

```bash
rudder tmux
rudder tui
rudder --no-native
```

## Development

```bash
git clone https://github.com/viraatdas/rudder.git
cd rudder
npm install
cargo test --manifest-path native/Cargo.toml
npm run check
npm run build
```
