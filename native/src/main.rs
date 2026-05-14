use std::{
    collections::HashSet,
    fs,
    hash::{Hash, Hasher},
    io::{self, Stdout},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::{Duration, Instant},
    time::{SystemTime, UNIX_EPOCH},
};

use anyhow::{Context, Result};
use crossterm::{
    event::{
        self, DisableMouseCapture, EnableMouseCapture, Event, KeyCode, KeyEvent, KeyEventKind,
        KeyModifiers, KeyboardEnhancementFlags, MouseButton, MouseEvent, MouseEventKind,
        PopKeyboardEnhancementFlags, PushKeyboardEnhancementFlags,
    },
    execute,
    terminal::{disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen},
};
use ratatui::{
    backend::CrosstermBackend,
    layout::{Constraint, Direction, Layout, Rect},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Clear, List, ListItem, Paragraph, Wrap},
    Frame, Terminal,
};
use rudder_native::pty_terminal::{
    StyledTerminalCell, TerminalCommand, TerminalPane, TerminalPaneOptions, TerminalSize,
};

type Tui = Terminal<CrosstermBackend<Stdout>>;

const TICK_RATE: Duration = Duration::from_millis(50);
const AUTO_STEER_DELAY: Duration = Duration::from_secs(10);
const INTERACTIVE_COMPLETION_IDLE: Duration = Duration::from_secs(4);
const FOCUS_COLOR: Color = Color::Rgb(57, 255, 20);
const INACTIVE_COLOR: Color = Color::DarkGray;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum FocusPane {
    Agents,
    Worker,
    Task,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum WorkerView {
    Terminal,
    Diff,
}

impl FocusPane {
    fn next(self) -> Self {
        match self {
            Self::Agents => Self::Worker,
            Self::Worker => Self::Task,
            Self::Task => Self::Agents,
        }
    }

    fn previous(self) -> Self {
        match self {
            Self::Agents => Self::Task,
            Self::Worker => Self::Agents,
            Self::Task => Self::Worker,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Backend {
    Claude,
    Codex,
}

impl Backend {
    fn as_str(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum EffortLevel {
    Low,
    Medium,
    High,
    XHigh,
    Max,
}

impl EffortLevel {
    fn as_str(self) -> &'static str {
        match self {
            Self::Low => "low",
            Self::Medium => "medium",
            Self::High => "high",
            Self::XHigh => "xhigh",
            Self::Max => "max",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        match value.to_ascii_lowercase().as_str() {
            "low" => Some(Self::Low),
            "medium" => Some(Self::Medium),
            "high" => Some(Self::High),
            "xhigh" => Some(Self::XHigh),
            "max" => Some(Self::Max),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum AgentStatus {
    Running,
    Done,
    Failed,
}

impl AgentStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Done => "done",
            Self::Failed => "failed",
        }
    }
}

struct App {
    focus: FocusPane,
    nav_mode: bool,
    worker_view: WorkerView,
    cwd: PathBuf,
    branch: Option<String>,
    task_input: String,
    task_cursor: usize,
    agents: Vec<AgentRun>,
    selected_agent: usize,
    backend: Backend,
    model: String,
    effort: Option<EffortLevel>,
    notice: Option<String>,
    delete_pending: Option<String>,
    picker_index: usize,
    agents_area: Option<Rect>,
    worker_area: Option<Rect>,
    task_area: Option<Rect>,
}

struct AgentRun {
    id: String,
    task: String,
    backend: Backend,
    model: String,
    effort: Option<EffortLevel>,
    status: AgentStatus,
    cwd: PathBuf,
    worktree_branch: Option<String>,
    worktree_path: Option<PathBuf>,
    terminal: Option<TerminalPane>,
    terminal_size: Option<TerminalSize>,
    review_terminal: Option<TerminalPane>,
    review_size: Option<TerminalSize>,
    review_error: Option<String>,
    last_output_at: Instant,
    completed_at: Option<Instant>,
    autosteered: bool,
    needs_permission: bool,
    permission_notified: bool,
    last_error: Option<String>,
}

#[derive(Clone)]
struct Suggestion {
    label: String,
    detail: String,
    action: SuggestionAction,
}

#[derive(Clone)]
enum SuggestionAction {
    Insert(String),
    ChooseModelProvider(Backend),
    ChooseModel {
        backend: Backend,
        model: String,
    },
    SetModel {
        backend: Backend,
        model: String,
        effort: Option<EffortLevel>,
    },
    ShowHelp,
}

impl App {
    fn new() -> Self {
        let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
        Self {
            focus: FocusPane::Task,
            nav_mode: false,
            worker_view: WorkerView::Terminal,
            cwd,
            branch: current_branch(),
            task_input: String::new(),
            task_cursor: 0,
            agents: Vec::new(),
            selected_agent: 0,
            backend: Backend::Claude,
            model: default_model_for(Backend::Claude).to_string(),
            effort: default_effort_for(Backend::Claude, default_model_for(Backend::Claude)),
            notice: None,
            delete_pending: None,
            picker_index: 0,
            agents_area: None,
            worker_area: None,
            task_area: None,
        }
    }

    fn handle_key(&mut self, key: KeyEvent) -> bool {
        if key.modifiers.contains(KeyModifiers::CONTROL) && key.code == KeyCode::Char('g') {
            self.nav_mode = !self.nav_mode;
            self.notice = Some(if self.nav_mode {
                "nav mode: 1 agents  2 worker  3 task  v review  Esc exits".to_string()
            } else {
                "worker input restored".to_string()
            });
            return false;
        }

        if self.nav_mode {
            return self.handle_nav_key(key);
        }

        if key
            .modifiers
            .intersects(KeyModifiers::ALT | KeyModifiers::META)
        {
            match key.code {
                KeyCode::Char('1') => {
                    self.focus = FocusPane::Agents;
                    return false;
                }
                KeyCode::Char('2') => {
                    self.focus = FocusPane::Worker;
                    return false;
                }
                KeyCode::Char('3') => {
                    self.focus = FocusPane::Task;
                    return false;
                }
                KeyCode::Char('v') => {
                    self.toggle_worker_view();
                    return false;
                }
                _ => {}
            }
        }

        let worker_has_terminal = self.focus == FocusPane::Worker
            && self
                .agents
                .get(self.selected_agent)
                .and_then(|run| run.terminal.as_ref())
                .is_some();
        if !worker_has_terminal
            && key.modifiers.contains(KeyModifiers::CONTROL)
            && key.code == KeyCode::Char('c')
        {
            return true;
        }

        match key.code {
            KeyCode::Tab => {
                self.focus = self.focus.next();
                return false;
            }
            KeyCode::BackTab => {
                self.focus = self.focus.previous();
                return false;
            }
            _ => {}
        }

        match self.focus {
            FocusPane::Agents => self.handle_agents_key(key),
            FocusPane::Worker => self.handle_worker_key(key),
            FocusPane::Task => self.handle_task_key(key),
        }
    }

    fn handle_nav_key(&mut self, key: KeyEvent) -> bool {
        match key.code {
            KeyCode::Esc => {
                self.nav_mode = false;
                self.notice = Some("worker input restored".to_string());
            }
            KeyCode::Tab => self.focus = self.focus.next(),
            KeyCode::BackTab => self.focus = self.focus.previous(),
            KeyCode::Char('1') => self.focus = FocusPane::Agents,
            KeyCode::Char('2') => self.focus = FocusPane::Worker,
            KeyCode::Char('3') => self.focus = FocusPane::Task,
            KeyCode::Char('v') => self.toggle_worker_view(),
            KeyCode::Up | KeyCode::Char('k') => self.select_previous_agent(),
            KeyCode::Down | KeyCode::Char('j') => self.select_next_agent(),
            KeyCode::Char('m') => self.merge_selected_agent(),
            KeyCode::Char('M') => self.merge_all_ready(),
            KeyCode::Char('d') => self.delete_selected_agent(),
            KeyCode::Char('q') => return true,
            _ => {}
        }
        false
    }

    fn handle_agents_key(&mut self, key: KeyEvent) -> bool {
        match key.code {
            KeyCode::Char('q') => return true,
            KeyCode::Up | KeyCode::Char('k') => self.select_previous_agent(),
            KeyCode::Down | KeyCode::Char('j') => self.select_next_agent(),
            KeyCode::Enter => {
                if !self.agents.is_empty() {
                    self.focus = FocusPane::Worker;
                }
            }
            KeyCode::Char('v') => self.toggle_worker_view(),
            KeyCode::Char('M') => self.merge_all_ready(),
            KeyCode::Char('m') => self.merge_selected_agent(),
            KeyCode::Char('d') => self.delete_selected_agent(),
            _ => {}
        }
        false
    }

    fn handle_worker_key(&mut self, key: KeyEvent) -> bool {
        if self.worker_view == WorkerView::Diff {
            if self.selected_review_terminal_mut().is_none() {
                match key.code {
                    KeyCode::Esc | KeyCode::Char('v') => self.worker_view = WorkerView::Terminal,
                    KeyCode::Char('m') => self.merge_selected_agent(),
                    _ => {}
                }
                return false;
            }

            if let Some(bytes) = terminal_bytes_for_key(key) {
                if let Some(review) = self.selected_review_terminal_mut() {
                    if let Err(error) = review.write_input(&bytes) {
                        self.set_selected_review_error(error.to_string());
                    }
                }
            }
            return false;
        }

        if key.code == KeyCode::Char('q') && self.selected_terminal_mut().is_none() {
            return true;
        }

        let Some(terminal) = self.selected_terminal_mut() else {
            return false;
        };

        if let Some(bytes) = terminal_bytes_for_key(key) {
            if let Err(error) = terminal.write_input(&bytes) {
                self.set_selected_error(error.to_string());
            }
        }
        false
    }

    fn select_previous_agent(&mut self) {
        self.selected_agent = self.selected_agent.saturating_sub(1);
    }

    fn select_next_agent(&mut self) {
        let last = self.agents.len().saturating_sub(1);
        self.selected_agent = (self.selected_agent + 1).min(last);
    }

    fn toggle_worker_view(&mut self) {
        self.worker_view = match self.worker_view {
            WorkerView::Terminal => {
                self.ensure_hunk_review();
                WorkerView::Diff
            }
            WorkerView::Diff => WorkerView::Terminal,
        };
        self.focus = FocusPane::Worker;
    }

    fn handle_task_key(&mut self, key: KeyEvent) -> bool {
        if self.handle_picker_key(key) {
            return false;
        }

        match key.code {
            KeyCode::Esc => {
                self.task_input.clear();
                self.task_cursor = 0;
                self.picker_index = 0;
            }
            KeyCode::Enter => self.start_task(),
            KeyCode::Backspace => {
                if key.modifiers.intersects(
                    KeyModifiers::ALT
                        | KeyModifiers::CONTROL
                        | KeyModifiers::SUPER
                        | KeyModifiers::META,
                ) {
                    delete_previous_word_at(&mut self.task_input, &mut self.task_cursor);
                } else {
                    delete_char_before_cursor(&mut self.task_input, &mut self.task_cursor);
                }
                self.clamp_picker_index();
            }
            KeyCode::Delete => {
                delete_char_at_cursor(&mut self.task_input, self.task_cursor);
                self.clamp_picker_index();
            }
            KeyCode::Left => {
                if key
                    .modifiers
                    .intersects(KeyModifiers::ALT | KeyModifiers::META)
                {
                    self.task_cursor = previous_word_position(&self.task_input, self.task_cursor);
                } else {
                    self.task_cursor = self.task_cursor.saturating_sub(1);
                }
            }
            KeyCode::Right => {
                let len = self.task_input.chars().count();
                if key
                    .modifiers
                    .intersects(KeyModifiers::ALT | KeyModifiers::META)
                {
                    self.task_cursor = next_word_position(&self.task_input, self.task_cursor);
                } else {
                    self.task_cursor = (self.task_cursor + 1).min(len);
                }
            }
            KeyCode::Home => {
                self.task_cursor = 0;
            }
            KeyCode::End => {
                self.task_cursor = self.task_input.chars().count();
            }
            KeyCode::Char('u') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                self.task_input.clear();
                self.task_cursor = 0;
                self.picker_index = 0;
            }
            KeyCode::Char('w') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                delete_previous_word_at(&mut self.task_input, &mut self.task_cursor);
                self.clamp_picker_index();
            }
            KeyCode::Char('/') if self.task_input.is_empty() => {
                self.task_input.push('/');
                self.task_cursor = 1;
                self.picker_index = 0;
                self.notice = Some("type /model".to_string());
            }
            KeyCode::Char(ch) => {
                insert_char_at_cursor(&mut self.task_input, &mut self.task_cursor, ch);
                self.clamp_picker_index();
            }
            _ => {}
        }
        false
    }

    fn handle_picker_key(&mut self, key: KeyEvent) -> bool {
        let suggestions = suggestions_for(self);
        if suggestions.is_empty() {
            return false;
        }

        match key.code {
            KeyCode::Up => {
                self.picker_index = self.picker_index.saturating_sub(1);
                true
            }
            KeyCode::Down => {
                self.picker_index =
                    (self.picker_index + 1).min(suggestions.len().saturating_sub(1));
                true
            }
            KeyCode::Enter => {
                let selected = suggestions
                    .get(self.picker_index.min(suggestions.len().saturating_sub(1)))
                    .cloned();
                drop(suggestions);
                if let Some(selected) = selected {
                    self.apply_suggestion(selected);
                }
                true
            }
            _ => false,
        }
    }

    fn apply_suggestion(&mut self, suggestion: Suggestion) {
        match suggestion.action {
            SuggestionAction::Insert(value) => {
                self.task_input = value;
                self.task_cursor = self.task_input.chars().count();
                self.picker_index = 0;
            }
            SuggestionAction::ChooseModelProvider(backend) => {
                self.task_input = format!("/model {} ", backend.as_str());
                self.task_cursor = self.task_input.chars().count();
                self.picker_index = 0;
                self.notice = Some(format!("pick a {} model", backend.as_str()));
            }
            SuggestionAction::ChooseModel { backend, model } => {
                self.task_input = format!("/model {} {} ", backend.as_str(), model);
                self.task_cursor = self.task_input.chars().count();
                self.picker_index = 0;
                self.notice = Some(format!("pick effort for {model}"));
            }
            SuggestionAction::SetModel {
                backend,
                model,
                effort,
            } => {
                self.backend = backend;
                self.model = model;
                self.effort = effort;
                self.task_input.clear();
                self.task_cursor = 0;
                self.picker_index = 0;
                self.notice = Some(format!(
                    "{} {}({})",
                    self.backend.as_str(),
                    self.model,
                    effort_label(self.effort)
                ));
            }
            SuggestionAction::ShowHelp => {
                self.task_input.clear();
                self.task_cursor = 0;
                self.picker_index = 0;
                self.notice =
                    Some("Tab focus  Enter start/focus  m merge  M merge all  d del".to_string());
            }
        }
    }

    fn clamp_picker_index(&mut self) {
        let len = suggestions_for(self).len();
        if len == 0 {
            self.picker_index = 0;
        } else {
            self.picker_index = self.picker_index.min(len - 1);
        }
    }

    fn handle_paste(&mut self, text: String) {
        match self.focus {
            FocusPane::Worker => {
                if self.worker_view == WorkerView::Diff {
                    if let Some(terminal) = self.selected_review_terminal_mut() {
                        if let Err(error) = terminal.write_input(text.as_bytes()) {
                            self.set_selected_review_error(error.to_string());
                        }
                    }
                } else if let Some(terminal) = self.selected_terminal_mut() {
                    if let Err(error) = terminal.write_input(text.as_bytes()) {
                        self.set_selected_error(error.to_string());
                    }
                }
            }
            FocusPane::Task => {
                insert_str_at_cursor(&mut self.task_input, &mut self.task_cursor, &text);
                self.clamp_picker_index();
            }
            FocusPane::Agents => {}
        }
    }

    fn handle_mouse(&mut self, mouse: MouseEvent) {
        if self
            .worker_area
            .is_some_and(|area| rect_contains(area, mouse.column, mouse.row))
            && self.worker_view == WorkerView::Diff
        {
            self.focus = FocusPane::Worker;
            if let Some(worker_area) = self.worker_area {
                let inner = block_inner(worker_area);
                if let Some(bytes) = mouse_event_to_sgr(mouse, inner) {
                    if let Some(review) = self.selected_review_terminal_mut() {
                        if let Err(error) = review.write_input(&bytes) {
                            self.set_selected_review_error(error.to_string());
                        }
                    }
                }
            }
            return;
        }

        let delta = match mouse.kind {
            MouseEventKind::ScrollUp => -3,
            MouseEventKind::ScrollDown => 3,
            MouseEventKind::ScrollLeft | MouseEventKind::ScrollRight => return,
            _ => return,
        };

        if self
            .agents_area
            .is_some_and(|area| rect_contains(area, mouse.column, mouse.row))
        {
            if delta < 0 {
                self.select_previous_agent();
            } else {
                self.select_next_agent();
            }
            return;
        }

        if self
            .worker_area
            .is_some_and(|area| rect_contains(area, mouse.column, mouse.row))
        {
            self.focus = FocusPane::Worker;
            match self.worker_view {
                WorkerView::Diff => self.scroll_review(delta),
                WorkerView::Terminal => self.scroll_worker(delta),
            }
        }
    }

    fn scroll_worker(&mut self, delta: isize) {
        if let Some(terminal) = self.selected_terminal_mut() {
            terminal.scrollback_by(-delta);
        }
    }

    fn scroll_review(&mut self, delta: isize) {
        if let Some(terminal) = self.selected_review_terminal_mut() {
            terminal.scrollback_by(-delta);
        }
    }

    fn start_task(&mut self) {
        let input = self.task_input.trim().to_string();
        if input.is_empty() {
            return;
        }
        self.task_input.clear();
        self.task_cursor = 0;

        if self.handle_command(&input) {
            return;
        }

        let worktree = match prepare_worktree(&self.cwd, &input) {
            Ok(worktree) => worktree,
            Err(error) => {
                self.notice = Some(format!("worktree failed: {error}"));
                WorktreeInfo::current(self.cwd.clone())
            }
        };
        if let Err(error) = write_rudder_context(&self.cwd, &self.agents, Some(&worktree)) {
            self.notice = Some(format!("context warning: {error}"));
        }
        if let Err(error) = ensure_hunk_config(&worktree.path) {
            self.notice = Some(format!("hunk config warning: {error}"));
        }

        let model = self.model.clone();
        let backend = self.backend;
        let effort = self.effort;
        let command = agent_command(backend, &model, effort, &input);
        let options = TerminalPaneOptions {
            size: TerminalSize::default(),
            cwd: Some(worktree.path.clone()),
            ..TerminalPaneOptions::default()
        };

        let mut run = AgentRun {
            id: worktree.id.clone(),
            task: input.clone(),
            backend,
            model,
            effort,
            status: AgentStatus::Running,
            cwd: worktree.path.clone(),
            worktree_branch: worktree.branch.clone(),
            worktree_path: worktree.path_is_worktree.then_some(worktree.path.clone()),
            terminal: None,
            terminal_size: None,
            review_terminal: None,
            review_size: None,
            review_error: None,
            last_output_at: Instant::now(),
            completed_at: None,
            autosteered: false,
            needs_permission: false,
            permission_notified: false,
            last_error: None,
        };

        match TerminalPane::spawn_shell_or_command(Some(command), options) {
            Ok(mut terminal) => {
                let _ = terminal.drain_output();
                run.terminal = Some(terminal);
                self.notice = Some(format!("started {}", short_task(&input)));
            }
            Err(error) => {
                run.status = AgentStatus::Failed;
                run.last_error = Some(error.to_string());
                self.notice = Some(format!("failed to start {}: {error}", backend.as_str()));
            }
        }

        self.agents.push(run);
        self.selected_agent = self.agents.len().saturating_sub(1);
        self.delete_pending = None;
        self.focus = FocusPane::Worker;
        let _ = write_rudder_context(&self.cwd, &self.agents, None);
    }

    fn handle_command(&mut self, input: &str) -> bool {
        let mut parts = input.split_whitespace();
        match parts.next() {
            Some("/model") => {
                let args = parts.collect::<Vec<_>>();
                match args.as_slice() {
                    [] => {
                        self.notice =
                            Some("usage: /model claude|codex <model> [effort]".to_string());
                    }
                    [provider] if provider_backend(provider).is_some() => {
                        self.notice = Some(format!("usage: /model {provider} <model> [effort]"));
                    }
                    [provider, model] if provider_backend(provider).is_some() => {
                        let backend = provider_backend(provider).unwrap();
                        self.backend = backend;
                        self.model = (*model).to_string();
                        self.effort = default_effort_for(backend, model);
                        self.notice = Some(format!(
                            "{} {}({})",
                            self.backend.as_str(),
                            self.model,
                            effort_label(self.effort)
                        ));
                    }
                    [provider, model, effort, ..] if provider_backend(provider).is_some() => {
                        let backend = provider_backend(provider).unwrap();
                        let parsed_effort = parse_effort_arg(effort);
                        self.backend = backend;
                        self.model = (*model).to_string();
                        self.effort = parsed_effort;
                        self.notice = Some(format!(
                            "{} {}({})",
                            self.backend.as_str(),
                            self.model,
                            effort_label(self.effort)
                        ));
                    }
                    _ => {
                        let model = args.join(" ");
                        self.backend = backend_for_model(&model);
                        self.model = model;
                        self.effort = default_effort_for(self.backend, &self.model);
                        self.notice = Some(format!(
                            "{} {}({})",
                            self.backend.as_str(),
                            self.model,
                            effort_label(self.effort)
                        ));
                    }
                }
                true
            }
            Some("/help") => {
                self.notice =
                    Some("Tab focus  Enter start/focus  /model  m/M merge  d delete".to_string());
                true
            }
            _ => false,
        }
    }

    fn selected_terminal_mut(&mut self) -> Option<&mut TerminalPane> {
        self.agents
            .get_mut(self.selected_agent)
            .and_then(|run| run.terminal.as_mut())
    }

    fn selected_review_terminal_mut(&mut self) -> Option<&mut TerminalPane> {
        self.agents
            .get_mut(self.selected_agent)
            .and_then(|run| run.review_terminal.as_mut())
    }

    fn set_selected_error(&mut self, message: String) {
        if let Some(run) = self.agents.get_mut(self.selected_agent) {
            run.status = AgentStatus::Failed;
            run.last_error = Some(message);
        }
    }

    fn set_selected_review_error(&mut self, message: String) {
        if let Some(run) = self.agents.get_mut(self.selected_agent) {
            run.review_error = Some(message);
        }
    }

    fn ensure_hunk_review(&mut self) {
        let Some(run) = self.agents.get_mut(self.selected_agent) else {
            return;
        };
        if run.review_terminal.is_some() {
            return;
        }

        let command = TerminalCommand::with_args(
            "sh",
            [
                "-lc",
                "if command -v hunk >/dev/null 2>&1; then exec hunk diff --watch; fi; if command -v hunkdiff >/dev/null 2>&1; then exec hunkdiff diff --watch; fi; exec npx --yes hunkdiff@latest diff --watch",
            ],
        );
        if let Err(error) = ensure_hunk_config(&run.cwd) {
            run.review_error = Some(error.to_string());
            self.notice = Some(format!("hunk config warning: {error}"));
        }
        let options = TerminalPaneOptions {
            size: run.terminal_size.unwrap_or_default(),
            cwd: Some(run.cwd.clone()),
            ..TerminalPaneOptions::default()
        };

        match TerminalPane::spawn_shell_or_command(Some(command), options) {
            Ok(mut terminal) => {
                let _ = terminal.drain_output();
                run.review_terminal = Some(terminal);
                run.review_error = None;
                self.notice =
                    Some("opening Hunk review; first run may download hunkdiff".to_string());
            }
            Err(error) => {
                run.review_error = Some(error.to_string());
                self.notice = Some(format!("failed to open Hunk: {error}"));
            }
        }
    }

    fn delete_selected_agent(&mut self) {
        if self.agents.is_empty() {
            return;
        }
        let selected = &self.agents[self.selected_agent];
        if selected.worktree_path.is_some()
            && has_git_changes(&selected.cwd)
            && self.delete_pending.as_deref() != Some(&selected.id)
        {
            self.delete_pending = Some(selected.id.clone());
            self.notice =
                Some("worktree has changes: press m to merge, or d again to delete".to_string());
            return;
        }

        let run = self.agents.remove(self.selected_agent);
        if let Some(path) = run.worktree_path {
            let _ = Command::new("git")
                .args(["worktree", "remove", "--force"])
                .arg(&path)
                .current_dir(&self.cwd)
                .output();
        }
        let last = self.agents.len().saturating_sub(1);
        self.selected_agent = self.selected_agent.min(last);
        self.delete_pending = None;
        self.notice = Some("deleted agent from dashboard".to_string());
        let _ = write_rudder_context(&self.cwd, &self.agents, None);
    }

    fn merge_selected_agent(&mut self) {
        if self.agents.get(self.selected_agent).is_none() {
            return;
        }
        match self.merge_agent_at(self.selected_agent) {
            Ok(()) => {
                self.delete_pending = None;
                self.notice = Some("merged selected worktree".to_string());
            }
            Err(error) => self.notice = Some(format!("merge stopped: {error}")),
        }
    }

    fn merge_all_ready(&mut self) {
        let ready = self
            .agents
            .iter()
            .enumerate()
            .filter(|(_, run)| run.status == AgentStatus::Done && run.worktree_branch.is_some())
            .map(|(index, _)| index)
            .collect::<Vec<_>>();

        if ready.is_empty() {
            self.notice = Some("no completed worktrees ready to merge".to_string());
            return;
        }

        let mut merged = 0;
        for index in ready {
            if let Err(error) = self.merge_agent_at(index) {
                self.notice = Some(format!("merge all stopped after {merged}: {error}"));
                return;
            }
            merged += 1;
        }
        self.delete_pending = None;
        self.notice = Some(format!(
            "merged {merged} worktree{}",
            if merged == 1 { "" } else { "s" }
        ));
    }

    fn merge_agent_at(&mut self, index: usize) -> Result<()> {
        let Some(run) = self.agents.get(index) else {
            anyhow::bail!("no selected agent");
        };
        let Some(branch) = run.worktree_branch.clone() else {
            anyhow::bail!("selected agent is not in a worktree");
        };
        let cwd = run.cwd.clone();
        let task = run.task.clone();
        let worktree_path = run.worktree_path.clone();

        if has_git_changes(&cwd) {
            git_status_command(&cwd, &["add", "-A"])?;
            let message = format!("rudder: {}", short_task(&task));
            let _ = git_status_command(&cwd, &["commit", "-m", &message]);
        }

        git_status_command(&self.cwd, &["merge", "--no-ff", &branch])?;
        if let Some(path) = worktree_path {
            let _ = Command::new("git")
                .args(["worktree", "remove", "--force"])
                .arg(path)
                .current_dir(&self.cwd)
                .output();
        }
        if let Some(run) = self.agents.get_mut(index) {
            run.worktree_path = None;
            run.worktree_branch = None;
        }
        Ok(())
    }

    fn poll_agents(&mut self) {
        for run in &mut self.agents {
            let Some(terminal) = run.terminal.as_mut() else {
                continue;
            };
            let had_output = !terminal.drain_output().is_empty();
            if had_output {
                run.last_output_at = Instant::now();
                if run.status == AgentStatus::Done {
                    run.status = AgentStatus::Running;
                    run.completed_at = None;
                }
            }
            if run.status == AgentStatus::Running {
                let needs_permission = terminal_needs_permission(run.backend, terminal);
                run.needs_permission = needs_permission;
                if needs_permission {
                    if !run.permission_notified {
                        play_completion_sound();
                    }
                    run.permission_notified = true;
                } else {
                    run.permission_notified = false;
                }
                match terminal.try_wait() {
                    Ok(Some(status)) => {
                        if status.success() {
                            mark_run_done(run);
                        } else {
                            run.status = AgentStatus::Failed;
                            run.completed_at = Some(Instant::now());
                            run.needs_permission = false;
                            run.permission_notified = false;
                            play_completion_sound();
                        };
                    }
                    Ok(None) => {
                        if run.last_output_at.elapsed() >= INTERACTIVE_COMPLETION_IDLE
                            && terminal_looks_ready_for_input(run.backend, terminal)
                        {
                            mark_run_done(run);
                        }
                    }
                    Err(error) => {
                        run.status = AgentStatus::Failed;
                        run.completed_at = Some(Instant::now());
                        run.last_error = Some(error.to_string());
                        run.needs_permission = false;
                        run.permission_notified = false;
                        play_completion_sound();
                    }
                }
            } else {
                run.needs_permission = false;
                run.permission_notified = false;
            }
        }

        for run in &mut self.agents {
            if run.status != AgentStatus::Done || run.autosteered {
                continue;
            }
            let Some(completed_at) = run.completed_at else {
                continue;
            };
            if completed_at.elapsed() < AUTO_STEER_DELAY || !has_git_changes(&run.cwd) {
                continue;
            }

            let prompt = format!(
                "Read RUDDER.md first. Review the current diff and tests for this original task: {}. If anything remains, fix it and run the relevant checks. If it is complete, say what you verified.",
                run.task
            );
            let command = agent_command(run.backend, &run.model, run.effort, &prompt);
            let size = run.terminal_size.unwrap_or_default();
            let options = TerminalPaneOptions {
                size,
                cwd: Some(run.cwd.clone()),
                ..TerminalPaneOptions::default()
            };
            match TerminalPane::spawn_shell_or_command(Some(command), options) {
                Ok(terminal) => {
                    run.terminal = Some(terminal);
                    run.status = AgentStatus::Running;
                    run.autosteered = true;
                    run.completed_at = None;
                    run.needs_permission = false;
                    run.permission_notified = false;
                    run.last_error = None;
                    self.notice = Some(format!("auto-steering {}", short_task(&run.task)));
                }
                Err(error) => {
                    run.status = AgentStatus::Failed;
                    run.last_error = Some(error.to_string());
                }
            }
        }
    }
}

fn mark_run_done(run: &mut AgentRun) {
    if run.status != AgentStatus::Done {
        run.status = AgentStatus::Done;
        run.completed_at = Some(Instant::now());
        run.needs_permission = false;
        run.permission_notified = false;
        play_completion_sound();
    }
}

fn terminal_looks_ready_for_input(backend: Backend, terminal: &mut TerminalPane) -> bool {
    if terminal_needs_permission(backend, terminal) {
        return false;
    }

    let lines = terminal.visible_lines();
    let recent = lines
        .iter()
        .rev()
        .take(8)
        .map(|line| line.trim())
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>();

    if recent.iter().any(|line| looks_busy(line)) {
        return false;
    }

    recent
        .iter()
        .any(|line| looks_like_agent_prompt(backend, line))
}

fn terminal_needs_permission(_backend: Backend, terminal: &mut TerminalPane) -> bool {
    let lines = terminal.visible_lines();
    let recent = lines
        .iter()
        .rev()
        .take(14)
        .map(|line| normalize_terminal_line(line))
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>();
    if recent.is_empty() {
        return false;
    }
    let text = recent.iter().rev().cloned().collect::<Vec<_>>().join("\n");

    permission_text_needs_attention(&text)
}

fn permission_text_needs_attention(text: &str) -> bool {
    let text = text.to_ascii_lowercase();
    let text = text.as_str();

    let has_permission_word = contains_any_word(
        &text,
        &[
            "permission",
            "approval",
            "approve",
            "allow",
            "authorize",
            "authorization",
            "confirmation",
            "proceed",
            "deny",
        ],
    );
    if !has_permission_word {
        return false;
    }

    let asks_decision =
        contains_any_phrase(&text, &["do you want", "would you like", "are you sure"])
            && contains_any_word(
                &text,
                &["allow", "approve", "run", "execute", "continue", "proceed"],
            );
    let approves_action = contains_any_word(&text, &["allow", "approve", "authorize"])
        && contains_any_word(
            &text,
            &[
                "command",
                "tool",
                "edit",
                "write",
                "file",
                "access",
                "execution",
                "network",
                "shell",
                "operation",
            ],
        );
    let approval_request = contains_any_word(
        &text,
        &["permission", "approval", "authorization", "confirmation"],
    ) && contains_any_word(
        &text,
        &[
            "required",
            "needed",
            "need",
            "request",
            "requested",
            "requesting",
            "waiting",
            "prompt",
        ],
    ) && contains_approval_response(&text);
    let key_prompt = contains_word(&text, "press")
        && contains_any_word(&text, &["y", "yes", "enter", "return"])
        && contains_any_word(&text, &["allow", "approve", "continue", "proceed"]);
    let yes_no_prompt = (contains_word(&text, "yes") || contains_word(&text, "no"))
        && contains_any_word(&text, &["approve", "deny", "allow"]);

    asks_decision || approves_action || approval_request || key_prompt || yes_no_prompt
}

fn looks_busy(line: &str) -> bool {
    let lower = line.to_ascii_lowercase();
    lower.contains("thinking")
        || lower.contains("working")
        || lower.contains("running")
        || lower.contains("esc to interrupt")
        || lower.contains("ctrl-c to interrupt")
        || lower.contains("press esc")
}

fn looks_like_agent_prompt(backend: Backend, line: &str) -> bool {
    match backend {
        Backend::Claude => {
            line == ">"
                || line.starts_with("> ")
                || line.starts_with("❯ ")
                || line.starts_with("› ")
                || line.contains("Type a message")
        }
        Backend::Codex => {
            line == "›"
                || line.starts_with("› ")
                || line.starts_with("> ")
                || line.contains("Type a message")
        }
    }
}

fn normalize_terminal_line(line: &str) -> String {
    line.chars()
        .filter(|ch| !ch.is_control() || ch.is_whitespace())
        .collect::<String>()
        .trim()
        .to_string()
}

fn contains_any_phrase(text: &str, needles: &[&str]) -> bool {
    needles.iter().any(|needle| text.contains(needle))
}

fn contains_any_word(text: &str, words: &[&str]) -> bool {
    words.iter().any(|word| contains_word(text, word))
}

fn contains_approval_response(text: &str) -> bool {
    contains_any_word(
        text,
        &["approve", "allow", "deny", "enter", "return", "press"],
    ) || contains_word(text, "yes")
        || contains_word(text, "no")
}

fn contains_word(text: &str, word: &str) -> bool {
    text.split(|ch: char| !ch.is_ascii_alphanumeric())
        .any(|part| part == word)
}

#[cfg(test)]
mod app_tests {
    use super::*;

    #[test]
    fn detects_common_idle_prompts() {
        assert!(looks_like_agent_prompt(Backend::Claude, "> "));
        assert!(looks_like_agent_prompt(Backend::Claude, "› try something"));
        assert!(looks_like_agent_prompt(Backend::Codex, "› ask follow up"));
        assert!(looks_like_agent_prompt(Backend::Codex, "> "));
    }

    #[test]
    fn detects_busy_lines() {
        assert!(looks_busy("Thinking hard about tests"));
        assert!(looks_busy("esc to interrupt"));
        assert!(!looks_busy("All checks passed."));
    }

    #[test]
    fn detects_permission_prompts_without_matching_task_text() {
        assert!(permission_text_needs_attention(
            "Approval required\nPress enter to approve this command, or no to deny"
        ));
        assert!(permission_text_needs_attention(
            "do you want to allow this shell command to run?"
        ));
        assert!(permission_text_needs_attention(
            "authorization required\npress enter to approve this operation"
        ));
        assert!(!permission_text_needs_attention(
            "it allows need to maeke the sound even if the agent is waiting for permission and it should show that in the agent pane so that it's obvious"
        ));
        assert!(!permission_text_needs_attention(
            "make the sound even if the agent is waiting for permission"
        ));
        assert!(!permission_text_needs_attention(
            "inspect and annotate the live review, then show when waiting for permission"
        ));
    }

    #[test]
    fn task_input_word_navigation_and_delete_respects_cursor() {
        let input = "fix the auth bug";
        assert_eq!(previous_word_position(input, 12), 8);
        assert_eq!(next_word_position(input, 4), 7);

        let mut editable = input.to_string();
        let mut cursor = 12;
        delete_previous_word_at(&mut editable, &mut cursor);
        assert_eq!(editable, "fix the  bug");
        assert_eq!(cursor, 8);

        insert_str_at_cursor(&mut editable, &mut cursor, "login");
        assert_eq!(editable, "fix the login bug");
        assert_eq!(cursor, 13);
    }

    #[test]
    fn wraps_long_notice_text_to_width() {
        let lines = wrap_text(
            "merge stopped: error: Merging is not possible because you have unmerged files.",
            28,
        );

        assert!(lines.len() > 1);
        assert!(lines.iter().all(|line| line.chars().count() <= 28));
        assert_eq!(lines[0], "merge stopped: error:");
    }

    #[test]
    fn converts_mouse_events_to_review_terminal_coordinates() {
        let area = Rect {
            x: 10,
            y: 5,
            width: 20,
            height: 10,
        };
        let event = MouseEvent {
            kind: MouseEventKind::Down(MouseButton::Left),
            column: 12,
            row: 8,
            modifiers: KeyModifiers::empty(),
        };

        assert_eq!(
            mouse_event_to_sgr(event, area),
            Some(b"\x1b[<0;3;4M".to_vec())
        );
    }
}

fn main() -> Result<()> {
    if std::env::args().any(|arg| arg == "--smoke") {
        println!("rudder-native smoke ok");
        return Ok(());
    }

    let mut terminal = setup_terminal()?;
    let result = run(&mut terminal);
    restore_terminal(&mut terminal)?;
    result
}

fn setup_terminal() -> Result<Tui> {
    enable_raw_mode()?;
    let mut stdout = io::stdout();
    execute!(
        stdout,
        EnterAlternateScreen,
        EnableMouseCapture,
        PushKeyboardEnhancementFlags(
            KeyboardEnhancementFlags::DISAMBIGUATE_ESCAPE_CODES
                | KeyboardEnhancementFlags::REPORT_ALTERNATE_KEYS
        )
    )?;
    Ok(Terminal::new(CrosstermBackend::new(stdout))?)
}

fn restore_terminal(terminal: &mut Tui) -> Result<()> {
    disable_raw_mode()?;
    execute!(
        terminal.backend_mut(),
        PopKeyboardEnhancementFlags,
        DisableMouseCapture,
        LeaveAlternateScreen
    )?;
    terminal.show_cursor()?;
    Ok(())
}

fn run(terminal: &mut Tui) -> Result<()> {
    let mut app = App::new();

    loop {
        app.poll_agents();
        terminal.draw(|frame| render(frame, &mut app))?;

        if event::poll(TICK_RATE)? {
            match event::read()? {
                Event::Key(key) if key.kind == KeyEventKind::Press => {
                    if app.handle_key(key) {
                        break;
                    }
                }
                Event::Key(_) => {}
                Event::Paste(text) => app.handle_paste(text),
                Event::Mouse(mouse) => app.handle_mouse(mouse),
                _ => {}
            }
        }
    }

    Ok(())
}

fn render(frame: &mut Frame<'_>, app: &mut App) {
    let area = frame.area();
    frame.render_widget(Clear, area);
    let task_height = task_pane_height(app, area.width);

    let rows = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Min(8),
            Constraint::Length(1),
            Constraint::Length(task_height),
        ])
        .split(area);

    let main = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([
            Constraint::Length(34),
            Constraint::Length(1),
            Constraint::Min(42),
        ])
        .split(rows[0]);

    app.agents_area = Some(main[0]);
    app.worker_area = Some(main[2]);
    app.task_area = Some(rows[2]);

    render_agents(frame, main[0], app);
    render_gutter(frame, main[1], Gutter::Vertical);
    render_worker(frame, main[2], app);
    render_gutter(frame, rows[1], Gutter::Horizontal);
    render_task(frame, rows[2], app);
    render_suggestions(frame, rows[2], app);
}

#[derive(Clone, Copy)]
enum Gutter {
    Horizontal,
    Vertical,
}

fn render_gutter(frame: &mut Frame<'_>, area: Rect, gutter: Gutter) {
    let style = Style::default().fg(Color::DarkGray);
    let line = match gutter {
        Gutter::Horizontal => " ".repeat(area.width as usize),
        Gutter::Vertical => " ".to_string(),
    };

    let lines = vec![Line::from(Span::styled(line, style)); area.height as usize];
    frame.render_widget(Paragraph::new(lines), area);
}

fn render_agents(frame: &mut Frame<'_>, area: Rect, app: &App) {
    let focused = app.focus == FocusPane::Agents;
    let mut lines = vec![
        ListItem::new(Line::from(Span::styled(
            "rudder",
            pane_text_style(focused).add_modifier(Modifier::BOLD),
        ))),
        ListItem::new(Line::from(vec![
            Span::styled(app.cwd.display().to_string(), pane_text_style(focused)),
            Span::raw(" "),
            Span::styled(
                app.branch.as_deref().unwrap_or("no-branch"),
                muted_style(focused),
            ),
        ])),
        ListItem::new(Line::from(vec![
            Span::styled("agents ", pane_text_style(focused)),
            Span::styled(app.agents.len().to_string(), accent_style(focused)),
            Span::styled(" runs", pane_text_style(focused)),
        ])),
        ListItem::new(Line::default()),
    ];

    for hint in ["j/k move", "Enter focus", "v review", "m merge", "d delete"] {
        lines.push(ListItem::new(Line::from(Span::styled(
            hint,
            muted_style(focused),
        ))));
    }
    lines.push(ListItem::new(Line::default()));

    for (index, agent) in app.agents.iter().enumerate() {
        let selected = index == app.selected_agent;
        let marker = if selected { "> " } else { "  " };
        let task_style = if selected {
            pane_text_style(focused).add_modifier(Modifier::BOLD)
        } else {
            pane_text_style(focused)
        };

        lines.push(ListItem::new(Line::from(vec![
            Span::styled(marker, accent_style(focused)),
            Span::styled(short_task(&agent.task), task_style),
        ])));
        lines.push(ListItem::new(Line::from(vec![
            Span::raw("  "),
            Span::styled(agent_status_label(agent), agent_status_style(agent)),
            Span::raw("  "),
            Span::styled(agent.backend.as_str(), muted_style(focused)),
            Span::raw("  "),
            Span::styled(agent.model.as_str(), model_style(focused)),
            Span::styled(
                format!("({})", effort_label(agent.effort)),
                model_style(focused),
            ),
        ])));
        if let Some(summary) = diff_short_summary(agent) {
            lines.push(ListItem::new(Line::from(vec![
                Span::raw("  "),
                Span::styled(summary, muted_style(focused)),
            ])));
        }
    }

    if app.agents.is_empty() {
        lines.push(ListItem::new(Line::from(Span::styled(
            "no agents yet",
            muted_style(focused),
        ))));
    }

    frame.render_widget(
        List::new(lines).block(pane_block("agents", focused, app.nav_mode)),
        area,
    );
}

fn render_worker(frame: &mut Frame<'_>, area: Rect, app: &mut App) {
    let inner = block_inner(area);
    let terminal_size = TerminalSize::new(inner.height.max(1), inner.width.max(1)).ok();
    let focused = app.focus == FocusPane::Worker;

    if let Some(size) = terminal_size {
        if let Some(run) = app.agents.get_mut(app.selected_agent) {
            if app.worker_view == WorkerView::Terminal && run.terminal_size != Some(size) {
                if let Some(terminal) = run.terminal.as_mut() {
                    if terminal.resize(size).is_ok() {
                        run.terminal_size = Some(size);
                    }
                }
            }
            if app.worker_view == WorkerView::Diff && run.review_size != Some(size) {
                if let Some(review) = run.review_terminal.as_mut() {
                    if review.resize(size).is_ok() {
                        run.review_size = Some(size);
                    }
                }
            }
        }
    }

    let lines = match app.worker_view {
        WorkerView::Terminal => worker_lines(app, inner.height as usize),
        WorkerView::Diff => review_lines(app, inner.height as usize),
    };
    let paragraph = Paragraph::new(lines)
        .block(pane_block(
            match app.worker_view {
                WorkerView::Terminal => "worker",
                WorkerView::Diff => "review",
            },
            focused,
            app.nav_mode,
        ))
        .wrap(Wrap { trim: false });

    frame.render_widget(paragraph, area);

    if focused {
        match app.worker_view {
            WorkerView::Terminal => set_worker_cursor(frame, inner, app),
            WorkerView::Diff => set_review_cursor(frame, inner, app),
        }
    }
}

fn set_worker_cursor(frame: &mut Frame<'_>, inner: Rect, app: &App) {
    let Some((backend, cursor)) = app.agents.get(app.selected_agent).and_then(|run| {
        run.terminal
            .as_ref()
            .map(|terminal| (run.backend, terminal.cursor()))
    }) else {
        return;
    };
    if cursor.row >= inner.height || cursor.col >= inner.width {
        return;
    }
    if !cursor.visible && backend != Backend::Claude {
        return;
    }
    frame.set_cursor_position((inner.x + cursor.col, inner.y + cursor.row));
}

fn set_review_cursor(frame: &mut Frame<'_>, inner: Rect, app: &App) {
    let Some(cursor) = app.agents.get(app.selected_agent).and_then(|run| {
        run.review_terminal
            .as_ref()
            .map(|terminal| terminal.cursor())
    }) else {
        return;
    };
    if cursor.row >= inner.height || cursor.col >= inner.width || !cursor.visible {
        return;
    }
    frame.set_cursor_position((inner.x + cursor.col, inner.y + cursor.row));
}

fn worker_lines(app: &mut App, height: usize) -> Vec<Line<'static>> {
    let Some(run) = app.agents.get_mut(app.selected_agent) else {
        return vec![
            Line::from(""),
            Line::from(Span::styled(
                "No worker is running yet.",
                Style::default().fg(Color::Gray),
            )),
            Line::from(""),
            Line::from("Enter a task below to start Claude Code or Codex in this pane."),
        ];
    };

    if let Some(error) = &run.last_error {
        return vec![
            Line::from(vec![
                Span::styled("failed ", Style::default().fg(Color::Red)),
                Span::styled(
                    run.cwd.display().to_string(),
                    Style::default().fg(Color::Gray),
                ),
            ]),
            Line::from(Span::styled(error.clone(), Style::default().fg(Color::Red))),
        ];
    }

    let Some(terminal) = run.terminal.as_mut() else {
        return vec![Line::from("worker did not start")];
    };

    let mut lines = terminal
        .styled_lines()
        .into_iter()
        .map(styled_terminal_line)
        .collect::<Vec<_>>();
    if lines.len() > height {
        lines = lines.split_off(lines.len() - height);
    }
    lines
}

fn review_lines(app: &mut App, height: usize) -> Vec<Line<'static>> {
    let Some(run) = app.agents.get_mut(app.selected_agent) else {
        return vec![Line::from(Span::styled(
            "No agent selected.",
            Style::default().fg(Color::Gray),
        ))];
    };

    if let Some(error) = &run.review_error {
        return vec![
            Line::from(Span::styled(
                "Hunk review failed",
                Style::default().fg(Color::Red),
            )),
            Line::from(Span::styled(error.clone(), Style::default().fg(Color::Red))),
            Line::from(""),
            Line::from(Span::styled(
                "Press Ctrl-G then v to return to the worker.",
                Style::default().fg(Color::Gray),
            )),
        ];
    }

    let Some(review) = run.review_terminal.as_mut() else {
        return vec![
            Line::from(Span::styled(
                "Opening Hunk review...",
                Style::default().fg(Color::Gray),
            )),
            Line::from(""),
            Line::from("If Hunk is not installed, Rudder will run npm install -g hunkdiff@latest."),
        ];
    };

    let mut lines = review
        .styled_lines()
        .into_iter()
        .map(styled_terminal_line)
        .collect::<Vec<_>>();
    if lines.len() > height {
        lines = lines.split_off(lines.len() - height);
    }
    lines
}

