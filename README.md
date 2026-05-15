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

Rudder leans into how coding agents should be used: massively parallel,
isolated, reviewable, and easy to merge. It opens a native three-pane dashboard,
creates an isolated git worktree for each task, and runs real Claude Code or
Codex processes in the worker pane.

Rudder Cloud lives behind `/login`, `/cloud`, and `/sail`. It keeps the same
local dashboard and worktree flow, with an optional Fly Machines worker path for
tasks that should continue away from your laptop.

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

## Rudder Cloud

Rudder Cloud is the hosted worker mode for Rudder. The local app remains the
control surface: you start in your repo, choose a task, and decide whether it
should run locally or be handed to a cloud worker.

```bash
rudder login
rudder cloud list
rudder cloud onload <runId>
rudder cloud "fix the long-running migration"
rudder sail "try the alternate parser"
```

By default the CLI points at the hosted Rudder Cloud control plane:
`https://mpd2pmnpep.us-east-1.awsapprunner.com`. Set `RUDDER_CLOUD_URL` to
override it for local development or another deployment.

Inside the dashboard, `/cloud` opens the cloud controls. `/sail` is a short
alias for starting a cloud worker. `/cloud <name>` also starts a cloud worker
for that task name.

`rudder login` connects this machine to Rudder Cloud. If GitHub CLI is already
authenticated, Rudder reuses it to issue a Rudder Cloud token. Otherwise it
falls back to GitHub's browser device flow. The control plane also supports
Better Auth with Google and GitHub providers once those OAuth clients are
configured. It is separate from Claude Code and Codex login: provider auth still
belongs to the official CLIs unless you explicitly configure otherwise.

Cloud admins can attach existing OAuth clients without redeploying the control
plane:

```bash
rudder cloud login
rudder cloud setup-github <github-client-id>
rudder cloud setup-google <google-client-id>
```

Both setup commands prompt for the client secret without echoing it and persist
the provider credentials into Rudder Cloud's S3-backed state. For automation,
use `RUDDER_GITHUB_CLIENT_ID`, `RUDDER_GITHUB_CLIENT_SECRET`,
`RUDDER_GOOGLE_CLIENT_ID`, and `RUDDER_GOOGLE_CLIENT_SECRET`.

`rudder cloud list` will show cloud-capable runs and remote workers. `rudder
cloud onload <runId>` will move a local run to the cloud so it can continue from
the same task context.

Cloud onload is designed around Rudder's existing worktree model. If a task is
already in a worktree, that worktree is the unit Rudder prepares for the cloud.
If a task is still in the main checkout, Rudder prepares a worktree first so the
cloud run does not mutate your local branch directly. Completed cloud work comes
back through the same review and merge path as local work.

Rudder includes selected HOME config paths in the launch snapshot so cloud
workers can behave like your local environment where that is useful: Claude,
Codex, GitHub CLI, git config, npm, Vercel, and Hunk config are considered. It
filters obvious high-risk material such as AWS credentials, `.env` files, SSH
keys, Docker auth, kube config, and private key directories.

The cloud control plane code lives in `cloud/`. It uses Better Auth for
Google/GitHub login, stores launch snapshots in an encrypted S3 bucket, and
starts Fly Machines workers with one-hour presigned snapshot URLs. The local CLI
package stays small; cloud state and worker orchestration run in the separate
control plane.

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
Codex. Their slash commands, cursor movement, copy/paste, and terminal UI
continue to work normally. `Ctrl-C` is reserved by Rudder and leaves the
dashboard from any pane.

## Keys

| Key | Action |
| --- | --- |
| `Enter` | Start the typed task, or focus the selected worker when the task input is empty |
| `Tab` / `Shift+Tab` | Cycle focus across agents, worker, and task panes |
| `Alt-1` / `Alt-2` / `Alt-3` | Focus agents, worker, or task directly |
| `Ctrl-G` | Toggle Rudder nav mode while focused inside a worker |
| `Shift+Enter` | Insert a new line in the focused worker prompt |
| `PageUp` / `PageDown` | Scroll the focused worker pane by roughly one page |
| `j` / `k` or arrows | Move through agents when the agents pane is focused |
| `Ctrl-C` | Leave Rudder from any pane |
| `/model` | Open the provider-first model picker |
| `/help` | Show the short command hint |
| `v` | Toggle the selected agent's review view |
| `Esc` | Leave the review view when it is focused |
| `r` | Restart the selected stopped agent in its worktree |
| `m` | Merge the selected completed worktree |
| `M` | Merge all completed worktrees |
| `dd` | Delete the selected agent and remove its worktree; if it has changes, Rudder gives you a merge chance first |
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

Rudder saves the last selected provider and model, plus effort when chosen, in
`~/.rudder/config.json`, so the same defaults are used when you open a new
dashboard or shell session.

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
Run records are saved under `.rudder/runs/`. If you exit Rudder, live worker
processes stop, but the agents remain listed next time you open Rudder in the
same repo. Select one and press `r` to restart it manually in the same worktree.

Press `m` to merge the selected completed agent back into the original branch.
Press `M` to merge all completed agents. Rudder asks for confirmation before
merging. Clean merges become merge commits; if git reports conflicts, Rudder can
open an agent in the main checkout to help resolve them.

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

Press `v` on an agent to toggle a review view for that agent's worktree:

```bash
hunk diff --watch
```

Hunk provides the multi-file review UI, sidebar navigation, mouse support,
watch mode, inline agent notes, and untracked-file handling. Rudder forwards
keyboard and accelerated mouse-wheel input into Hunk while the review pane is
focused. Press `v` or `Esc` to return to the live Claude Code or Codex worker.

Rudder writes a per-worktree `.hunk/config.toml` in Hunk's light mode and
ignores that config through git's local info exclude, so it does not get merged.
Set `RUDDER_HUNK_THEME=paper` or another Hunk theme name to override it.

On dashboard startup, Rudder installs `hunkdiff@latest` automatically if neither
`hunk` nor `hunkdiff` is available. If the install fails, or if you set
`RUDDER_REVIEW_TOOL=git`, the review pane falls back to a live `git diff` view
instead of downloading anything when you first press `v`.

Rudder also injects Hunk review guidance into `RUDDER.md` and the worker prompt.
Agents are told to run `hunk skill path`, load the Hunk review skill, and use
`hunk session review --repo . --json` plus `hunk session comment ...` commands
against the live review.

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
