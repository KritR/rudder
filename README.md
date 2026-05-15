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
rudder cloud
rudder cloud list
rudder cloud setup-vm
rudder cloud onload <runId>
rudder cloud migration-lab
rudder sail staging-worker
```

By default the CLI points at the hosted Rudder Cloud control plane:
`https://mpd2pmnpep.us-east-1.awsapprunner.com`. Set `RUDDER_CLOUD_URL` to
override it for local development or another deployment.

Inside the dashboard, `/login` starts browser auth, `/cloud list` lists cloud
workers after you are logged in, and `/cloud` starts a cloud worker with a
generated memorable name. `/cloud <name>` and `/sail <name>` start named cloud
workers. `/cloud help` shows the cloud command reference.

Cloud workers use Fly Machines by default. To bring your own workstation or
server instead, run:

```bash
rudder cloud setup-vm
```

After that, `rudder cloud <task>`, `/cloud <task>`, and `/sail <task>` prepare
a BYO VM run and print a Docker command. Run that command on your server to
download the encrypted snapshot, restore the selected HOME config, execute the
task, and report heartbeats back to Rudder Cloud. Use `rudder cloud setup-fly`
to switch future launches back to Fly, or `rudder cloud runtime [fly|byo-vm]`
to inspect or change the saved runtime. For one launch without changing the
default, use `rudder cloud vm "<task>"`.

`rudder login` connects this machine to Rudder Cloud by opening the browser for
the control plane's Better Auth login. If that browser login endpoint is
unavailable, Rudder falls back to local GitHub CLI auth and then GitHub's
browser device flow. It is separate from Claude Code and Codex login: provider
auth still belongs to the official CLIs unless you explicitly configure
otherwise.

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

Rudder owns mouse input inside the dashboard. Wheel or trackpad scrolling is
routed to the pane under the pointer. Over the worker or review pane, it scrolls
Rudder's captured pane output, not the underlying Claude Code, Codex, or Hunk
chat. Use the worker's up and down arrow keys when you want to move through the
agent's own prompt history or menus. Drag selection inside the worker pane
copies selected text, including when you drag upward past the top of the pane.
For full-screen alternate-screen workers, Rudder keeps its own pane history so
trackpad scrolling moves the pane instead of depending on the child app. If the
pane has no Rudder scrollback to move and the inner TUI has explicitly requested
mouse input, Rudder passes the wheel event through so Claude Code, Codex, Hunk,
or another full-screen app can scroll its own view.

## Dashboard Shortcuts

| Key | Action |
| --- | --- |
| `Enter` | Start the typed task, or focus the selected worker when the task input is empty |
| `Tab` / `Shift+Tab` | Cycle focus across agents, worker, and task panes |
| `Option-1` / `Option-2` / `Option-3` | Focus agents, worker, or task directly |
| `Ctrl-G` | Toggle Rudder nav mode while focused inside a worker |
| `Alt-v` | Toggle the selected agent's review view from any pane |
| `Shift+Enter` | Insert a new line in the focused worker prompt |
| `PageUp` / `PageDown` | Scroll the focused worker pane by roughly one page |
| `j` / `k` or arrows | Move through agents when the agents pane is focused |
| `Up` / `Down` | Browse task history when the task pane is focused |
| `Alt-Left` / `Alt-Right` | Move by word in the task pane and in supported worker prompts |
| `Alt-Backspace` / `Ctrl-W` | Delete the previous word in the task pane and in supported worker prompts |
| `Cmd-C` / `Meta-C` | Copy the active Rudder text selection without forwarding `c` to the worker |
| `Ctrl-C` | Leave Rudder from any pane |
| `v` | Toggle the selected agent's review view |
| `Esc` | Leave the review view when it is focused |
| `r` | Restart the selected stopped agent in its worktree |
| `m` | Merge the selected completed worktree |
| `M` | Merge all completed worktrees |
| `dd` | Delete the selected agent and remove its worktree; if it has changes, Rudder gives you a merge chance first |
| `q` | Quit when the worker is not consuming input |

## Task Pane Commands

Type `/` in the task pane to open command suggestions. Use `Up`/`Down` to move
through suggestions and `Enter` to choose one.

| Command | Action |
| --- | --- |
| `/model` | Open the provider-first model picker: choose Claude or Codex, then model, then effort when supported |
| `/plan` | Toggle Rudder's read-only plan mode for task pane submissions |
| `/plan <task>` | Start one read-only planning session without toggling plan mode |
| `/run <task>` | Start an implementation run even when plan mode is on |
| `/login` | Open browser login for Rudder Cloud |
| `/cloud` | Start a cloud worker with a generated name; requires `/login` first |
| `/cloud <name or task>` | Start a named cloud worker; with BYO VM runtime, use the argument as the task |
| `/cloud setup-vm` | Use your own VM for future cloud workers |
| `/cloud runtime [fly\|byo-vm]` | Show or set the saved cloud runtime |
| `/cloud list` | List cloud workers |
| `/cloud help` | Show cloud command help |
| `/sail <name or task>` | Short alias for starting a cloud worker |
| `/help` | Show the short command hint |

Use `Ctrl-G` before a Rudder shortcut if the worker pane is focused and you want
the key handled by Rudder instead of by Claude Code or Codex.

If trackpad scrolling does not behave as expected, run
`rudder mouse-test parsed` to confirm your terminal is sending `ScrollUp` and
`ScrollDown` events. For lower-level escape bytes, run `rudder mouse-test raw`.
To inspect live dashboard routing, start Rudder with `RUDDER_MOUSE_DEBUG=1`.
Rudder scrolls three terminal rows per wheel event by default, matching common
terminal scrollback behavior. Override with `RUDDER_WHEEL_SCROLL_ROWS=<n>` if
your terminal is configured differently.

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
CLAUDE_CODE_NO_FLICKER=0 claude \
  --permission-mode bypassPermissions \
  --model <model> \
  --effort <effort> "<task>"
```

Codex:

```bash
codex --no-alt-screen \
  --dangerously-bypass-approvals-and-sandbox \
  -c model_reasoning_summary="detailed" \
  -c model_supports_reasoning_summaries=true \
  -c model_reasoning_effort="<effort>" \
  -m <model> "<task>"
```

The exact model and effort flags are omitted when set to `auto`.

## Plan Mode

Type `/plan` to toggle planning on or off. While it is on, pressing `Enter`
starts a planner instead of an
implementation run. You can also use `/plan <task>` for a one-off plan, or
`/run <task>` to bypass plan mode and start a normal worktree agent.

Planning sessions use the currently selected Claude or Codex model and lean on
the backend's native planning/read-only controls:

- The planner runs in the current checkout instead of creating a worktree.
- Codex planners launch with `--sandbox read-only`, `--ask-for-approval never`,
  and `--search`, so filesystem writes are blocked and the native Responses
  `web_search` tool is available.
- Claude planners launch with Claude Code's native `--permission-mode plan`.
- Rudder only prefixes the task with a short planning request; it no longer
  injects a custom planner contract.
- Normal implementation runs are unchanged: they still create worktrees and use
  the full-permission worker launch described above.

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
keyboard input into Hunk while the review pane is focused and keeps wheel or
trackpad scrolling on Rudder's review scrollback. Press `v` or `Esc` to return
to the live Claude Code or Codex worker.

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