fn render_task(frame: &mut Frame<'_>, area: Rect, app: &App) {
    let focused = app.focus == FocusPane::Task;
    let input = if app.task_input.is_empty() {
        Line::from(Span::styled("Type a task or /model", muted_style(focused)))
    } else {
        Line::from(Span::styled(
            app.task_input.as_str(),
            pane_text_style(focused),
        ))
    };

    let hint = app
        .notice
        .as_deref()
        .unwrap_or("Enter start  Tab focus  Alt-1/2/3 pane  /model");
    let inner_width = area.width.saturating_sub(2).max(1);
    let mut lines = vec![input];
    let wrapped_hint = wrap_text(hint, inner_width);
    if app.notice.is_some() {
        for line in wrapped_hint {
            lines.push(Line::from(Span::styled(line, muted_style(focused))));
        }
    } else {
        let first_hint = wrapped_hint.first().cloned().unwrap_or_default();
        lines.push(Line::from(vec![
            Span::styled(first_hint, muted_style(focused)),
            Span::raw("  "),
            Span::styled(app.backend.as_str(), accent_style(focused)),
            Span::raw(" "),
            Span::styled(app.model.as_str(), model_style(focused)),
            Span::styled(
                format!("({})", effort_label(app.effort)),
                model_style(focused),
            ),
        ]));
        for line in wrapped_hint.into_iter().skip(1) {
            lines.push(Line::from(Span::styled(line, muted_style(focused))));
        }
    }

    let paragraph = Paragraph::new(lines).block(pane_block("task", focused, app.nav_mode));

    frame.render_widget(paragraph, area);

    if app.focus == FocusPane::Task {
        let x = area.x + 1 + app.task_cursor as u16;
        let y = area.y + 1;
        if x < area.right().saturating_sub(1) {
            frame.set_cursor_position((x, y));
        }
    }
}

fn task_pane_height(app: &App, width: u16) -> u16 {
    let hint = app
        .notice
        .as_deref()
        .unwrap_or("Enter start  Tab focus  Alt-1/2/3 pane  /model");
    let inner_width = width.saturating_sub(2).max(1);
    let hint_lines = wrap_text(hint, inner_width).len().max(1) as u16;
    2_u16
        .saturating_add(1)
        .saturating_add(hint_lines)
        .clamp(4, 10)
}

fn render_suggestions(frame: &mut Frame<'_>, task_area: Rect, app: &App) {
    let suggestions = suggestions_for(app);
    if suggestions.is_empty() {
        return;
    }

    let visible_count = suggestions.len().min(8);
    let height = (visible_count as u16).saturating_add(2);
    if task_area.y < height {
        return;
    }
    let area = Rect {
        x: task_area.x,
        y: task_area.y - height,
        width: task_area.width,
        height,
    };

    let selected_index = app.picker_index.min(suggestions.len().saturating_sub(1));
    let offset = selected_index.saturating_sub(visible_count.saturating_sub(1));
    let items = suggestions
        .iter()
        .skip(offset)
        .take(visible_count)
        .enumerate()
        .map(|(index, suggestion)| {
            let selected = index + offset == selected_index;
            let marker = if selected { "> " } else { "  " };
            let style = if selected {
                Style::default()
                    .fg(Color::Cyan)
                    .add_modifier(Modifier::BOLD)
            } else {
                Style::default()
            };
            ListItem::new(Line::from(vec![
                Span::styled(marker, style),
                Span::styled(suggestion.label.clone(), style),
                Span::raw("  "),
                Span::styled(suggestion.detail.clone(), Style::default().fg(Color::Gray)),
            ]))
        })
        .collect::<Vec<_>>();

    let title = if app.task_input.starts_with("/model") {
        " model "
    } else {
        " commands "
    };
    let list = List::new(items).block(
        Block::default()
            .title(title)
            .borders(Borders::ALL)
            .border_style(
                Style::default()
                    .fg(FOCUS_COLOR)
                    .add_modifier(Modifier::BOLD),
            ),
    );

    frame.render_widget(Clear, area);
    frame.render_widget(list, area);
}

fn pane_block(title: &'static str, focused: bool, nav_mode: bool) -> Block<'static> {
    let border_style = if focused {
        Style::default()
            .fg(FOCUS_COLOR)
            .add_modifier(Modifier::BOLD)
    } else {
        Style::default().fg(INACTIVE_COLOR)
    };

    let title_style = if focused {
        Style::default()
            .fg(Color::Black)
            .bg(FOCUS_COLOR)
            .add_modifier(Modifier::BOLD)
    } else {
        Style::default().fg(Color::Gray)
    };
    let _ = nav_mode;

    Block::default()
        .title(Line::from(Span::styled(format!(" {title} "), title_style)))
        .borders(Borders::ALL)
        .border_style(border_style)
}

fn wrap_text(value: &str, width: u16) -> Vec<String> {
    let max_width = usize::from(width.max(1));
    let mut lines = Vec::new();
    let mut current = String::new();

    for word in value.split_whitespace() {
        if current.is_empty() {
            push_wrapped_word(&mut lines, &mut current, word, max_width);
            continue;
        }

        if current.chars().count() + 1 + word.chars().count() <= max_width {
            current.push(' ');
            current.push_str(word);
        } else {
            lines.push(std::mem::take(&mut current));
            push_wrapped_word(&mut lines, &mut current, word, max_width);
        }
    }

    if !current.is_empty() {
        lines.push(current);
    }
    if lines.is_empty() {
        lines.push(String::new());
    }

    lines
}

fn push_wrapped_word(lines: &mut Vec<String>, current: &mut String, word: &str, max_width: usize) {
    if word.chars().count() <= max_width {
        current.push_str(word);
        return;
    }

    let mut chunk = String::new();
    for ch in word.chars() {
        if chunk.chars().count() == max_width {
            lines.push(std::mem::take(&mut chunk));
        }
        chunk.push(ch);
    }
    *current = chunk;
}

fn pane_text_style(focused: bool) -> Style {
    if focused {
        Style::default()
    } else {
        Style::default()
            .fg(INACTIVE_COLOR)
            .add_modifier(Modifier::DIM)
    }
}

fn muted_style(focused: bool) -> Style {
    if focused {
        Style::default().fg(Color::Gray)
    } else {
        Style::default()
            .fg(INACTIVE_COLOR)
            .add_modifier(Modifier::DIM)
    }
}

fn accent_style(focused: bool) -> Style {
    if focused {
        Style::default()
            .fg(FOCUS_COLOR)
            .add_modifier(Modifier::BOLD)
    } else {
        Style::default()
            .fg(INACTIVE_COLOR)
            .add_modifier(Modifier::DIM)
    }
}

fn model_style(focused: bool) -> Style {
    if focused {
        Style::default().fg(Color::Magenta)
    } else {
        Style::default()
            .fg(INACTIVE_COLOR)
            .add_modifier(Modifier::DIM)
    }
}

fn block_inner(area: Rect) -> Rect {
    Rect {
        x: area.x.saturating_add(1),
        y: area.y.saturating_add(1),
        width: area.width.saturating_sub(2),
        height: area.height.saturating_sub(2),
    }
}

fn rect_contains(area: Rect, x: u16, y: u16) -> bool {
    x >= area.x && x < area.right() && y >= area.y && y < area.bottom()
}

fn status_style(status: AgentStatus) -> Style {
    Style::default().fg(status_color(status))
}

fn agent_status_label(agent: &AgentRun) -> &'static str {
    if agent.needs_permission {
        "needs permission"
    } else {
        agent.status.as_str()
    }
}

fn agent_status_style(agent: &AgentRun) -> Style {
    if agent.needs_permission {
        Style::default()
            .fg(Color::Yellow)
            .add_modifier(Modifier::BOLD)
    } else {
        status_style(agent.status)
    }
}

fn status_color(status: AgentStatus) -> Color {
    match status {
        AgentStatus::Running => Color::Yellow,
        AgentStatus::Done => Color::Gray,
        AgentStatus::Failed => Color::Red,
    }
}

fn styled_terminal_line(cells: Vec<StyledTerminalCell>) -> Line<'static> {
    let spans = cells
        .into_iter()
        .map(|cell| {
            let style = terminal_cell_style(&cell);
            Span::styled(cell.contents, style)
        })
        .collect::<Vec<_>>();
    Line::from(spans)
}

fn terminal_cell_style(cell: &StyledTerminalCell) -> Style {
    let (fg, bg) = if cell.inverse {
        (cell.bg, cell.fg)
    } else {
        (cell.fg, cell.bg)
    };
    let mut style = Style::default();
    if let Some(color) = map_vt100_color(fg) {
        style = style.fg(color);
    }
    if let Some(color) = map_vt100_color(bg) {
        style = style.bg(color);
    }
    let mut modifier = Modifier::empty();
    if cell.bold {
        modifier |= Modifier::BOLD;
    }
    if cell.dim {
        modifier |= Modifier::DIM;
    }
    if cell.italic {
        modifier |= Modifier::ITALIC;
    }
    if cell.underline {
        modifier |= Modifier::UNDERLINED;
    }
    style.add_modifier(modifier)
}

fn map_vt100_color(color: vt100::Color) -> Option<Color> {
    match color {
        vt100::Color::Default => None,
        vt100::Color::Idx(index) => Some(match index {
            0 => Color::Black,
            1 => Color::Red,
            2 => Color::Green,
            3 => Color::Yellow,
            4 => Color::Blue,
            5 => Color::Magenta,
            6 => Color::Cyan,
            7 => Color::Gray,
            8 => Color::DarkGray,
            9 => Color::LightRed,
            10 => Color::LightGreen,
            11 => Color::LightYellow,
            12 => Color::LightBlue,
            13 => Color::LightMagenta,
            14 => Color::LightCyan,
            15 => Color::White,
            _ => Color::Indexed(index),
        }),
        vt100::Color::Rgb(red, green, blue) => Some(Color::Rgb(red, green, blue)),
    }
}

fn default_model_for(backend: Backend) -> &'static str {
    match backend {
        Backend::Claude => "sonnet",
        Backend::Codex => "gpt-5.5",
    }
}

fn default_effort_for(backend: Backend, model: &str) -> Option<EffortLevel> {
    let options = effort_options_for(backend, model);
    if options.contains(&Some(EffortLevel::XHigh)) {
        Some(EffortLevel::XHigh)
    } else {
        options.into_iter().next().flatten()
    }
}

fn effort_label(effort: Option<EffortLevel>) -> &'static str {
    effort.map(EffortLevel::as_str).unwrap_or("auto")
}

fn parse_effort_arg(value: &str) -> Option<EffortLevel> {
    if value.eq_ignore_ascii_case("auto") {
        None
    } else {
        EffortLevel::parse(value)
    }
}

fn provider_backend(provider: &str) -> Option<Backend> {
    match provider.to_ascii_lowercase().as_str() {
        "claude" | "anthropic" => Some(Backend::Claude),
        "codex" | "openai" => Some(Backend::Codex),
        _ => None,
    }
}

fn effort_options_for(backend: Backend, model: &str) -> Vec<Option<EffortLevel>> {
    if !model_supports_reasoning(backend, model) {
        return vec![None];
    }

    let mut options = vec![
        None,
        Some(EffortLevel::Low),
        Some(EffortLevel::Medium),
        Some(EffortLevel::High),
        Some(EffortLevel::XHigh),
    ];
    if backend == Backend::Claude {
        options.push(Some(EffortLevel::Max));
    }
    options
}

fn effort_detail(backend: Backend, effort: Option<EffortLevel>) -> &'static str {
    match (backend, effort) {
        (_, None) => "let the agent decide",
        (_, Some(EffortLevel::Low)) => "fastest",
        (_, Some(EffortLevel::Medium)) => "balanced",
        (_, Some(EffortLevel::High)) => "deeper reasoning",
        (_, Some(EffortLevel::XHigh)) => "extended reasoning",
        (Backend::Claude, Some(EffortLevel::Max)) => "maximum reasoning",
        (Backend::Codex, Some(EffortLevel::Max)) => "not used",
    }
}

fn model_supports_reasoning(backend: Backend, model: &str) -> bool {
    if is_reasoning_alias(backend, model) {
        return true;
    }
    cached_model_reasoning(backend, model).unwrap_or_else(|| match backend {
        Backend::Claude => model.contains("opus") || model.contains("sonnet"),
        Backend::Codex => model.starts_with("gpt-5") || model.contains("codex"),
    })
}

fn is_reasoning_alias(backend: Backend, model: &str) -> bool {
    match backend {
        Backend::Claude => matches!(model, "sonnet" | "sonnet[1m]" | "opus" | "opus[1m]"),
        Backend::Codex => model.starts_with("gpt-5") || model.contains("codex"),
    }
}

fn cached_model_reasoning(backend: Backend, model_id: &str) -> Option<bool> {
    let cache_path = models_dev_cache_path()?;
    let raw = fs::read_to_string(cache_path).ok()?;
    let data = serde_json::from_str::<serde_json::Value>(&raw).ok()?;
    let provider = match backend {
        Backend::Claude => "anthropic",
        Backend::Codex => "openai",
    };
    data.get(provider)?
        .get("models")?
        .get(model_id)?
        .get("reasoning")?
        .as_bool()
}

fn suggestions_for(app: &App) -> Vec<Suggestion> {
    let input = app.task_input.trim_start();
    if !input.starts_with('/') {
        return Vec::new();
    }

    if input.starts_with("/model") {
        return model_provider_or_model_suggestions(
            input.strip_prefix("/model").unwrap_or_default(),
        );
    }

    let query = input.trim_start_matches('/').to_ascii_lowercase();
    command_suggestions()
        .into_iter()
        .filter(|suggestion| {
            query.is_empty()
                || suggestion.label.trim_start_matches('/').starts_with(&query)
                || suggestion.detail.to_ascii_lowercase().contains(&query)
        })
        .collect()
}

fn command_suggestions() -> Vec<Suggestion> {
    vec![
        Suggestion {
            label: "/model".to_string(),
            detail: "pick Claude or Codex model".to_string(),
            action: SuggestionAction::Insert("/model ".to_string()),
        },
        Suggestion {
            label: "/help".to_string(),
            detail: "show shortcuts".to_string(),
            action: SuggestionAction::ShowHelp,
        },
    ]
}

fn model_provider_or_model_suggestions(rest: &str) -> Vec<Suggestion> {
    let rest = rest.trim_start();
    if rest.is_empty() {
        return provider_suggestions("");
    }

    let trailing_space = rest.ends_with(char::is_whitespace);
    let parts = rest.split_whitespace().collect::<Vec<_>>();
    let Some(backend) = parts
        .first()
        .and_then(|provider| provider_backend(provider))
    else {
        return provider_suggestions(parts.first().copied().unwrap_or_default());
    };

    match parts.as_slice() {
        [provider] if !trailing_space => provider_suggestions(provider),
        [_provider] => model_suggestions_for(backend, ""),
        [_provider, model] if trailing_space => effort_suggestions_for(backend, model, ""),
        [_provider, model] => model_suggestions_for(backend, model),
        [_provider, model, effort_query, ..] => {
            effort_suggestions_for(backend, model, effort_query)
        }
        _ => provider_suggestions(""),
    }
}

fn provider_suggestions(query: &str) -> Vec<Suggestion> {
    [
        (Backend::Claude, "Claude Code models"),
        (Backend::Codex, "Codex models"),
    ]
    .into_iter()
    .filter(|(backend, detail)| {
        query.is_empty()
            || backend.as_str().starts_with(query)
            || detail.to_ascii_lowercase().contains(query)
    })
    .map(|(backend, detail)| Suggestion {
        label: backend.as_str().to_string(),
        detail: detail.to_string(),
        action: SuggestionAction::ChooseModelProvider(backend),
    })
    .collect()
}

fn model_suggestions_for(backend_filter: Backend, query: &str) -> Vec<Suggestion> {
    let mut seen = HashSet::new();
    let mut suggestions = Vec::new();

    for (backend, model, detail) in fallback_model_rows() {
        if backend == backend_filter {
            push_model_suggestion(&mut suggestions, &mut seen, backend, model, detail);
        }
    }
    for (backend, model, detail) in cached_models_dev_rows() {
        if backend == backend_filter {
            push_model_suggestion(&mut suggestions, &mut seen, backend, &model, &detail);
        }
    }

    suggestions
        .into_iter()
        .filter(|suggestion| {
            query.is_empty()
                || suggestion.label.to_ascii_lowercase().contains(query)
                || suggestion.detail.to_ascii_lowercase().contains(query)
        })
        .collect()
}

fn effort_suggestions_for(backend: Backend, model: &str, query: &str) -> Vec<Suggestion> {
    effort_options_for(backend, model)
        .into_iter()
        .filter(|effort| {
            let label = effort_label(*effort);
            query.is_empty() || label.starts_with(&query.to_ascii_lowercase())
        })
        .map(|effort| {
            let label = effort_label(effort).to_string();
            Suggestion {
                detail: effort_detail(backend, effort).to_string(),
                label,
                action: SuggestionAction::SetModel {
                    backend,
                    model: model.to_string(),
                    effort,
                },
            }
        })
        .collect()
}

fn fallback_model_rows() -> Vec<(Backend, &'static str, &'static str)> {
    vec![
        (Backend::Claude, "sonnet", "default strong model"),
        (Backend::Claude, "sonnet[1m]", "large context"),
        (Backend::Claude, "opus", "strongest reasoning"),
        (Backend::Claude, "opus[1m]", "large context"),
        (Backend::Claude, "haiku", "fast model"),
        (Backend::Claude, "claude-sonnet-4-6", "explicit id"),
        (Backend::Codex, "gpt-5.5", "latest"),
        (Backend::Codex, "gpt-5.4-codex", "coding"),
        (Backend::Codex, "gpt-5.4", "general"),
        (Backend::Codex, "gpt-5.3-codex", "coding"),
        (Backend::Codex, "gpt-5.3-codex-spark", "fast"),
    ]
}

fn push_model_suggestion(
    suggestions: &mut Vec<Suggestion>,
    seen: &mut HashSet<String>,
    backend: Backend,
    model: &str,
    detail: &str,
) {
    let key = format!("{}:{model}", backend.as_str());
    if !seen.insert(key) {
        return;
    }
    suggestions.push(Suggestion {
        label: model.to_string(),
        detail: detail.to_string(),
        action: SuggestionAction::ChooseModel {
            backend,
            model: model.to_string(),
        },
    });
}

fn cached_models_dev_rows() -> Vec<(Backend, String, String)> {
    let Some(cache_path) = models_dev_cache_path() else {
        return Vec::new();
    };
    let Ok(raw) = fs::read_to_string(cache_path) else {
        return Vec::new();
    };
    let Ok(data) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return Vec::new();
    };

    let mut rows = Vec::new();
    collect_provider_models(&data, "anthropic", Backend::Claude, &mut rows);
    collect_provider_models(&data, "openai", Backend::Codex, &mut rows);
    rows
}

fn collect_provider_models(
    data: &serde_json::Value,
    provider: &str,
    backend: Backend,
    rows: &mut Vec<(Backend, String, String)>,
) {
    let Some(models) = data
        .get(provider)
        .and_then(|provider| provider.get("models"))
        .and_then(serde_json::Value::as_object)
    else {
        return;
    };

    let mut entries = models
        .iter()
        .filter(|(id, model)| match backend {
            Backend::Claude => is_claude_picker_model(id, model),
            Backend::Codex => is_codex_picker_model(id, model),
        })
        .map(|(id, model)| {
            let detail = model
                .get("name")
                .and_then(serde_json::Value::as_str)
                .or_else(|| {
                    model
                        .get("release_date")
                        .and_then(serde_json::Value::as_str)
                })
                .unwrap_or("models.dev")
                .to_string();
            (id.clone(), detail)
        })
        .collect::<Vec<_>>();

    entries.sort_by(|a, b| score_model(backend, &b.0).cmp(&score_model(backend, &a.0)));
    for (id, detail) in entries.into_iter().take(8) {
        rows.push((backend, id, detail));
    }
}

fn is_claude_picker_model(id: &str, model: &serde_json::Value) -> bool {
    id.starts_with("claude-")
        && !id.contains("3-")
        && (id.contains("sonnet") || id.contains("opus") || id.contains("haiku"))
        && model
            .get("tool_call")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(true)
}

fn is_codex_picker_model(id: &str, model: &serde_json::Value) -> bool {
    let text_output = model
        .get("modalities")
        .and_then(|modalities| modalities.get("output"))
        .and_then(serde_json::Value::as_array)
        .is_none_or(|output| output.iter().any(|value| value.as_str() == Some("text")));
    text_output
        && !id.contains("deep-research")
        && !id.contains("chat-latest")
        && !id.contains("pro")
        && (id.contains("codex") || id.starts_with("gpt-5"))
}

fn score_model(backend: Backend, id: &str) -> i32 {
    match backend {
        Backend::Claude => {
            let mut score = 0;
            if id.contains("sonnet") {
                score += 40;
            }
            if id.contains("opus") {
                score += 35;
            }
            if id.contains("haiku") {
                score += 20;
            }
            score
        }
        Backend::Codex => {
            let mut score = 0;
            if id.contains("codex") {
                score += 40;
            }
            if id.starts_with("gpt-5.5") {
                score += 35;
            }
            if id.starts_with("gpt-5.4") {
                score += 30;
            }
            score
        }
    }
}

fn models_dev_cache_path() -> Option<PathBuf> {
    std::env::var_os("RUDDER_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".rudder")))
        .map(|home| home.join("models-dev.json"))
}

fn backend_for_model(model: &str) -> Backend {
    if model.starts_with("gpt-") || model.contains("codex") {
        Backend::Codex
    } else {
        Backend::Claude
    }
}

fn agent_command(
    backend: Backend,
    model: &str,
    effort: Option<EffortLevel>,
    task: &str,
) -> TerminalCommand {
    let prompt = format!(
        "Read RUDDER.md first if it exists. If a Hunk review is open for this worktree, run `hunk skill path`, load that skill, and use `hunk session review --repo . --json` plus `hunk session comment ...` commands to inspect and annotate the live review.\n\n{task}"
    );
    match backend {
        Backend::Claude => {
            let mut args = vec![
                "--permission-mode".to_string(),
                "bypassPermissions".to_string(),
            ];
            if !model.trim().is_empty() {
                args.push("--model".to_string());
                args.push(model.to_string());
            }
            if let Some(effort) = effort {
                args.push("--effort".to_string());
                args.push(effort.as_str().to_string());
            }
            args.push(prompt);
            TerminalCommand::with_args("claude", args)
        }
        Backend::Codex => {
            let mut args = vec![
                "--ask-for-approval".to_string(),
                "never".to_string(),
                "--sandbox".to_string(),
                "danger-full-access".to_string(),
                "-c".to_string(),
                "model_reasoning_summary=\"detailed\"".to_string(),
                "-c".to_string(),
                "model_supports_reasoning_summaries=true".to_string(),
            ];
            if let Some(effort) = effort {
                args.push("-c".to_string());
                args.push(format!("model_reasoning_effort=\"{}\"", effort.as_str()));
            }
            if !model.trim().is_empty() {
                args.push("-m".to_string());
                args.push(model.to_string());
            }
            args.push(prompt);
            TerminalCommand::with_args("codex", args)
        }
    }
}

fn short_task(task: &str) -> String {
    const MAX: usize = 26;
    let mut chars = task.chars();
    let short = chars.by_ref().take(MAX).collect::<String>();
    if chars.next().is_some() {
        format!("{short}...")
    } else {
        short
    }
}

fn insert_char_at_cursor(input: &mut String, cursor: &mut usize, ch: char) {
    let byte_index = byte_index_for_char(input, *cursor);
    input.insert(byte_index, ch);
    *cursor += 1;
}

fn insert_str_at_cursor(input: &mut String, cursor: &mut usize, value: &str) {
    let byte_index = byte_index_for_char(input, *cursor);
    input.insert_str(byte_index, value);
    *cursor += value.chars().count();
}

fn delete_char_before_cursor(input: &mut String, cursor: &mut usize) {
    if *cursor == 0 {
        return;
    }
    let start = byte_index_for_char(input, cursor.saturating_sub(1));
    let end = byte_index_for_char(input, *cursor);
    input.replace_range(start..end, "");
    *cursor -= 1;
}

fn delete_char_at_cursor(input: &mut String, cursor: usize) {
    if cursor >= input.chars().count() {
        return;
    }
    let start = byte_index_for_char(input, cursor);
    let end = byte_index_for_char(input, cursor + 1);
    input.replace_range(start..end, "");
}

fn delete_previous_word_at(input: &mut String, cursor: &mut usize) {
    let start_char = previous_word_position(input, *cursor);
    if start_char == *cursor {
        return;
    }
    let start = byte_index_for_char(input, start_char);
    let end = byte_index_for_char(input, *cursor);
    input.replace_range(start..end, "");
    *cursor = start_char;
}

fn previous_word_position(input: &str, cursor: usize) -> usize {
    let chars = input.chars().collect::<Vec<_>>();
    let mut index = cursor.min(chars.len());
    while index > 0 && chars[index - 1].is_whitespace() {
        index -= 1;
    }
    while index > 0 && !chars[index - 1].is_whitespace() {
        index -= 1;
    }
    index
}

fn next_word_position(input: &str, cursor: usize) -> usize {
    let chars = input.chars().collect::<Vec<_>>();
    let mut index = cursor.min(chars.len());
    while index < chars.len() && chars[index].is_whitespace() {
        index += 1;
    }
    while index < chars.len() && !chars[index].is_whitespace() {
        index += 1;
    }
    index
}

fn byte_index_for_char(input: &str, char_index: usize) -> usize {
    input
        .char_indices()
        .nth(char_index)
        .map(|(index, _)| index)
        .unwrap_or(input.len())
}

fn terminal_bytes_for_key(key: KeyEvent) -> Option<Vec<u8>> {
    let bytes = match key.code {
        KeyCode::Char(ch) => {
            if key.modifiers.contains(KeyModifiers::CONTROL) {
                control_char_bytes(ch)?
            } else if key
                .modifiers
                .intersects(KeyModifiers::ALT | KeyModifiers::META)
            {
                let mut bytes = vec![0x1b];
                bytes.extend(ch.to_string().into_bytes());
                bytes
            } else {
                ch.to_string().into_bytes()
            }
        }
        KeyCode::Enter => b"\r".to_vec(),
        KeyCode::Backspace => {
            if key
                .modifiers
                .intersects(KeyModifiers::SUPER | KeyModifiers::META)
            {
                vec![0x15]
            } else if key.modifiers.contains(KeyModifiers::ALT) {
                b"\x1b\x7f".to_vec()
            } else if key.modifiers.contains(KeyModifiers::CONTROL) {
                vec![0x17]
            } else {
                vec![0x7f]
            }
        }
        KeyCode::Esc => vec![0x1b],
        KeyCode::Left if key.modifiers.contains(KeyModifiers::ALT) => b"\x1bb".to_vec(),
        KeyCode::Right if key.modifiers.contains(KeyModifiers::ALT) => b"\x1bf".to_vec(),
        KeyCode::Left if key.modifiers.contains(KeyModifiers::CONTROL) => b"\x1b[1;5D".to_vec(),
        KeyCode::Right if key.modifiers.contains(KeyModifiers::CONTROL) => b"\x1b[1;5C".to_vec(),
        KeyCode::Left => b"\x1b[D".to_vec(),
        KeyCode::Right => b"\x1b[C".to_vec(),
        KeyCode::Up => modified_arrow("A", key.modifiers),
        KeyCode::Down => modified_arrow("B", key.modifiers),
        KeyCode::Home => b"\x1b[H".to_vec(),
        KeyCode::End => b"\x1b[F".to_vec(),
        KeyCode::Delete => b"\x1b[3~".to_vec(),
        _ => return None,
    };
    Some(bytes)
}

fn mouse_event_to_sgr(mouse: MouseEvent, area: Rect) -> Option<Vec<u8>> {
    if !rect_contains(area, mouse.column, mouse.row) {
        return None;
    }

    let x = mouse.column.saturating_sub(area.x).saturating_add(1);
    let y = mouse.row.saturating_sub(area.y).saturating_add(1);
    let (button, press) = match mouse.kind {
        MouseEventKind::Down(button) => (mouse_button_code(button), true),
        MouseEventKind::Up(_) => (3, false),
        MouseEventKind::Drag(button) => (mouse_button_code(button) + 32, true),
        MouseEventKind::Moved => (35, true),
        MouseEventKind::ScrollUp => (64, true),
        MouseEventKind::ScrollDown => (65, true),
        MouseEventKind::ScrollLeft => (66, true),
        MouseEventKind::ScrollRight => (67, true),
    };

    Some(
        format!(
            "\x1b[<{};{};{}{}",
            button,
            x,
            y,
            if press { "M" } else { "m" }
        )
        .into_bytes(),
    )
}

fn mouse_button_code(button: MouseButton) -> u16 {
    match button {
        MouseButton::Left => 0,
        MouseButton::Middle => 1,
        MouseButton::Right => 2,
    }
}

fn control_char_bytes(ch: char) -> Option<Vec<u8>> {
    let lower = ch.to_ascii_lowercase();
    if lower.is_ascii_lowercase() {
        return Some(vec![(lower as u8) - b'a' + 1]);
    }
    match ch {
        '[' => Some(vec![0x1b]),
        '\\' => Some(vec![0x1c]),
        ']' => Some(vec![0x1d]),
        '^' => Some(vec![0x1e]),
        '_' => Some(vec![0x1f]),
        '?' => Some(vec![0x7f]),
        _ => None,
    }
}

fn modified_arrow(final_byte: &str, modifiers: KeyModifiers) -> Vec<u8> {
    let modifier_code = if modifiers.contains(KeyModifiers::CONTROL) {
        Some(5)
    } else if modifiers.contains(KeyModifiers::ALT) {
        Some(3)
    } else {
        None
    };
    match modifier_code {
        Some(code) => format!("\x1b[1;{code}{final_byte}").into_bytes(),
        None => format!("\x1b[{final_byte}").into_bytes(),
    }
}

fn current_branch() -> Option<String> {
    let output = std::process::Command::new("git")
        .args(["branch", "--show-current"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let branch = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if branch.is_empty() {
        None
    } else {
        Some(branch)
    }
}

#[derive(Debug, Clone)]
struct WorktreeInfo {
    id: String,
    path: PathBuf,
    branch: Option<String>,
    path_is_worktree: bool,
}

impl WorktreeInfo {
    fn current(path: PathBuf) -> Self {
        Self {
            id: new_run_id("task"),
            path,
            branch: None,
            path_is_worktree: false,
        }
    }
}

fn prepare_worktree(cwd: &Path, task: &str) -> Result<WorktreeInfo> {
    let repo = repo_root(cwd);
    if !is_git_repo(&repo) {
        return Ok(WorktreeInfo::current(cwd.to_path_buf()));
    }

    let id = new_run_id(task);
    let base_commit = git_output(&repo, ["rev-parse", "HEAD"])?;
    let branch = format!("rudder/{}-{}", id_short(&id), slugify(task, "task"));
    let path = worktree_path(&repo, &id);
    let parent = path
        .parent()
        .context("worktree target has no parent directory")?;
    fs::create_dir_all(parent)?;

    let _ = Command::new("git")
        .args(["branch", &branch, base_commit.trim()])
        .current_dir(&repo)
        .output();
    let output = Command::new("git")
        .args(["worktree", "add"])
        .arg(&path)
        .arg(&branch)
        .current_dir(&repo)
        .output()?;
    if !output.status.success() {
        let message = String::from_utf8_lossy(&output.stderr).trim().to_string();
        anyhow::bail!(if message.is_empty() {
            "git worktree add failed".to_string()
        } else {
            message
        });
    }

    Ok(WorktreeInfo {
        id,
        path,
        branch: Some(branch),
        path_is_worktree: true,
    })
}

fn repo_root(cwd: &Path) -> PathBuf {
    git_output(cwd, ["rev-parse", "--show-toplevel"])
        .map(|root| PathBuf::from(root.trim()))
        .unwrap_or_else(|_| cwd.to_path_buf())
}

fn is_git_repo(cwd: &Path) -> bool {
    git_output(cwd, ["rev-parse", "--is-inside-work-tree"])
        .map(|value| value.trim() == "true")
        .unwrap_or(false)
}

fn git_output<const N: usize>(cwd: &Path, args: [&str; N]) -> Result<String> {
    let output = Command::new("git").args(args).current_dir(cwd).output()?;
    if !output.status.success() {
        let message = String::from_utf8_lossy(&output.stderr).trim().to_string();
        anyhow::bail!(if message.is_empty() {
            "git command failed".to_string()
        } else {
            message
        });
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

fn git_output_args(cwd: &Path, args: &[&str]) -> Result<String> {
    let output = Command::new("git").args(args).current_dir(cwd).output()?;
    if !output.status.success() {
        let message = String::from_utf8_lossy(&output.stderr).trim().to_string();
        anyhow::bail!(if message.is_empty() {
            "git command failed".to_string()
        } else {
            message
        });
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

fn git_status_command(cwd: &Path, args: &[&str]) -> Result<()> {
    let output = Command::new("git").args(args).current_dir(cwd).output()?;
    if output.status.success() {
        return Ok(());
    }
    let message = String::from_utf8_lossy(&output.stderr).trim().to_string();
    anyhow::bail!(if message.is_empty() {
        "git command failed".to_string()
    } else {
        message
    });
}

fn diff_short_summary(run: &AgentRun) -> Option<String> {
    let status = git_output(&run.cwd, ["status", "--short"]).ok()?;
    if status.trim().is_empty() {
        return None;
    }
    let stat = git_output_args(&run.cwd, &["diff", "--shortstat", "HEAD"]).ok();
    if let Some(stat) = stat
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    {
        return Some(stat);
    }
    let files = status.lines().count();
    Some(format!(
        "{files} file{} changed",
        if files == 1 { "" } else { "s" }
    ))
}

fn play_completion_sound() {
    let Some(sound_path) = completion_sound_path() else {
        return;
    };

    #[cfg(target_os = "macos")]
    {
        let _ = Command::new("afplay")
            .arg(sound_path)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn();
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = Command::new("ffplay")
            .args(["-nodisp", "-autoexit", "-loglevel", "quiet"])
            .arg(sound_path)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn();
    }
}

fn completion_sound_path() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("RUDDER_COMPLETION_SOUND").map(PathBuf::from) {
        if path.is_file() {
            return Some(path);
        }
    }

    let mut candidates = Vec::new();
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("assets/sounds/ping.mp3"));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(native_dir) = exe.parent() {
            candidates.push(native_dir.join("../../assets/sounds/ping.mp3"));
            candidates.push(native_dir.join("../../../assets/sounds/ping.mp3"));
        }
    }

    candidates.into_iter().find(|path| path.is_file())
}

fn has_git_changes(cwd: &Path) -> bool {
    git_output(cwd, ["status", "--short"])
        .map(|status| !status.trim().is_empty())
        .unwrap_or(false)
}

fn worktree_path(repo_root: &Path, run_id: &str) -> PathBuf {
    let parent = repo_root.parent().unwrap_or(repo_root);
    let repo_name = format!(
        "{}-{}",
        slugify(
            repo_root
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("repo"),
            "repo"
        ),
        short_hash(&repo_root.display().to_string())
    );
    parent
        .join(".rudder-worktrees")
        .join(repo_name)
        .join(run_id)
}

fn write_rudder_context(
    repo_root: &Path,
    agents: &[AgentRun],
    pending: Option<&WorktreeInfo>,
) -> Result<()> {
    ensure_gitignore_contains(repo_root, "RUDDER.md")?;
    let mut body = String::from("# Rudder Context\n\nActive local Rudder agents:\n");
    if agents.is_empty() && pending.is_none() {
        body.push_str("- none\n");
    }
    for agent in agents {
        body.push_str(&format!(
            "- {}: {} [{} {}] cwd={}\n",
            agent.id,
            agent.task,
            agent.backend.as_str(),
            agent.model,
            agent.cwd.display()
        ));
    }
    if let Some(worktree) = pending {
        body.push_str(&format!(
            "- starting: cwd={} branch={}\n",
            worktree.path.display(),
            worktree.branch.as_deref().unwrap_or("current")
        ));
    }
    body.push_str(
        "\nRead this file before making changes so you know what other Rudder agents are doing.\n",
    );
    body.push_str(
        "\nHunk review: Rudder opens `hunk diff --watch` in the review pane. If a live Hunk review is open, run `hunk skill path`, load that skill, then use `hunk session review --repo . --json` to inspect the review and `hunk session comment add/apply --repo .` to leave inline notes for the user.\n",
    );
    fs::write(repo_root.join("RUDDER.md"), body.as_bytes())?;
    if let Some(worktree) = pending {
        if worktree.path_is_worktree {
            fs::write(worktree.path.join("RUDDER.md"), body.as_bytes())?;
        }
    }
    Ok(())
}

fn ensure_hunk_config(cwd: &Path) -> Result<()> {
    ensure_git_info_exclude_contains(cwd, ".hunk/")?;
    let dir = cwd.join(".hunk");
    fs::create_dir_all(&dir)?;
    let config = dir.join("config.toml");
    let contents = [
        "theme = \"paper\"",
        "mode = \"auto\"",
        "vcs = \"git\"",
        "exclude_untracked = false",
        "line_numbers = true",
        "wrap_lines = false",
        "agent_notes = true",
        "",
    ]
    .join("\n");
    fs::write(config, contents)?;
    Ok(())
}

fn ensure_git_info_exclude_contains(cwd: &Path, line: &str) -> Result<()> {
    let path = git_output(cwd, ["rev-parse", "--git-path", "info/exclude"])?;
    let trimmed = path.trim();
    let path = if Path::new(trimmed).is_absolute() {
        PathBuf::from(trimmed)
    } else {
        cwd.join(trimmed)
    };
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let existing = fs::read_to_string(&path).unwrap_or_default();
    if existing.lines().any(|existing| existing.trim() == line) {
        return Ok(());
    }
    let mut next = existing;
    if !next.ends_with('\n') && !next.is_empty() {
        next.push('\n');
    }
    next.push_str(line);
    next.push('\n');
    fs::write(path, next)?;
    Ok(())
}

fn ensure_gitignore_contains(repo_root: &Path, line: &str) -> Result<()> {
    let path = repo_root.join(".gitignore");
    let existing = fs::read_to_string(&path).unwrap_or_default();
    if existing
        .lines()
        .any(|existing_line| existing_line.trim() == line)
    {
        return Ok(());
    }
    let prefix = if existing.is_empty() || existing.ends_with('\n') {
        ""
    } else {
        "\n"
    };
    fs::write(path, format!("{existing}{prefix}{line}\n"))?;
    Ok(())
}

fn new_run_id(task: &str) -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    format!("{millis}-{}-{}", slugify(task, "task"), std::process::id())
}

fn id_short(id: &str) -> String {
    id.chars().take(14).collect()
}

fn slugify(input: &str, fallback: &str) -> String {
    let mut slug = String::new();
    let mut previous_dash = false;
    for ch in input.chars().flat_map(char::to_lowercase) {
        if ch.is_ascii_alphanumeric() {
            slug.push(ch);
            previous_dash = false;
        } else if !previous_dash && !slug.is_empty() {
            slug.push('-');
            previous_dash = true;
        }
        if slug.len() >= 48 {
            break;
        }
    }
    while slug.ends_with('-') {
        slug.pop();
    }
    if slug.is_empty() {
        fallback.to_string()
    } else {
        slug
    }
}

fn short_hash(value: &str) -> String {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    value.hash(&mut hasher);
    format!("{:010x}", hasher.finish())[..10].to_string()
}
