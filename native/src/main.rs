use std::{
    collections::HashSet,
    env, fs,
    hash::{Hash, Hasher},
    io::{self, Stdout, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::{Duration, Instant},
    time::{SystemTime, UNIX_EPOCH},
};

use anyhow::{bail, Context, Result};
use crossterm::{
    event::{
        self, DisableBracketedPaste, DisableMouseCapture, EnableBracketedPaste, EnableMouseCapture,
        Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers, KeyboardEnhancementFlags,
        MouseButton, MouseEvent, MouseEventKind, PopKeyboardEnhancementFlags,
        PushKeyboardEnhancementFlags,
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

const TICK_RATE: Duration = Duration::from_millis(16);
const MAX_EVENTS_PER_FRAME: usize = 16;
const AUTO_STEER_DELAY: Duration = Duration::from_secs(10);
const INTERACTIVE_COMPLETION_IDLE: Duration = Duration::from_secs(4);
const FOCUS_COLOR: Color = Color::Rgb(57, 255, 20);
const INACTIVE_COLOR: Color = Color::DarkGray;
const MODEL_COLOR: Color = Color::Magenta;
const RUNNING_COLOR: Color = Color::Yellow;
const DONE_COLOR: Color = Color::Gray;
const FAILED_COLOR: Color = Color::Red;
const MIN_WHEEL_SCROLL_ROWS: u16 = 6;
const MAX_WHEEL_SCROLL_ROWS: u16 = 18;
const TASK_HISTORY_LIMIT: usize = 100;

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

    fn parse(value: &str) -> Option<Self> {
        match value {
            "claude" | "anthropic" => Some(Self::Claude),
            "codex" | "openai" => Some(Self::Codex),
            _ => None,
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
    Stopped,
}

impl AgentStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Done => "done",
            Self::Failed => "failed",
            Self::Stopped => "stopped",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum AgentMode {
    Execute,
    Plan,
}

impl AgentMode {
    fn as_str(self) -> &'static str {
        match self {
            Self::Execute => "execute",
            Self::Plan => "plan",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        match value {
            "execute" | "run" | "task" => Some(Self::Execute),
            "plan" | "planning" => Some(Self::Plan),
            _ => None,
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
    task_history: Vec<String>,
    task_history_index: Option<usize>,
    task_history_draft: String,
    plan_mode: bool,
    agents: Vec<AgentRun>,
    selected_agent: usize,
    backend: Backend,
    model: String,
    effort: Option<EffortLevel>,
    notice: Option<String>,
    delete_pending: Option<String>,
    merge_confirm: Option<MergeConfirmation>,
    conflict_prompt: Option<MergeConflictPrompt>,
    picker_index: usize,
    worker_selection: Option<WorkerSelection>,
    task_selection: Option<WorkerSelection>,
    agents_area: Option<Rect>,
    worker_area: Option<Rect>,
    task_area: Option<Rect>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct SelectionPoint {
    row: usize,
    col: usize,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct WorkerSelection {
    start: SelectionPoint,
    end: SelectionPoint,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct NormalizedSelection {
    start: SelectionPoint,
    end: SelectionPoint,
}

struct MergeConfirmation {
    intent: MergeIntent,
}

enum MergeIntent {
    Selected { id: String, task: String },
    All { ids: Vec<String> },
}

struct MergeConflictPrompt {
    task: String,
    conflicted_files: Vec<String>,
    error: String,
}

struct AgentRun {
    id: String,
    created_at: String,
    mode: AgentMode,
    task: String,
    current_prompt: String,
    turns: Vec<AgentTurn>,
    last_user_input_at: String,
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
    worker_input_draft: String,
    worker_input_cursor: usize,
    worker_input_is_prompt: bool,
}

#[derive(Clone, Debug)]
struct AgentTurn {
    ts: String,
    prompt: String,
    source: String,
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

struct InitialSelection {
    backend: Backend,
    model: String,
    effort: Option<EffortLevel>,
}

#[derive(Default)]
struct CliSelection {
    backend: Option<Backend>,
    model: Option<String>,
}

impl App {
    fn new() -> Self {
        let cwd = std::env::current_dir()
            .map(|path| repo_root(&path))
            .unwrap_or_else(|_| PathBuf::from("."));
        let selection = initial_selection();
        let agents = if cfg!(test) {
            Vec::new()
        } else {
            load_persisted_agents(&cwd)
        };
        Self {
            focus: FocusPane::Task,
            nav_mode: false,
            worker_view: WorkerView::Terminal,
            cwd,
            branch: current_branch(),
            task_input: String::new(),
            task_cursor: 0,
            task_history: Vec::new(),
            task_history_index: None,
            task_history_draft: String::new(),
            plan_mode: false,
            agents,
            selected_agent: 0,
            backend: selection.backend,
            model: selection.model,
            effort: selection.effort,
            notice: None,
            delete_pending: None,
            merge_confirm: None,
            conflict_prompt: None,
            picker_index: 0,
            worker_selection: None,
            task_selection: None,
            agents_area: None,
            worker_area: None,
            task_area: None,
        }
    }

    fn set_model_defaults(
        &mut self,
        backend: Backend,
        model: String,
        effort: Option<EffortLevel>,
    ) -> Option<String> {
        self.backend = backend;
        self.model = model;
        self.effort = effort;
        save_model_defaults(self.backend, &self.model, self.effort)
            .err()
            .map(|error| format!("config warning: {error}"))
    }

    fn handle_key(&mut self, key: KeyEvent) -> bool {
        if key.modifiers.contains(KeyModifiers::CONTROL) && key.code == KeyCode::Char('c') {
            return true;
        }

        if is_copy_key(key) {
            self.copy_focused_selection();
            return false;
        }

        if self.handle_merge_prompt_key(key) {
            return false;
        }

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

        match key.code {
            KeyCode::Tab => {
                self.delete_pending = None;
                self.focus = self.focus.next();
                return false;
            }
            KeyCode::BackTab => {
                self.delete_pending = None;
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
                self.delete_pending = None;
                self.notice = Some("worker input restored".to_string());
            }
            KeyCode::Tab => {
                self.delete_pending = None;
                self.focus = self.focus.next();
            }
            KeyCode::BackTab => {
                self.delete_pending = None;
                self.focus = self.focus.previous();
            }
            KeyCode::Char('1') => {
                self.delete_pending = None;
                self.focus = FocusPane::Agents;
            }
            KeyCode::Char('2') => {
                self.delete_pending = None;
                self.focus = FocusPane::Worker;
            }
            KeyCode::Char('3') => {
                self.delete_pending = None;
                self.focus = FocusPane::Task;
            }
            KeyCode::Char('v') => self.toggle_worker_view(),
            KeyCode::Char('r') => self.restart_selected_agent(),
            KeyCode::Up | KeyCode::Char('k') => self.select_previous_agent(),
            KeyCode::Down | KeyCode::Char('j') => self.select_next_agent(),
            KeyCode::Char('m') => self.request_merge_selected_agent(),
            KeyCode::Char('M') => self.request_merge_all_ready(),
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
                    self.delete_pending = None;
                    self.focus = FocusPane::Worker;
                }
            }
            KeyCode::Char('v') => self.toggle_worker_view(),
            KeyCode::Char('r') => self.restart_selected_agent(),
            KeyCode::Char('M') => self.request_merge_all_ready(),
            KeyCode::Char('m') => self.request_merge_selected_agent(),
            KeyCode::Char('d') => self.delete_selected_agent(),
            _ => {}
        }
        false
    }

    fn handle_worker_key(&mut self, key: KeyEvent) -> bool {
        if self.worker_view == WorkerView::Diff {
            match key.code {
                KeyCode::Esc | KeyCode::Char('v') => {
                    self.worker_view = WorkerView::Terminal;
                    self.notice = None;
                    return false;
                }
                KeyCode::Char('m') if !key.modifiers.contains(KeyModifiers::CONTROL) => {
                    self.request_merge_selected_agent();
                    return false;
                }
                _ => {}
            }

            if self.selected_review_terminal_mut().is_none() {
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

        self.worker_selection = None;
        if self.selected_terminal_mut().is_none() {
            match key.code {
                KeyCode::Char('r') => {
                    self.restart_selected_agent();
                    return false;
                }
                KeyCode::Char('q') => return true,
                _ => {}
            }
        }

        match key.code {
            KeyCode::PageUp => {
                self.handle_worker_page_key(key, page_scroll_rows(self.worker_area));
                return false;
            }
            KeyCode::PageDown => {
                self.handle_worker_page_key(key, -page_scroll_rows(self.worker_area));
                return false;
            }
            _ => {}
        }

        let Some(bytes) = terminal_bytes_for_key(key) else {
            return false;
        };

        let capture_as_prompt = self.selected_worker_accepts_prompt_input();
        let result = match self.selected_terminal_mut() {
            Some(terminal) => {
                terminal.reset_scrollback();
                terminal.write_input(&bytes)
            }
            None => return false,
        };
        if let Err(error) = result {
            self.set_selected_error(error.to_string());
            return false;
        }
        if let Some(prompt) = self.capture_selected_worker_key(key, capture_as_prompt) {
            self.record_selected_worker_prompt(prompt);
        }
        false
    }

    fn copy_focused_selection(&mut self) {
        let text = match self.focus {
            FocusPane::Worker if self.worker_view == WorkerView::Terminal => {
                let Some(selection) = self.worker_selection else {
                    return;
                };
                self.selected_worker_selection_text(selection)
            }
            FocusPane::Task => {
                let Some(selection) = self.task_selection else {
                    return;
                };
                let width = self
                    .task_area
                    .map(block_inner)
                    .map(task_inner_width)
                    .unwrap_or(80);
                let lines = task_input_lines(&self.task_input, self.task_cursor, width);
                selected_text_from_lines(&lines, selection)
            }
            _ => return,
        };

        if text.trim().is_empty() {
            return;
        }

        match copy_text_to_clipboard(&text) {
            Ok(()) => {
                self.notice = Some(match self.focus {
                    FocusPane::Worker => "copied worker selection".to_string(),
                    FocusPane::Task => "copied task selection".to_string(),
                    FocusPane::Agents => "copied selection".to_string(),
                });
            }
            Err(error) => self.notice = Some(format!("copy failed: {error}")),
        }
    }

    fn select_previous_agent(&mut self) {
        self.delete_pending = None;
        self.selected_agent = self.selected_agent.saturating_sub(1);
    }

    fn select_next_agent(&mut self) {
        self.delete_pending = None;
        let last = self.agents.len().saturating_sub(1);
        self.selected_agent = (self.selected_agent + 1).min(last);
    }

    fn toggle_worker_view(&mut self) {
        self.worker_selection = None;
        self.worker_view = match self.worker_view {
            WorkerView::Terminal => {
                self.ensure_hunk_review();
                WorkerView::Diff
            }
            WorkerView::Diff => {
                self.notice = None;
                WorkerView::Terminal
            }
        };
        self.focus = FocusPane::Worker;
    }

    fn handle_task_key(&mut self, key: KeyEvent) -> bool {
        self.task_selection = None;
        if self.task_history_index.is_some() {
            match key.code {
                KeyCode::Up => {
                    self.show_previous_task_history();
                    return false;
                }
                KeyCode::Down => {
                    self.show_next_task_history();
                    return false;
                }
                _ => {}
            }
        }

        if self.handle_picker_key(key) {
            return false;
        }

        match key.code {
            KeyCode::Esc => {
                self.reset_task_history_navigation();
                self.task_input.clear();
                self.task_cursor = 0;
                self.picker_index = 0;
            }
            KeyCode::Enter => self.start_task(),
            KeyCode::Up => self.show_previous_task_history(),
            KeyCode::Down => self.show_next_task_history(),
            KeyCode::Backspace => {
                self.reset_task_history_navigation();
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
                self.reset_task_history_navigation();
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
                self.reset_task_history_navigation();
                self.task_input.clear();
                self.task_cursor = 0;
                self.picker_index = 0;
            }
            KeyCode::Char('w') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                self.reset_task_history_navigation();
                delete_previous_word_at(&mut self.task_input, &mut self.task_cursor);
                self.clamp_picker_index();
            }
            KeyCode::Char('/') if self.task_input.is_empty() => {
                self.reset_task_history_navigation();
                self.task_input.push('/');
                self.task_cursor = 1;
                self.picker_index = 0;
                self.notice =
                    Some("type /plan, /run, /model, /login, /cloud, or /sail".to_string());
            }
            KeyCode::Char(ch) => {
                self.reset_task_history_navigation();
                insert_char_at_cursor(&mut self.task_input, &mut self.task_cursor, ch);
                self.clamp_picker_index();
            }
            _ => {}
        }
        false
    }

    fn show_previous_task_history(&mut self) {
        if let Some(value) = previous_task_history_entry(
            &self.task_history,
            &mut self.task_history_index,
            &mut self.task_history_draft,
            &self.task_input,
        ) {
            self.replace_task_input(value);
        }
    }

    fn show_next_task_history(&mut self) {
        if let Some(value) = next_task_history_entry(
            &self.task_history,
            &mut self.task_history_index,
            &mut self.task_history_draft,
        ) {
            self.replace_task_input(value);
        }
    }

    fn replace_task_input(&mut self, value: String) {
        self.task_input = value;
        self.task_cursor = self.task_input.chars().count();
        self.task_selection = None;
        self.picker_index = 0;
        self.clamp_picker_index();
    }

    fn reset_task_history_navigation(&mut self) {
        self.task_history_index = None;
        self.task_history_draft.clear();
    }

    fn remember_task_history(&mut self, input: &str) {
        if input.trim().is_empty() {
            return;
        }
        self.task_history.push(input.to_string());
        if self.task_history.len() > TASK_HISTORY_LIMIT {
            let overflow = self.task_history.len() - TASK_HISTORY_LIMIT;
            self.task_history.drain(0..overflow);
        }
        self.reset_task_history_navigation();
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
        self.reset_task_history_navigation();
        match suggestion.action {
            SuggestionAction::Insert(value) => {
                self.replace_task_input(value);
            }
            SuggestionAction::ChooseModelProvider(backend) => {
                self.replace_task_input(format!("/model {} ", backend.as_str()));
                self.notice = Some(format!("pick a {} model", backend.as_str()));
            }
            SuggestionAction::ChooseModel { backend, model } => {
                self.replace_task_input(format!("/model {} {} ", backend.as_str(), model));
                self.notice = Some(format!("pick effort for {model}"));
            }
            SuggestionAction::SetModel {
                backend,
                model,
                effort,
            } => {
                let warning = self.set_model_defaults(backend, model, effort);
                self.task_input.clear();
                self.task_cursor = 0;
                self.picker_index = 0;
                self.notice = warning.or_else(|| {
                    Some(format!(
                        "{} {}({})",
                        self.backend.as_str(),
                        self.model,
                        effort_label(self.effort)
                    ))
                });
            }
            SuggestionAction::ShowHelp => {
                self.task_input.clear();
                self.task_cursor = 0;
                self.picker_index = 0;
                self.notice = Some(
                    "Tab focus  Enter start/focus  wheel scrolls worker  m/M merge  dd delete"
                        .to_string(),
                );
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
                self.worker_selection = None;
                if self.worker_view == WorkerView::Diff {
                    if let Some(terminal) = self.selected_review_terminal_mut() {
                        if let Err(error) = terminal.write_input(text.as_bytes()) {
                            self.set_selected_review_error(error.to_string());
                        }
                    }
                } else {
                    let capture_as_prompt = self.selected_worker_accepts_prompt_input();
                    let result = match self.selected_terminal_mut() {
                        Some(terminal) => {
                            terminal.reset_scrollback();
                            terminal.write_input(&bracketed_paste_bytes(&text))
                        }
                        None => return,
                    };
                    if let Err(error) = result {
                        self.set_selected_error(error.to_string());
                        return;
                    }
                    let prompts = self.capture_selected_worker_paste(&text, capture_as_prompt);
                    for prompt in prompts {
                        self.record_selected_worker_prompt(prompt);
                    }
                }
            }
            FocusPane::Task => {
                self.reset_task_history_navigation();
                insert_str_at_cursor(&mut self.task_input, &mut self.task_cursor, &text);
                self.clamp_picker_index();
            }
            FocusPane::Agents => {}
        }
    }

    fn selected_worker_accepts_prompt_input(&self) -> bool {
        let Some(run) = self.agents.get(self.selected_agent) else {
            return false;
        };
        if run.needs_permission {
            return false;
        }
        if matches!(run.status, AgentStatus::Done | AgentStatus::Stopped) {
            return true;
        }
        run.terminal.as_ref().is_some_and(|terminal| {
            terminal_looks_ready_for_input_from_lines(
                run.backend,
                &terminal.visible_lines_snapshot(),
            )
        })
    }

    fn capture_selected_worker_key(
        &mut self,
        key: KeyEvent,
        capture_as_prompt: bool,
    ) -> Option<String> {
        let run = self.agents.get_mut(self.selected_agent)?;
        update_worker_prompt_draft_for_key(
            &mut run.worker_input_draft,
            &mut run.worker_input_cursor,
            &mut run.worker_input_is_prompt,
            key,
            capture_as_prompt,
        )
    }

    fn capture_selected_worker_paste(
        &mut self,
        text: &str,
        capture_as_prompt: bool,
    ) -> Vec<String> {
        let Some(run) = self.agents.get_mut(self.selected_agent) else {
            return Vec::new();
        };
        update_worker_prompt_draft_for_paste(
            &mut run.worker_input_draft,
            &mut run.worker_input_cursor,
            &mut run.worker_input_is_prompt,
            text,
            capture_as_prompt,
        )
    }

    fn record_selected_worker_prompt(&mut self, prompt: String) {
        let prompt = prompt.trim().to_string();
        if prompt.is_empty() {
            return;
        }
        self.remember_task_history(&prompt);
        if let Some(run) = self.agents.get_mut(self.selected_agent) {
            record_agent_prompt(run, prompt, "user");
            let _ = save_native_run_record(&self.cwd, run);
        }
        let _ = write_rudder_context(&self.cwd, &self.agents, None);
    }

    fn handle_mouse(&mut self, mouse: MouseEvent) {
        if is_scroll_mouse_event(mouse.kind) {
            self.handle_pane_scroll(mouse);
            return;
        }

        if self.worker_selection.is_some()
            && matches!(
                mouse.kind,
                MouseEventKind::Drag(MouseButton::Left) | MouseEventKind::Up(MouseButton::Left)
            )
        {
            if let Some(worker_area) = self.worker_area {
                self.focus = FocusPane::Worker;
                self.task_selection = None;
                if self.handle_worker_selection_mouse(mouse, block_inner(worker_area)) {
                    return;
                }
            }
        }

        if let Some(task_area) = self
            .task_area
            .filter(|area| rect_contains(*area, mouse.column, mouse.row))
        {
            self.focus = FocusPane::Task;
            self.worker_selection = None;
            if self.handle_task_selection_mouse(mouse, block_inner(task_area)) {
                return;
            }
            return;
        }

        let Some(worker_area) = self
            .worker_area
            .filter(|area| rect_contains(*area, mouse.column, mouse.row))
        else {
            return;
        };

        self.focus = FocusPane::Worker;
        self.task_selection = None;
        let inner = block_inner(worker_area);

        if self.worker_view == WorkerView::Diff {
            if self.write_mouse_to_selected_review(mouse, inner) {
                return;
            }
            return;
        }

        if self.handle_worker_selection_mouse(mouse, inner) {
            return;
        }
        if self.write_mouse_to_selected_worker(mouse, inner) {
            return;
        }
    }

    fn handle_pane_scroll(&mut self, mouse: MouseEvent) {
        if let Some(area) = self
            .worker_area
            .filter(|area| rect_contains(*area, mouse.column, mouse.row))
        {
            let inner = block_inner(area);
            if self.worker_view == WorkerView::Diff {
                let _ = self.scroll_selected_review_or_forward(mouse, inner);
            } else {
                let _ = self.scroll_selected_worker_or_forward(mouse, inner);
            }
            return;
        }

        if self
            .agents_area
            .is_some_and(|area| rect_contains(area, mouse.column, mouse.row))
        {
            if matches!(mouse.kind, MouseEventKind::ScrollUp) {
                self.select_previous_agent();
            } else if matches!(mouse.kind, MouseEventKind::ScrollDown) {
                self.select_next_agent();
            }
            return;
        }

        if self
            .task_area
            .is_some_and(|area| rect_contains(area, mouse.column, mouse.row))
        {
            return;
        }
    }

    fn handle_worker_selection_mouse(&mut self, mouse: MouseEvent, area: Rect) -> bool {
        if self.selected_terminal_mut().is_none() {
            self.worker_selection = None;
            return false;
        }

        match mouse.kind {
            MouseEventKind::Down(MouseButton::Left) => {
                self.worker_selection = Some(WorkerSelection {
                    start: selection_point_from_mouse(mouse, area),
                    end: selection_point_from_mouse(mouse, area),
                });
                true
            }
            MouseEventKind::Drag(MouseButton::Left) => {
                self.autoscroll_worker_selection(mouse, area);
                if let Some(selection) = self.worker_selection.as_mut() {
                    selection.end = selection_point_from_mouse(mouse, area);
                    true
                } else {
                    false
                }
            }
            MouseEventKind::Up(MouseButton::Left) => {
                let Some(mut selection) = self.worker_selection else {
                    return false;
                };
                selection.end = selection_point_from_mouse(mouse, area);
                self.worker_selection = Some(selection);
                if selection_is_empty(normalize_selection(selection)) {
                    self.worker_selection = None;
                    return true;
                }
                let text = self.selected_worker_selection_text(selection);
                if text.trim().is_empty() {
                    self.notice = Some("selection empty".to_string());
                    return true;
                }
                match copy_text_to_clipboard(&text) {
                    Ok(()) => self.notice = Some("copied worker selection".to_string()),
                    Err(error) => self.notice = Some(format!("copy failed: {error}")),
                }
                true
            }
            _ => false,
        }
    }

    fn autoscroll_worker_selection(&mut self, mouse: MouseEvent, area: Rect) {
        let rows = if mouse.row < area.y {
            1
        } else if mouse.row >= area.bottom() {
            -1
        } else {
            0
        };
        if rows == 0 {
            return;
        }
        if let Some(terminal) = self.selected_terminal_mut() {
            terminal.scrollback_by(rows);
        }
    }

    fn handle_task_selection_mouse(&mut self, mouse: MouseEvent, area: Rect) -> bool {
        let Some(point) = task_selection_point_from_mouse(self, mouse, area) else {
            return false;
        };

        match mouse.kind {
            MouseEventKind::Down(MouseButton::Left) => {
                self.task_selection = Some(WorkerSelection {
                    start: point,
                    end: point,
                });
                true
            }
            MouseEventKind::Drag(MouseButton::Left) => {
                if let Some(selection) = self.task_selection.as_mut() {
                    selection.end = point;
                    true
                } else {
                    false
                }
            }
            MouseEventKind::Up(MouseButton::Left) => {
                let Some(mut selection) = self.task_selection else {
                    self.task_cursor = task_cursor_from_selection_point(
                        &self.task_input,
                        point,
                        task_inner_width(area),
                    );
                    return true;
                };
                selection.end = point;
                self.task_selection = Some(selection);
                let normalized = normalize_selection(selection);
                if selection_is_empty(normalized) {
                    self.task_selection = None;
                    self.task_cursor = task_cursor_from_selection_point(
                        &self.task_input,
                        point,
                        task_inner_width(area),
                    );
                    return true;
                }
                let input_lines =
                    task_input_lines(&self.task_input, self.task_cursor, task_inner_width(area));
                let text = selected_text_from_lines(&input_lines, selection);
                if text.trim().is_empty() {
                    self.notice = Some("selection empty".to_string());
                    return true;
                }
                match copy_text_to_clipboard(&text) {
                    Ok(()) => self.notice = Some("copied task selection".to_string()),
                    Err(error) => self.notice = Some(format!("copy failed: {error}")),
                }
                true
            }
            _ => false,
        }
    }

    fn selected_worker_selection_text(&self, selection: WorkerSelection) -> String {
        let Some(run) = self.agents.get(self.selected_agent) else {
            return String::new();
        };
        let Some(terminal) = run.terminal.as_ref() else {
            return String::new();
        };
        selected_text_from_lines(&terminal.visible_lines_snapshot(), selection)
    }

    fn write_mouse_to_selected_worker(&mut self, mouse: MouseEvent, area: Rect) -> bool {
        let Some(bytes) = mouse_event_to_sgr(mouse, area) else {
            return false;
        };
        let result = match self.selected_terminal_mut() {
            Some(terminal) => {
                if !terminal.wants_sgr_mouse_events() {
                    return false;
                }
                terminal.reset_scrollback();
                terminal.write_input(&bytes)
            }
            None => return false,
        };
        if let Err(error) = result {
            self.set_selected_error(error.to_string());
        }
        true
    }

    fn scroll_selected_worker_or_forward(&mut self, mouse: MouseEvent, area: Rect) -> bool {
        let rows = mouse_scrollback_delta(mouse, area.height);
        let mouse_bytes = mouse_event_to_sgr(mouse, area);
        let Some(terminal) = self.selected_terminal_mut() else {
            return false;
        };
        let before = terminal.scrollback();
        terminal.scrollback_by(rows);
        let moved = terminal.scrollback() != before;
        if moved {
            return true;
        }
        if rows != 0 && terminal.wants_sgr_mouse_events() {
            if let Some(bytes) = mouse_bytes {
                if let Err(error) = terminal.write_input(&bytes) {
                    self.set_selected_error(error.to_string());
                }
            }
            return true;
        }
        if rows != 0 {
            self.notice = Some("worker scrollback is at the edge".to_string());
        }
        true
    }

    fn write_mouse_to_selected_review(&mut self, mouse: MouseEvent, area: Rect) -> bool {
        let Some(bytes) = mouse_event_to_sgr(mouse, area) else {
            return false;
        };
        let result = match self.selected_review_terminal_mut() {
            Some(review) => {
                if !review.wants_sgr_mouse_events() {
                    return false;
                }
                review.reset_scrollback();
                review.write_input(&bytes)
            }
            None => return false,
        };
        if let Err(error) = result {
            self.set_selected_review_error(error.to_string());
        }
        true
    }

    fn scroll_selected_review_or_forward(&mut self, mouse: MouseEvent, area: Rect) -> bool {
        let rows = mouse_scrollback_delta(mouse, area.height);
        let mouse_bytes = mouse_event_to_sgr(mouse, area);
        let Some(review) = self.selected_review_terminal_mut() else {
            return false;
        };
        let before = review.scrollback();
        review.scrollback_by(rows);
        let moved = review.scrollback() != before;
        if moved {
            return true;
        }
        if rows != 0 && review.wants_sgr_mouse_events() {
            if let Some(bytes) = mouse_bytes {
                if let Err(error) = review.write_input(&bytes) {
                    self.set_selected_review_error(error.to_string());
                }
            }
            return true;
        }
        if rows != 0 {
            self.notice = Some("review scrollback is at the edge".to_string());
        }
        true
    }

    fn handle_worker_page_key(&mut self, key: KeyEvent, rows: isize) {
        let Some(bytes) = terminal_bytes_for_key(key) else {
            return;
        };
        let result = match self.selected_terminal_mut() {
            Some(terminal) => {
                if terminal.uses_alternate_screen() {
                    terminal.write_input(&bytes)
                } else {
                    terminal.scrollback_by(rows);
                    Ok(())
                }
            }
            None => return,
        };
        if let Err(error) = result {
            self.set_selected_error(error.to_string());
        }
    }

    fn start_task(&mut self) {
        let input = self.task_input.trim().to_string();
        if input.is_empty() {
            return;
        }
        self.remember_task_history(&input);
        self.task_input.clear();
        self.task_cursor = 0;
        self.worker_selection = None;

        if self.handle_command(&input) {
            return;
        }
        self.notice = None;

        if self.plan_mode {
            self.start_plan_task(&input);
        } else {
            self.start_execute_task(&input);
        }
    }

    fn start_execute_task(&mut self, input: &str) {
        let worktree = match prepare_worktree(&self.cwd, input) {
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
        let command = agent_command(backend, &model, effort, input, AgentMode::Execute);
        let options = TerminalPaneOptions {
            size: TerminalSize::default(),
            cwd: Some(worktree.path.clone()),
            ..TerminalPaneOptions::default()
        };

        let created_at = now_stamp();
        let mut run = AgentRun {
            id: worktree.id.clone(),
            created_at: created_at.clone(),
            mode: AgentMode::Execute,
            task: input.to_string(),
            current_prompt: input.to_string(),
            turns: vec![AgentTurn {
                ts: created_at.clone(),
                prompt: input.to_string(),
                source: "user".to_string(),
            }],
            last_user_input_at: created_at,
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
            worker_input_draft: String::new(),
            worker_input_cursor: 0,
            worker_input_is_prompt: false,
        };

        match TerminalPane::spawn_shell_or_command(Some(command), options) {
            Ok(mut terminal) => {
                let _ = terminal.drain_output();
                run.terminal = Some(terminal);
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
        if let Some(run) = self.agents.get(self.selected_agent) {
            let _ = save_native_run_record(&self.cwd, run);
        }
        let _ = write_rudder_context(&self.cwd, &self.agents, None);
    }

    fn start_plan_task(&mut self, input: &str) {
        let model = self.model.clone();
        let backend = self.backend;
        let effort = self.effort;
        let command = agent_command(backend, &model, effort, input, AgentMode::Plan);
        let options = TerminalPaneOptions {
            size: TerminalSize::default(),
            cwd: Some(self.cwd.clone()),
            ..TerminalPaneOptions::default()
        };

        let created_at = now_stamp();
        let mut run = AgentRun {
            id: new_run_id(input),
            created_at: created_at.clone(),
            mode: AgentMode::Plan,
            task: input.to_string(),
            current_prompt: input.to_string(),
            turns: vec![AgentTurn {
                ts: created_at.clone(),
                prompt: input.to_string(),
                source: "user".to_string(),
            }],
            last_user_input_at: created_at,
            backend,
            model,
            effort,
            status: AgentStatus::Running,
            cwd: self.cwd.clone(),
            worktree_branch: None,
            worktree_path: None,
            terminal: None,
            terminal_size: None,
            review_terminal: None,
            review_size: None,
            review_error: None,
            last_output_at: Instant::now(),
            completed_at: None,
            autosteered: true,
            needs_permission: false,
            permission_notified: false,
            last_error: None,
            worker_input_draft: String::new(),
            worker_input_cursor: 0,
            worker_input_is_prompt: false,
        };

        match TerminalPane::spawn_shell_or_command(Some(command), options) {
            Ok(mut terminal) => {
                let _ = terminal.drain_output();
                run.terminal = Some(terminal);
                self.notice = Some("read-only planner started".to_string());
            }
            Err(error) => {
                run.status = AgentStatus::Failed;
                run.last_error = Some(error.to_string());
                self.notice = Some(format!(
                    "failed to start {} planner: {error}",
                    backend.as_str()
                ));
            }
        }

        self.agents.push(run);
        self.selected_agent = self.agents.len().saturating_sub(1);
        self.delete_pending = None;
        self.focus = FocusPane::Worker;
        if let Some(run) = self.agents.get(self.selected_agent) {
            let _ = save_native_run_record(&self.cwd, run);
        }
    }

    fn restart_selected_agent(&mut self) {
        let Some(run) = self.agents.get_mut(self.selected_agent) else {
            self.notice = Some("no agent selected".to_string());
            return;
        };
        if run.terminal.is_some() && run.status == AgentStatus::Running {
            self.notice = Some("selected agent is already running".to_string());
            return;
        }

        let prompt = run.task.clone();
        let command = agent_command(run.backend, &run.model, run.effort, &prompt, run.mode);
        let options = TerminalPaneOptions {
            size: run.terminal_size.unwrap_or_default(),
            cwd: Some(run.cwd.clone()),
            ..TerminalPaneOptions::default()
        };

        match TerminalPane::spawn_shell_or_command(Some(command), options) {
            Ok(mut terminal) => {
                let _ = terminal.drain_output();
                run.terminal = Some(terminal);
                run.status = AgentStatus::Running;
                run.completed_at = None;
                run.last_output_at = Instant::now();
                run.autosteered = run.mode == AgentMode::Plan;
                run.needs_permission = false;
                run.permission_notified = false;
                run.last_error = None;
                self.focus = FocusPane::Worker;
                self.worker_view = WorkerView::Terminal;
                self.notice = Some(format!("restarted {}", short_task(&run.task)));
                let _ = save_native_run_record(&self.cwd, run);
                let _ = write_rudder_context(&self.cwd, &self.agents, None);
            }
            Err(error) => {
                run.status = AgentStatus::Failed;
                run.last_error = Some(error.to_string());
                self.notice = Some(format!("restart failed: {error}"));
                let _ = save_native_run_record(&self.cwd, run);
            }
        }
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
                        let warning = self.set_model_defaults(
                            backend,
                            (*model).to_string(),
                            default_effort_for(backend, model),
                        );
                        self.notice = warning.or_else(|| {
                            Some(format!(
                                "{} {}({})",
                                self.backend.as_str(),
                                self.model,
                                effort_label(self.effort)
                            ))
                        });
                    }
                    [provider, model, effort, ..] if provider_backend(provider).is_some() => {
                        let backend = provider_backend(provider).unwrap();
                        let parsed_effort = parse_effort_arg(effort);
                        let warning =
                            self.set_model_defaults(backend, (*model).to_string(), parsed_effort);
                        self.notice = warning.or_else(|| {
                            Some(format!(
                                "{} {}({})",
                                self.backend.as_str(),
                                self.model,
                                effort_label(self.effort)
                            ))
                        });
                    }
                    _ => {
                        let model = args.join(" ");
                        let backend = backend_for_model(&model);
                        let effort = default_effort_for(backend, &model);
                        let warning = self.set_model_defaults(backend, model, effort);
                        self.notice = warning.or_else(|| {
                            Some(format!(
                                "{} {}({})",
                                self.backend.as_str(),
                                self.model,
                                effort_label(self.effort)
                            ))
                        });
                    }
                }
                true
            }
            Some("/plan") => {
                let task = parts.collect::<Vec<_>>().join(" ");
                if task.trim().is_empty() {
                    self.plan_mode = !self.plan_mode;
                    self.notice = Some(if self.plan_mode {
                        "plan mode on: Enter starts a read-only planner".to_string()
                    } else {
                        "plan mode off".to_string()
                    });
                } else {
                    self.start_plan_task(task.trim());
                }
                true
            }
            Some("/run") => {
                let task = parts.collect::<Vec<_>>().join(" ");
                if task.trim().is_empty() {
                    self.notice = Some("usage: /run <task>".to_string());
                } else {
                    self.start_execute_task(task.trim());
                }
                true
            }
            Some("/help") => {
                self.notice = Some(
                    "Tab focus  Enter start/focus  /plan  /run  /model  wheel scrolls worker  m/M merge"
                        .to_string(),
                );
                true
            }
            Some("/login") => {
                self.start_rudder_cli_command("cloud login", vec!["login".to_string()]);
                true
            }
            Some("/cloud") => {
                let args = self.cloud_command_args(parts.collect::<Vec<_>>());
                self.start_rudder_cli_command("cloud", args);
                true
            }
            Some("/sail") => {
                let mut args = vec!["cloud".to_string(), "sail".to_string()];
                args.extend(parts.map(ToString::to_string));
                self.start_rudder_cli_command("sail", args);
                true
            }
            _ => false,
        }
    }

    fn cloud_command_args(&self, args: Vec<&str>) -> Vec<String> {
        if args.is_empty() {
            return vec!["cloud".to_string()];
        }
        if args[0] == "onload" && args.len() == 1 {
            if let Some(run) = self.agents.get(self.selected_agent) {
                return vec!["cloud".to_string(), "onload".to_string(), run.id.clone()];
            }
        }
        let known = [
            "list", "onload", "sail", "pause", "resume", "status", "stop", "logs",
        ];
        let mut command = vec!["cloud".to_string()];
        if known.contains(&args[0]) {
            command.extend(args.into_iter().map(ToString::to_string));
        } else {
            command.push("sail".to_string());
            command.extend(args.into_iter().map(ToString::to_string));
        }
        command
    }

    fn start_rudder_cli_command(&mut self, label: &str, args: Vec<String>) {
        let id = new_run_id(label);
        let command = TerminalCommand::with_args("rudder", args);
        let options = TerminalPaneOptions {
            size: TerminalSize::default(),
            cwd: Some(self.cwd.clone()),
            ..TerminalPaneOptions::default()
        };
        let created_at = now_stamp();
        let task = label.to_string();
        let mut run = AgentRun {
            id,
            created_at: created_at.clone(),
            mode: AgentMode::Execute,
            task: task.clone(),
            current_prompt: task.clone(),
            turns: vec![AgentTurn {
                ts: created_at.clone(),
                prompt: task.clone(),
                source: "user".to_string(),
            }],
            last_user_input_at: created_at,
            backend: self.backend,
            model: self.model.clone(),
            effort: self.effort,
            status: AgentStatus::Running,
            cwd: self.cwd.clone(),
            worktree_branch: None,
            worktree_path: None,
            terminal: None,
            terminal_size: None,
            review_terminal: None,
            review_size: None,
            review_error: None,
            last_output_at: Instant::now(),
            completed_at: None,
            autosteered: true,
            needs_permission: false,
            permission_notified: false,
            last_error: None,
            worker_input_draft: String::new(),
            worker_input_cursor: 0,
            worker_input_is_prompt: false,
        };
        match TerminalPane::spawn_shell_or_command(Some(command), options) {
            Ok(mut terminal) => {
                let _ = terminal.drain_output();
                run.terminal = Some(terminal);
                self.notice = Some(format!("opened {label}"));
            }
            Err(error) => {
                run.status = AgentStatus::Failed;
                run.last_error = Some(error.to_string());
                self.notice = Some(format!("{label} failed: {error}"));
            }
        }
        self.agents.push(run);
        self.selected_agent = self.agents.len().saturating_sub(1);
        self.delete_pending = None;
        self.focus = FocusPane::Worker;
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
                "theme=\"${RUDDER_HUNK_THEME:-paper}\"; if [ \"$theme\" = light ]; then theme=paper; fi; if command -v hunk >/dev/null 2>&1; then exec hunk diff --watch --theme \"$theme\"; fi; if command -v hunkdiff >/dev/null 2>&1; then exec hunkdiff diff --watch --theme \"$theme\"; fi; while :; do printf '\\033[2J\\033[H'; git status --short; printf '\\n'; git diff --stat HEAD; printf '\\n'; git diff --color=always HEAD; sleep 2; done",
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
                self.notice = Some("opening review".to_string());
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
        if self.delete_pending.as_deref() != Some(&selected.id) {
            self.delete_pending = Some(selected.id.clone());
            self.notice = Some(
                if selected.worktree_path.is_some() && has_git_changes(&selected.cwd) {
                    "worktree has changes: press m to merge, or d again to delete".to_string()
                } else if selected.worktree_path.is_some() {
                    "press d again to delete agent and remove its worktree".to_string()
                } else {
                    "press d again to delete agent".to_string()
                },
            );
            return;
        }

        let run = self.agents.remove(self.selected_agent);
        let _ = remove_native_run_record(&self.cwd, &run.id);
        let worktree_error = run.worktree_path.as_ref().and_then(|path| {
            let output = Command::new("git")
                .args(["worktree", "remove", "--force"])
                .arg(path)
                .current_dir(&self.cwd)
                .output()
                .ok()?;
            if output.status.success() {
                None
            } else {
                let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
                Some(if stderr.is_empty() {
                    "failed to remove worktree".to_string()
                } else {
                    format!("failed to remove worktree: {stderr}")
                })
            }
        });
        let last = self.agents.len().saturating_sub(1);
        self.selected_agent = self.selected_agent.min(last);
        self.delete_pending = None;
        self.notice = Some(worktree_error.unwrap_or_else(|| {
            if run.worktree_path.is_some() {
                "deleted agent and removed worktree".to_string()
            } else {
                "deleted agent from dashboard".to_string()
            }
        }));
        let _ = write_rudder_context(&self.cwd, &self.agents, None);
    }

    fn request_merge_selected_agent(&mut self) {
        let Some(run) = self.agents.get(self.selected_agent) else {
            self.notice = Some("no agent selected".to_string());
            return;
        };
        if run.worktree_branch.is_none() {
            self.notice = Some("selected agent has no worktree to merge".to_string());
            return;
        }
        self.merge_confirm = Some(MergeConfirmation {
            intent: MergeIntent::Selected {
                id: run.id.clone(),
                task: run.task.clone(),
            },
        });
        self.conflict_prompt = None;
        self.notice = Some(format!(
            "merge {}? press y to confirm or n to cancel",
            short_task(&run.task)
        ));
    }

    fn request_merge_all_ready(&mut self) {
        let ready = self
            .agents
            .iter()
            .filter(|run| run.status == AgentStatus::Done && run.worktree_branch.is_some())
            .map(|run| run.id.clone())
            .collect::<Vec<_>>();

        if ready.is_empty() {
            self.notice = Some("no completed worktrees ready to merge".to_string());
            return;
        }

        self.merge_confirm = Some(MergeConfirmation {
            intent: MergeIntent::All { ids: ready.clone() },
        });
        self.conflict_prompt = None;
        self.notice = Some(format!(
            "merge {count} completed worktree{plural}? press y to confirm or n to cancel",
            count = ready.len(),
            plural = if ready.len() == 1 { "" } else { "s" }
        ));
    }

    fn handle_merge_prompt_key(&mut self, key: KeyEvent) -> bool {
        if self.merge_confirm.is_some() {
            match key.code {
                KeyCode::Char('y') | KeyCode::Char('Y') => self.confirm_pending_merge(),
                KeyCode::Char('n') | KeyCode::Char('N') | KeyCode::Esc => {
                    self.merge_confirm = None;
                    self.notice = Some("merge cancelled".to_string());
                }
                _ => {}
            }
            return true;
        }

        if self.conflict_prompt.is_some() {
            match key.code {
                KeyCode::Char('y') | KeyCode::Char('Y') => self.start_conflict_resolution_agent(),
                KeyCode::Char('n') | KeyCode::Char('N') | KeyCode::Esc => {
                    self.conflict_prompt = None;
                    self.notice =
                        Some("resolve the merge conflicts manually, then commit".to_string());
                }
                _ => {}
            }
            return true;
        }

        false
    }

    fn confirm_pending_merge(&mut self) {
        let Some(confirm) = self.merge_confirm.take() else {
            return;
        };

        match confirm.intent {
            MergeIntent::Selected { id, task } => {
                let Some(index) = self.agents.iter().position(|run| run.id == id) else {
                    self.notice = Some("selected agent no longer exists".to_string());
                    return;
                };
                match self.merge_agent_at(index) {
                    Ok(()) => {
                        self.delete_pending = None;
                        self.notice = Some("merged selected worktree".to_string());
                    }
                    Err(error) => self.handle_merge_error(task, error, None),
                }
            }
            MergeIntent::All { ids } => {
                let mut merged = 0;
                for id in ids {
                    let Some(index) = self.agents.iter().position(|run| run.id == id) else {
                        continue;
                    };
                    let task = self.agents[index].task.clone();
                    if let Err(error) = self.merge_agent_at(index) {
                        self.handle_merge_error(task, error, Some(merged));
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
        }
    }

    fn handle_merge_error(
        &mut self,
        task: String,
        error: anyhow::Error,
        merged_before_error: Option<usize>,
    ) {
        let conflicted_files = conflicted_files(&self.cwd);
        if conflicted_files.is_empty() {
            let prefix = merged_before_error
                .map(|count| format!("merge all stopped after {count}: "))
                .unwrap_or_else(|| "merge stopped: ".to_string());
            self.notice = Some(format!("{prefix}{error}"));
            return;
        }

        let count = conflicted_files.len();
        self.conflict_prompt = Some(MergeConflictPrompt {
            task,
            conflicted_files,
            error: error.to_string(),
        });
        self.notice = Some(format!(
            "merge conflict in {count} file{}: press y for AI help or n to resolve manually",
            if count == 1 { "" } else { "s" }
        ));
    }

    fn start_conflict_resolution_agent(&mut self) {
        let Some(prompt) = self.conflict_resolution_prompt() else {
            return;
        };
        self.conflict_prompt = None;

        let id = new_run_id("resolve merge conflicts");
        let command = agent_command(
            self.backend,
            &self.model,
            self.effort,
            &prompt,
            AgentMode::Execute,
        );
        let options = TerminalPaneOptions {
            size: TerminalSize::default(),
            cwd: Some(self.cwd.clone()),
            ..TerminalPaneOptions::default()
        };

        let created_at = now_stamp();
        let task = "Resolve merge conflicts".to_string();
        let mut run = AgentRun {
            id,
            created_at: created_at.clone(),
            mode: AgentMode::Execute,
            task: task.clone(),
            current_prompt: prompt.clone(),
            turns: vec![AgentTurn {
                ts: created_at.clone(),
                prompt: prompt.clone(),
                source: "user".to_string(),
            }],
            last_user_input_at: created_at,
            backend: self.backend,
            model: self.model.clone(),
            effort: self.effort,
            status: AgentStatus::Running,
            cwd: self.cwd.clone(),
            worktree_branch: None,
            worktree_path: None,
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
            worker_input_draft: String::new(),
            worker_input_cursor: 0,
            worker_input_is_prompt: false,
        };

        match TerminalPane::spawn_shell_or_command(Some(command), options) {
            Ok(mut terminal) => {
                let _ = terminal.drain_output();
                run.terminal = Some(terminal);
                self.agents.push(run);
                self.selected_agent = self.agents.len().saturating_sub(1);
                self.focus = FocusPane::Worker;
                self.notice = Some("started AI merge-conflict resolver".to_string());
                if let Some(run) = self.agents.get(self.selected_agent) {
                    let _ = save_native_run_record(&self.cwd, run);
                }
                let _ = write_rudder_context(&self.cwd, &self.agents, None);
            }
            Err(error) => {
                self.notice = Some(format!("failed to start AI resolver: {error}"));
            }
        }
    }

    fn conflict_resolution_prompt(&self) -> Option<String> {
        let prompt = self.conflict_prompt.as_ref()?;
        let files = if prompt.conflicted_files.is_empty() {
            "(git did not report conflicted files)".to_string()
        } else {
            prompt.conflicted_files.join("\n")
        };
        Some(format!(
            "[RUDDER PROMPT INJECTION]\nRead RUDDER.md first. A git merge for this Rudder task stopped with conflicts:\n\n{}\n\nConflicted files:\n{}\n\nGit reported:\n{}\n\nResolve the merge conflicts in this checkout. Inspect git status and the conflicted files, keep the intended changes from both sides where appropriate, run the relevant checks if possible, and tell me what you changed. Do not abort the merge unless resolving is impossible.\n[END RUDDER PROMPT INJECTION]",
            prompt.task, files, prompt.error
        ))
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
            let _ = save_native_run_record(&self.cwd, run);
        }
        Ok(())
    }

    fn poll_agents(&mut self) {
        let repo_root = self.cwd.clone();
        for run in &mut self.agents {
            let mut changed = false;
            let Some(terminal) = run.terminal.as_mut() else {
                continue;
            };
            let had_output = !terminal.drain_output().is_empty();
            if had_output {
                run.last_output_at = Instant::now();
                if run.status == AgentStatus::Done {
                    run.status = AgentStatus::Running;
                    run.completed_at = None;
                    changed = true;
                }
            }
            if run.status == AgentStatus::Running {
                let idle_enough = run.last_output_at.elapsed() >= INTERACTIVE_COMPLETION_IDLE;
                let visible_lines = if had_output || run.needs_permission || idle_enough {
                    Some(terminal.visible_lines_snapshot())
                } else {
                    None
                };
                let needs_permission = visible_lines
                    .as_ref()
                    .is_some_and(|lines| terminal_needs_permission_from_lines(lines));
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
                            changed = true;
                        } else {
                            run.status = AgentStatus::Failed;
                            run.completed_at = Some(Instant::now());
                            run.needs_permission = false;
                            run.permission_notified = false;
                            play_completion_sound();
                            changed = true;
                        };
                    }
                    Ok(None) => {
                        if idle_enough
                            && visible_lines.as_ref().is_some_and(|lines| {
                                terminal_looks_ready_for_input_from_lines(run.backend, lines)
                            })
                        {
                            mark_run_done(run);
                            changed = true;
                        }
                    }
                    Err(error) => {
                        run.status = AgentStatus::Failed;
                        run.completed_at = Some(Instant::now());
                        run.last_error = Some(error.to_string());
                        run.needs_permission = false;
                        run.permission_notified = false;
                        play_completion_sound();
                        changed = true;
                    }
                }
            } else {
                run.needs_permission = false;
                run.permission_notified = false;
            }
            if changed {
                let _ = save_native_run_record(&repo_root, run);
            }
        }

        let repo_root = self.cwd.clone();
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
                "[RUDDER PROMPT INJECTION]\nRead RUDDER.md first. Review the current diff and tests for this original task: {}. If anything remains, fix it and run the relevant checks. If it is complete, say what you verified.\n[END RUDDER PROMPT INJECTION]",
                run.task
            );
            let command = agent_command(
                run.backend,
                &run.model,
                run.effort,
                &prompt,
                AgentMode::Execute,
            );
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
                    record_agent_prompt(run, prompt, "steerer");
                    self.notice = Some(format!("auto-steering {}", short_task(&run.task)));
                    let _ = save_native_run_record(&repo_root, run);
                }
                Err(error) => {
                    run.status = AgentStatus::Failed;
                    run.last_error = Some(error.to_string());
                    let _ = save_native_run_record(&repo_root, run);
                }
            }
        }
    }

    fn shutdown(&mut self) {
        for run in &mut self.agents {
            if run.terminal.is_some() && run.status == AgentStatus::Running {
                run.terminal = None;
                run.status = AgentStatus::Stopped;
                run.needs_permission = false;
                run.permission_notified = false;
                run.completed_at = None;
                let _ = save_native_run_record(&self.cwd, run);
            }
        }
        let _ = write_rudder_context(&self.cwd, &self.agents, None);
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

fn terminal_looks_ready_for_input_from_lines(backend: Backend, lines: &[String]) -> bool {
    if terminal_needs_permission_from_lines(lines) {
        return false;
    }

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

fn terminal_needs_permission_from_lines(lines: &[String]) -> bool {
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

        let modified_scroll = MouseEvent {
            kind: MouseEventKind::ScrollUp,
            column: 12,
            row: 8,
            modifiers: KeyModifiers::CONTROL,
        };
        assert_eq!(
            mouse_event_to_sgr(modified_scroll, area),
            Some(b"\x1b[<80;3;4M".to_vec())
        );
    }

    #[test]
    fn worker_wheel_scroll_rows_scale_with_viewport() {
        assert_eq!(wheel_scroll_rows(6, KeyModifiers::empty()), 5);
        assert_eq!(wheel_scroll_rows(30, KeyModifiers::empty()), 10);
        assert_eq!(wheel_scroll_rows(90, KeyModifiers::empty()), 18);
        assert_eq!(wheel_scroll_rows(30, KeyModifiers::CONTROL), 29);

        let down = MouseEvent {
            kind: MouseEventKind::ScrollDown,
            column: 0,
            row: 0,
            modifiers: KeyModifiers::empty(),
        };
        assert_eq!(mouse_scrollback_delta(down, 30), -10);
    }

    #[cfg(not(windows))]
    #[test]
    fn focused_worker_wheel_scrolls_alternate_screen_history() {
        let command = TerminalCommand::with_args(
            "/bin/sh",
            [
                "-lc",
                "printf '\\033[?1049hfirst screen\\r\\n'; sleep 0.1; printf '\\033[2J\\033[Hsecond screen\\r\\n'; sleep 1",
            ],
        );
        let mut pane = TerminalPane::spawn_shell_or_command(
            Some(command),
            TerminalPaneOptions {
                size: TerminalSize { rows: 5, cols: 20 },
                scrollback_lines: 100,
                ..Default::default()
            },
        )
        .expect("spawn test pty");

        for _ in 0..20 {
            std::thread::sleep(Duration::from_millis(25));
            pane.drain_output();
            if pane.uses_alternate_screen()
                && pane
                    .visible_lines_snapshot()
                    .join("\n")
                    .contains("second screen")
            {
                break;
            }
        }

        assert!(pane.uses_alternate_screen());
        assert!(pane
            .visible_lines_snapshot()
            .join("\n")
            .contains("second screen"));

        let mut app = App::new();
        app.focus = FocusPane::Worker;
        app.worker_area = Some(Rect {
            x: 0,
            y: 0,
            width: 20,
            height: 7,
        });
        app.agents.push(test_agent_run_with_terminal(&app, pane));
        app.selected_agent = 0;

        app.handle_mouse(MouseEvent {
            kind: MouseEventKind::ScrollUp,
            column: 1,
            row: 1,
            modifiers: KeyModifiers::empty(),
        });

        let scrolled_up = app
            .selected_terminal_mut()
            .map(|terminal| terminal.visible_lines_snapshot().join("\n"))
            .unwrap_or_default();
        assert!(
            scrolled_up.contains("first screen"),
            "scrolled_up was {scrolled_up:?}"
        );

        app.handle_mouse(MouseEvent {
            kind: MouseEventKind::ScrollDown,
            column: 1,
            row: 1,
            modifiers: KeyModifiers::empty(),
        });

        let scrolled_down = app
            .selected_terminal_mut()
            .map(|terminal| terminal.visible_lines_snapshot().join("\n"))
            .unwrap_or_default();
        assert!(
            scrolled_down.contains("second screen"),
            "scrolled_down was {scrolled_down:?}"
        );
    }

    #[cfg(not(windows))]
    #[test]
    fn worker_wheel_forwards_to_inner_tui_when_scrollback_cannot_move() {
        let command = TerminalCommand::with_args(
            "/bin/sh",
            [
                "-lc",
                "stty raw -echo; printf '\\033[?1049h\\033[?1000h\\033[?1006h'; cat -v",
            ],
        );
        let mut pane = TerminalPane::spawn_shell_or_command(
            Some(command),
            TerminalPaneOptions {
                size: TerminalSize { rows: 5, cols: 20 },
                scrollback_lines: 100,
                ..Default::default()
            },
        )
        .expect("spawn test pty");

        for _ in 0..20 {
            std::thread::sleep(Duration::from_millis(25));
            pane.drain_output();
            if pane.uses_alternate_screen() && pane.wants_sgr_mouse_events() {
                break;
            }
        }

        assert!(pane.uses_alternate_screen());
        assert!(pane.wants_sgr_mouse_events());

        let mut app = App::new();
        app.worker_area = Some(Rect {
            x: 0,
            y: 0,
            width: 20,
            height: 7,
        });
        app.agents.push(test_agent_run_with_terminal(&app, pane));
        app.selected_agent = 0;

        app.handle_mouse(MouseEvent {
            kind: MouseEventKind::ScrollDown,
            column: 1,
            row: 1,
            modifiers: KeyModifiers::empty(),
        });

        std::thread::sleep(Duration::from_millis(50));
        let output = app
            .selected_terminal_mut()
            .map(|terminal| terminal.visible_lines().join("\n"))
            .unwrap_or_default();
        assert!(output.contains("^[[<65;1;1M"), "output was {output:?}");
    }

    #[cfg(not(windows))]
    #[test]
    fn worker_wheel_scroll_moves_normal_screen_scrollback() {
        let command = TerminalCommand::with_args(
            "/bin/sh",
            [
                "-lc",
                "i=1; while [ $i -le 40 ]; do printf 'line%03d\\r\\n' $i; i=$((i+1)); done; sleep 1",
            ],
        );
        let mut pane = TerminalPane::spawn_shell_or_command(
            Some(command),
            TerminalPaneOptions {
                size: TerminalSize { rows: 5, cols: 20 },
                scrollback_lines: 100,
                ..Default::default()
            },
        )
        .expect("spawn test pty");

        for _ in 0..20 {
            std::thread::sleep(Duration::from_millis(25));
            pane.drain_output();
            if pane.visible_lines_snapshot().join("\n").contains("line040") {
                break;
            }
        }

        let before = pane.visible_lines_snapshot().join("\n");
        assert!(before.contains("line040"), "before was {before:?}");

        let mut app = App::new();
        app.agents.push(test_agent_run_with_terminal(&app, pane));
        app.selected_agent = 0;

        let mouse = MouseEvent {
            kind: MouseEventKind::ScrollUp,
            column: 1,
            row: 1,
            modifiers: KeyModifiers::empty(),
        };
        assert!(app.scroll_selected_worker_or_forward(
            mouse,
            Rect {
                x: 0,
                y: 0,
                width: 20,
                height: 5,
            },
        ));

        let after = app
            .selected_terminal_mut()
            .map(|terminal| terminal.visible_lines_snapshot().join("\n"))
            .unwrap_or_default();
        assert_ne!(after, before);
        assert!(after.contains("line035"), "after was {after:?}");
    }

    #[cfg(not(windows))]
    #[test]
    fn wheel_scroll_routes_to_worker_under_pointer_even_when_task_is_focused() {
        let command = TerminalCommand::with_args(
            "/bin/sh",
            [
                "-lc",
                "i=1; while [ $i -le 40 ]; do printf 'line%03d\\r\\n' $i; i=$((i+1)); done; sleep 1",
            ],
        );
        let mut pane = TerminalPane::spawn_shell_or_command(
            Some(command),
            TerminalPaneOptions {
                size: TerminalSize { rows: 5, cols: 20 },
                scrollback_lines: 100,
                ..Default::default()
            },
        )
        .expect("spawn test pty");

        for _ in 0..20 {
            std::thread::sleep(Duration::from_millis(25));
            pane.drain_output();
            if pane.visible_lines_snapshot().join("\n").contains("line040") {
                break;
            }
        }

        let mut app = App::new();
        app.focus = FocusPane::Task;
        app.agents_area = Some(Rect {
            x: 0,
            y: 0,
            width: 20,
            height: 20,
        });
        app.worker_area = Some(Rect {
            x: 20,
            y: 0,
            width: 40,
            height: 7,
        });
        app.agents.push(test_agent_run_with_terminal(&app, pane));
        app.selected_agent = 0;

        app.handle_mouse(MouseEvent {
            kind: MouseEventKind::ScrollUp,
            column: 21,
            row: 1,
            modifiers: KeyModifiers::empty(),
        });

        let after = app
            .selected_terminal_mut()
            .map(|terminal| terminal.visible_lines_snapshot().join("\n"))
            .unwrap_or_default();
        assert!(after.contains("line035"), "after was {after:?}");
        assert_eq!(app.focus, FocusPane::Task);
    }

    #[cfg(not(windows))]
    #[test]
    fn wheel_over_task_does_not_scroll_worker() {
        let command = TerminalCommand::with_args(
            "/bin/sh",
            [
                "-lc",
                "i=1; while [ $i -le 40 ]; do printf 'line%03d\\r\\n' $i; i=$((i+1)); done; sleep 1",
            ],
        );
        let mut pane = TerminalPane::spawn_shell_or_command(
            Some(command),
            TerminalPaneOptions {
                size: TerminalSize { rows: 5, cols: 20 },
                scrollback_lines: 100,
                ..Default::default()
            },
        )
        .expect("spawn test pty");

        for _ in 0..20 {
            std::thread::sleep(Duration::from_millis(25));
            pane.drain_output();
            if pane.visible_lines_snapshot().join("\n").contains("line040") {
                break;
            }
        }

        let mut app = App::new();
        app.worker_area = Some(Rect {
            x: 0,
            y: 0,
            width: 40,
            height: 7,
        });
        app.task_area = Some(Rect {
            x: 0,
            y: 8,
            width: 40,
            height: 3,
        });
        app.agents.push(test_agent_run_with_terminal(&app, pane));
        app.selected_agent = 0;
        let before = app
            .selected_terminal_mut()
            .map(|terminal| terminal.visible_lines_snapshot().join("\n"))
            .unwrap_or_default();

        app.handle_mouse(MouseEvent {
            kind: MouseEventKind::ScrollUp,
            column: 1,
            row: 9,
            modifiers: KeyModifiers::empty(),
        });

        let after = app
            .selected_terminal_mut()
            .map(|terminal| terminal.visible_lines_snapshot().join("\n"))
            .unwrap_or_default();
        assert_eq!(after, before);
    }

    #[cfg(not(windows))]
    #[test]
    fn worker_drag_selection_above_pane_autoscrolls() {
        let command = TerminalCommand::with_args(
            "/bin/sh",
            [
                "-lc",
                "i=1; while [ $i -le 40 ]; do printf 'line%03d\\r\\n' $i; i=$((i+1)); done; sleep 1",
            ],
        );
        let mut pane = TerminalPane::spawn_shell_or_command(
            Some(command),
            TerminalPaneOptions {
                size: TerminalSize { rows: 5, cols: 20 },
                scrollback_lines: 100,
                ..Default::default()
            },
        )
        .expect("spawn test pty");

        for _ in 0..20 {
            std::thread::sleep(Duration::from_millis(25));
            pane.drain_output();
            if pane.visible_lines_snapshot().join("\n").contains("line040") {
                break;
            }
        }

        let mut app = App::new();
        app.agents.push(test_agent_run_with_terminal(&app, pane));
        app.selected_agent = 0;
        app.worker_selection = Some(WorkerSelection {
            start: SelectionPoint { row: 4, col: 0 },
            end: SelectionPoint { row: 4, col: 4 },
        });
        let area = Rect {
            x: 0,
            y: 5,
            width: 20,
            height: 5,
        };

        assert!(app.handle_worker_selection_mouse(
            MouseEvent {
                kind: MouseEventKind::Drag(MouseButton::Left),
                column: 1,
                row: 4,
                modifiers: KeyModifiers::empty(),
            },
            area,
        ));
        assert!(app
            .selected_terminal_mut()
            .is_some_and(|terminal| terminal.scrollback() > 0));
    }

    #[test]
    fn extracts_selected_worker_text_across_visible_lines() {
        let lines = vec![
            "first line".to_string(),
            "second line".to_string(),
            "third".to_string(),
        ];
        let selection = WorkerSelection {
            start: SelectionPoint { row: 0, col: 6 },
            end: SelectionPoint { row: 1, col: 5 },
        };

        assert_eq!(selected_text_from_lines(&lines, selection), "line\nsecond");
    }

    #[test]
    fn normalizes_reversed_worker_selection() {
        let lines = vec!["abcdef".to_string()];
        let selection = WorkerSelection {
            start: SelectionPoint { row: 0, col: 4 },
            end: SelectionPoint { row: 0, col: 1 },
        };

        assert_eq!(selected_text_from_lines(&lines, selection), "bcde");
    }

    #[test]
    fn maps_task_mouse_selection_to_wrapped_input() {
        let mut app = App::new();
        app.task_input = "abcdef".to_string();
        app.task_cursor = app.task_input.chars().count();
        app.notice = Some("hint".to_string());
        let area = Rect {
            x: 10,
            y: 4,
            width: 3,
            height: 8,
        };
        let mouse = MouseEvent {
            kind: MouseEventKind::Down(MouseButton::Left),
            column: 11,
            row: 5,
            modifiers: KeyModifiers::empty(),
        };

        assert_eq!(
            task_selection_point_from_mouse(&app, mouse, area),
            Some(SelectionPoint { row: 1, col: 1 })
        );
        assert_eq!(
            task_cursor_from_selection_point(&app.task_input, SelectionPoint { row: 1, col: 1 }, 3),
            4
        );
    }

    #[test]
    fn wraps_worker_paste_as_single_bracketed_paste_payload() {
        assert_eq!(
            bracketed_paste_bytes("hello\nworld"),
            b"\x1b[200~hello\nworld\x1b[201~".to_vec()
        );
    }

    #[test]
    fn maps_page_keys_for_terminal_passthrough() {
        assert_eq!(
            terminal_bytes_for_key(KeyEvent::new(KeyCode::PageUp, KeyModifiers::empty())),
            Some(b"\x1b[5~".to_vec())
        );
        assert_eq!(
            terminal_bytes_for_key(KeyEvent::new(KeyCode::PageDown, KeyModifiers::empty())),
            Some(b"\x1b[6~".to_vec())
        );
        assert_eq!(
            terminal_bytes_for_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::SHIFT)),
            Some(b"\x1b[13;2u".to_vec())
        );
    }

    #[test]
    fn command_copy_is_not_forwarded_to_embedded_terminal() {
        let command_c = KeyEvent::new(KeyCode::Char('c'), KeyModifiers::SUPER);
        let meta_c = KeyEvent::new(KeyCode::Char('c'), KeyModifiers::META);
        let control_c = KeyEvent::new(KeyCode::Char('c'), KeyModifiers::CONTROL);

        assert!(is_copy_key(command_c));
        assert!(is_copy_key(meta_c));
        assert_eq!(terminal_bytes_for_key(command_c), None);
        assert_eq!(terminal_bytes_for_key(meta_c), None);
        assert_eq!(terminal_bytes_for_key(control_c), Some(vec![0x03]));
    }

    #[test]
    fn plan_commands_use_read_only_backend_profiles() {
        let execute_codex = agent_command(
            Backend::Codex,
            "gpt-5.5",
            Some(EffortLevel::High),
            "implement the work",
            AgentMode::Execute,
        );
        assert!(execute_codex
            .args
            .iter()
            .any(|arg| arg == "--dangerously-bypass-approvals-and-sandbox"));
        assert!(execute_codex
            .args
            .iter()
            .any(|arg| arg == "--no-alt-screen"));

        let execute_claude = agent_command(
            Backend::Claude,
            "sonnet",
            None,
            "implement the work",
            AgentMode::Execute,
        );
        assert!(execute_claude
            .env
            .iter()
            .any(|(key, value)| key == "CLAUDE_CODE_NO_FLICKER" && value == "0"));

        let codex = agent_command(
            Backend::Codex,
            "gpt-5.5",
            Some(EffortLevel::High),
            "plan the work",
            AgentMode::Plan,
        );
        assert_eq!(codex.program, "codex");
        assert!(codex.args.iter().any(|arg| arg == "--no-alt-screen"));
        assert!(codex
            .args
            .windows(2)
            .any(|window| window[0] == "--sandbox" && window[1] == "read-only"));
        assert!(codex.args.iter().any(|arg| arg == "--search"));
        assert!(!codex
            .args
            .iter()
            .any(|arg| arg == "--dangerously-bypass-approvals-and-sandbox"));

        let claude = agent_command(
            Backend::Claude,
            "sonnet",
            None,
            "plan the work",
            AgentMode::Plan,
        );
        assert_eq!(claude.program, "claude");
        assert!(claude
            .env
            .iter()
            .any(|(key, value)| key == "CLAUDE_CODE_NO_FLICKER" && value == "0"));
        assert!(claude
            .args
            .windows(2)
            .any(|window| window[0] == "--permission-mode" && window[1] == "default"));
        assert!(claude
            .args
            .windows(2)
            .any(|window| window[0] == "--tools" && window[1].contains("WebSearch")));
        assert!(claude.args.iter().any(|arg| arg.contains("WebSearch")));
        assert!(!claude
            .args
            .windows(2)
            .any(|window| window[0] == "--allowedTools" && window[1].contains("Bash")));
        assert!(claude.args.iter().any(|arg| arg.contains("Write")));
        assert!(claude.args.iter().any(|arg| arg.contains("Bash")));
    }

    #[test]
    fn task_history_walks_backward_forward_and_restores_draft() {
        let history = vec![
            "first task".to_string(),
            "second task".to_string(),
            "third task".to_string(),
        ];
        let mut index = None;
        let mut draft = String::new();

        assert_eq!(
            previous_task_history_entry(&history, &mut index, &mut draft, "draft task").as_deref(),
            Some("third task")
        );
        assert_eq!(index, Some(2));
        assert_eq!(draft, "draft task");

        assert_eq!(
            previous_task_history_entry(&history, &mut index, &mut draft, "third task").as_deref(),
            Some("second task")
        );
        assert_eq!(
            previous_task_history_entry(&history, &mut index, &mut draft, "second task").as_deref(),
            Some("first task")
        );
        assert_eq!(
            previous_task_history_entry(&history, &mut index, &mut draft, "first task").as_deref(),
            Some("first task")
        );

        assert_eq!(
            next_task_history_entry(&history, &mut index, &mut draft).as_deref(),
            Some("second task")
        );
        assert_eq!(
            next_task_history_entry(&history, &mut index, &mut draft).as_deref(),
            Some("third task")
        );
        assert_eq!(
            next_task_history_entry(&history, &mut index, &mut draft).as_deref(),
            Some("draft task")
        );
        assert_eq!(index, None);
    }

    #[test]
    fn worker_prompt_draft_tracks_line_editing_until_enter() {
        let mut draft = String::new();
        let mut cursor = 0;
        let mut is_prompt = false;

        assert_eq!(
            update_worker_prompt_draft_for_key(
                &mut draft,
                &mut cursor,
                &mut is_prompt,
                KeyEvent::new(KeyCode::Char('f'), KeyModifiers::empty()),
                true,
            ),
            None
        );
        update_worker_prompt_draft_for_key(
            &mut draft,
            &mut cursor,
            &mut is_prompt,
            KeyEvent::new(KeyCode::Char('x'), KeyModifiers::empty()),
            true,
        );
        update_worker_prompt_draft_for_key(
            &mut draft,
            &mut cursor,
            &mut is_prompt,
            KeyEvent::new(KeyCode::Backspace, KeyModifiers::empty()),
            true,
        );
        update_worker_prompt_draft_for_key(
            &mut draft,
            &mut cursor,
            &mut is_prompt,
            KeyEvent::new(KeyCode::Char('i'), KeyModifiers::empty()),
            true,
        );
        update_worker_prompt_draft_for_key(
            &mut draft,
            &mut cursor,
            &mut is_prompt,
            KeyEvent::new(KeyCode::Char('x'), KeyModifiers::empty()),
            true,
        );
        update_worker_prompt_draft_for_key(
            &mut draft,
            &mut cursor,
            &mut is_prompt,
            KeyEvent::new(KeyCode::Char(' '), KeyModifiers::empty()),
            true,
        );
        update_worker_prompt_draft_for_key(
            &mut draft,
            &mut cursor,
            &mut is_prompt,
            KeyEvent::new(KeyCode::Char('i'), KeyModifiers::empty()),
            true,
        );
        update_worker_prompt_draft_for_key(
            &mut draft,
            &mut cursor,
            &mut is_prompt,
            KeyEvent::new(KeyCode::Char('t'), KeyModifiers::empty()),
            true,
        );

        assert_eq!(
            update_worker_prompt_draft_for_key(
                &mut draft,
                &mut cursor,
                &mut is_prompt,
                KeyEvent::new(KeyCode::Enter, KeyModifiers::empty()),
                true,
            )
            .as_deref(),
            Some("fix it")
        );
        assert!(draft.is_empty());
        assert_eq!(cursor, 0);
    }

    #[test]
    fn worker_prompt_draft_records_pasted_lines() {
        let mut draft = String::new();
        let mut cursor = 0;
        let mut is_prompt = false;

        let prompts = update_worker_prompt_draft_for_paste(
            &mut draft,
            &mut cursor,
            &mut is_prompt,
            "first follow-up\r\nsecond follow-up",
            true,
        );

        assert_eq!(prompts, vec!["first follow-up".to_string()]);
        assert_eq!(draft, "second follow-up");
        assert_eq!(cursor, "second follow-up".chars().count());
    }

    #[test]
    fn worker_prompt_draft_ignores_non_prompt_input() {
        let mut draft = String::new();
        let mut cursor = 0;
        let mut is_prompt = false;

        update_worker_prompt_draft_for_key(
            &mut draft,
            &mut cursor,
            &mut is_prompt,
            KeyEvent::new(KeyCode::Char('y'), KeyModifiers::empty()),
            false,
        );

        assert_eq!(
            update_worker_prompt_draft_for_key(
                &mut draft,
                &mut cursor,
                &mut is_prompt,
                KeyEvent::new(KeyCode::Enter, KeyModifiers::empty()),
                false,
            ),
            None
        );
        assert!(draft.is_empty());
    }

    #[test]
    fn wraps_task_input_and_tracks_cursor_on_wrapped_lines() {
        let input = "abcdef";

        assert_eq!(wrap_input_text(input, 3), vec!["abc", "def"]);
        assert_eq!(task_cursor_position(input, 6, 3), (2, 0));
        assert_eq!(task_input_lines(input, 6, 3), vec!["abc", "def", ""]);
    }

    #[test]
    fn task_pane_height_grows_for_long_task_input() {
        let mut app = App::new();
        let base_height = task_pane_height(&app, 40);
        app.task_input = "x".repeat(80);
        app.task_cursor = app.task_input.chars().count();

        assert!(task_pane_height(&app, 40) > base_height);
    }

    fn test_agent_run_with_terminal(app: &App, terminal: TerminalPane) -> AgentRun {
        AgentRun {
            id: "run-1".to_string(),
            created_at: "1".to_string(),
            mode: AgentMode::Execute,
            task: "test task".to_string(),
            current_prompt: "test task".to_string(),
            turns: vec![AgentTurn {
                ts: "1".to_string(),
                prompt: "test task".to_string(),
                source: "user".to_string(),
            }],
            last_user_input_at: "1".to_string(),
            backend: Backend::Claude,
            model: "sonnet".to_string(),
            effort: None,
            status: AgentStatus::Running,
            cwd: app.cwd.clone(),
            worktree_branch: None,
            worktree_path: None,
            terminal: Some(terminal),
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
            worker_input_draft: String::new(),
            worker_input_cursor: 0,
            worker_input_is_prompt: false,
        }
    }

    #[test]
    fn delete_agent_requires_second_d() {
        let mut app = App::new();
        app.agents.push(AgentRun {
            id: "run-1".to_string(),
            created_at: "1".to_string(),
            mode: AgentMode::Execute,
            task: "test task".to_string(),
            current_prompt: "test task".to_string(),
            turns: vec![AgentTurn {
                ts: "1".to_string(),
                prompt: "test task".to_string(),
                source: "user".to_string(),
            }],
            last_user_input_at: "1".to_string(),
            backend: Backend::Claude,
            model: "sonnet".to_string(),
            effort: None,
            status: AgentStatus::Done,
            cwd: app.cwd.clone(),
            worktree_branch: None,
            worktree_path: None,
            terminal: None,
            terminal_size: None,
            review_terminal: None,
            review_size: None,
            review_error: None,
            last_output_at: Instant::now(),
            completed_at: Some(Instant::now()),
            autosteered: false,
            needs_permission: false,
            permission_notified: false,
            last_error: None,
            worker_input_draft: String::new(),
            worker_input_cursor: 0,
            worker_input_is_prompt: false,
        });

        app.delete_selected_agent();
        assert_eq!(app.agents.len(), 1);
        assert_eq!(app.delete_pending.as_deref(), Some("run-1"));

        app.delete_selected_agent();
        assert!(app.agents.is_empty());
        assert!(app.delete_pending.is_none());
    }

    #[test]
    fn ctrl_c_exits_from_every_focus_pane() {
        let key = KeyEvent::new(KeyCode::Char('c'), KeyModifiers::CONTROL);
        let mut app = App::new();

        app.focus = FocusPane::Agents;
        assert!(app.handle_key(key));

        app.focus = FocusPane::Worker;
        assert!(app.handle_key(key));

        app.focus = FocusPane::Task;
        assert!(app.handle_key(key));
    }

    #[test]
    fn event_dispatch_handles_paste_and_ctrl_c() {
        let mut app = App::new();
        assert!(!handle_event(&mut app, Event::Paste("hello".to_string())));
        assert_eq!(app.task_input, "hello");
        assert!(handle_event(
            &mut app,
            Event::Key(KeyEvent::new(KeyCode::Char('c'), KeyModifiers::CONTROL))
        ));
    }

    #[test]
    fn v_and_escape_leave_review_view() {
        let mut app = App::new();
        app.worker_view = WorkerView::Diff;
        app.focus = FocusPane::Worker;

        assert!(!app.handle_key(KeyEvent::new(KeyCode::Char('v'), KeyModifiers::empty())));
        assert_eq!(app.worker_view, WorkerView::Terminal);

        app.worker_view = WorkerView::Diff;
        assert!(!app.handle_key(KeyEvent::new(KeyCode::Esc, KeyModifiers::empty())));
        assert_eq!(app.worker_view, WorkerView::Terminal);
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
        EnableBracketedPaste,
        PushKeyboardEnhancementFlags(
            KeyboardEnhancementFlags::DISAMBIGUATE_ESCAPE_CODES
                | KeyboardEnhancementFlags::REPORT_ALTERNATE_KEYS
        )
    )?;
    stdout.flush()?;
    Ok(Terminal::new(CrosstermBackend::new(stdout))?)
}

fn restore_terminal(terminal: &mut Tui) -> Result<()> {
    disable_raw_mode()?;
    execute!(
        terminal.backend_mut(),
        PopKeyboardEnhancementFlags,
        DisableBracketedPaste,
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
            if handle_event(&mut app, event::read()?) {
                app.shutdown();
                break;
            }

            for _ in 1..MAX_EVENTS_PER_FRAME {
                if !event::poll(Duration::ZERO)? {
                    break;
                }
                if handle_event(&mut app, event::read()?) {
                    app.shutdown();
                    return Ok(());
                }
            }
        }
    }

    Ok(())
}

fn handle_event(app: &mut App, event: Event) -> bool {
    match event {
        Event::Key(key) if key.kind == KeyEventKind::Press => app.handle_key(key),
        Event::Key(_) => false,
        Event::Paste(text) => {
            app.handle_paste(text);
            false
        }
        Event::Mouse(mouse) => {
            app.handle_mouse(mouse);
            false
        }
        _ => false,
    }
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
    render_merge_prompt(frame, area, app);
}

#[derive(Clone, Copy)]
enum Gutter {
    Horizontal,
    Vertical,
}

fn render_gutter(frame: &mut Frame<'_>, area: Rect, gutter: Gutter) {
    let style = muted_style(false);
    let line = match gutter {
        Gutter::Horizontal => " ".repeat(area.width as usize),
        Gutter::Vertical => " ".to_string(),
    };

    let lines = vec![Line::from(Span::styled(line, style)); area.height as usize];
    frame.render_widget(Paragraph::new(lines).style(app_style()), area);
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

    for hint in [
        "j/k move",
        "Enter focus",
        "r restart",
        "v review",
        "m merge",
        "dd delete",
    ] {
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
            if agent.mode == AgentMode::Plan {
                Span::styled("plan", accent_style(focused))
            } else {
                Span::styled("run", muted_style(focused))
            },
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
        List::new(lines)
            .style(app_style())
            .block(pane_block("agents", focused, app.nav_mode)),
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
        .style(app_style())
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
    let Some(run) = app.agents.get(app.selected_agent) else {
        return;
    };
    let Some(terminal) = run.terminal.as_ref() else {
        return;
    };
    if terminal.scrollback() > 0 {
        return;
    }
    let cursor = terminal.cursor();
    if cursor.row >= inner.height || cursor.col >= inner.width {
        return;
    }
    if !cursor.visible && run.backend != Backend::Claude {
        return;
    }
    frame.set_cursor_position((inner.x + cursor.col, inner.y + cursor.row));
}

fn set_review_cursor(frame: &mut Frame<'_>, inner: Rect, app: &App) {
    let Some(terminal) = app
        .agents
        .get(app.selected_agent)
        .and_then(|run| run.review_terminal.as_ref())
    else {
        return;
    };
    if terminal.scrollback() > 0 {
        return;
    }
    let cursor = terminal.cursor();
    if cursor.row >= inner.height || cursor.col >= inner.width || !cursor.visible {
        return;
    }
    frame.set_cursor_position((inner.x + cursor.col, inner.y + cursor.row));
}

fn worker_lines(app: &mut App, height: usize) -> Vec<Line<'static>> {
    let Some(run) = app.agents.get_mut(app.selected_agent) else {
        return vec![
            Line::from(""),
            Line::from(Span::styled("No worker is running yet.", muted_style(true))),
            Line::from(""),
            Line::from(Span::styled(
                "Enter a task below to start Claude Code or Codex in this pane.",
                pane_text_style(true),
            )),
        ];
    };

    if let Some(error) = &run.last_error {
        return vec![
            Line::from(vec![
                Span::styled("failed ", error_style()),
                Span::styled(run.cwd.display().to_string(), muted_style(true)),
            ]),
            Line::from(Span::styled(error.clone(), error_style())),
        ];
    }

    let Some(terminal) = run.terminal.as_mut() else {
        return vec![
            Line::from(Span::styled(
                format!("{}  {}", run.status.as_str(), short_task(&run.task)),
                pane_text_style(true),
            )),
            Line::from(""),
            Line::from(Span::styled(
                if run.mode == AgentMode::Plan {
                    "Press r to restart this read-only planner."
                } else {
                    "Press r to restart this agent in its worktree."
                },
                muted_style(true),
            )),
            Line::from(Span::styled(
                run.cwd.display().to_string(),
                muted_style(true),
            )),
        ];
    };

    let selection = app
        .worker_selection
        .map(normalize_selection)
        .filter(|selection| !selection_is_empty(*selection));
    let mut lines = terminal
        .styled_lines()
        .into_iter()
        .enumerate()
        .map(|(row, cells)| styled_terminal_line(cells, selection_for_row(selection, row)))
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
            muted_style(true),
        ))];
    };

    if let Some(error) = &run.review_error {
        return vec![
            Line::from(Span::styled("Hunk review failed", error_style())),
            Line::from(Span::styled(error.clone(), error_style())),
            Line::from(""),
            Line::from(Span::styled(
                "Press Ctrl-G then v to return to the worker.",
                muted_style(true),
            )),
        ];
    }

    let Some(review) = run.review_terminal.as_mut() else {
        return vec![
            Line::from(Span::styled("Opening Hunk review...", muted_style(true))),
            Line::from(""),
            Line::from(Span::styled(
                "If Hunk is unavailable, Rudder falls back to a live git diff.",
                pane_text_style(true),
            )),
        ];
    };

    let mut lines = review
        .styled_lines()
        .into_iter()
        .map(|cells| styled_terminal_line(cells, None))
        .collect::<Vec<_>>();
    if lines.len() > height {
        lines = lines.split_off(lines.len() - height);
    }
    lines
}

fn render_task(frame: &mut Frame<'_>, area: Rect, app: &App) {
    let focused = app.focus == FocusPane::Task;
    let default_hint = if app.plan_mode {
        "Enter plan  Up/Down history  Tab focus  Alt-1/2/3 pane  /plan off  /run"
    } else {
        "Enter start  Up/Down history  Tab focus  Alt-1/2/3 pane  /plan  /model"
    };
    let hint = app.notice.as_deref().unwrap_or(default_hint);
    let inner_width = area.width.saturating_sub(2).max(1);
    let input_lines = task_input_lines(&app.task_input, app.task_cursor, inner_width);
    let (cursor_line, cursor_column) =
        task_cursor_position(&app.task_input, app.task_cursor, inner_width);
    let wrapped_hint = wrap_text(hint, inner_width);
    let hint_line_count = wrapped_hint.len().max(1);
    let available_lines = area.height.saturating_sub(2).max(1) as usize;
    let max_input_lines = available_lines.saturating_sub(hint_line_count).max(1);
    let input_start = if input_lines.len() > max_input_lines {
        cursor_line.saturating_sub(max_input_lines.saturating_sub(1))
    } else {
        0
    };
    let input_start = input_start.min(input_lines.len().saturating_sub(1));
    let task_selection = if app.task_input.is_empty() {
        None
    } else {
        app.task_selection
            .map(normalize_selection)
            .filter(|selection| !selection_is_empty(*selection))
    };
    let mut lines = input_lines
        .iter()
        .skip(input_start)
        .take(max_input_lines)
        .enumerate()
        .map(|(offset, line)| {
            let display = if app.task_input.is_empty() {
                if app.plan_mode {
                    "Type a task to plan or /run"
                } else {
                    "Type a task or /plan"
                }
            } else {
                line.as_str()
            };
            let style = if app.task_input.is_empty() {
                muted_style(focused)
            } else {
                pane_text_style(focused)
            };
            let row = input_start + offset;
            styled_plain_line(
                display,
                style,
                selection_for_row(task_selection, row).filter(|_| !app.task_input.is_empty()),
            )
        })
        .collect::<Vec<_>>();

    if app.notice.is_some() {
        for line in wrapped_hint {
            lines.push(Line::from(Span::styled(line, muted_style(focused))));
        }
    } else {
        let first_hint = wrapped_hint.first().cloned().unwrap_or_default();
        lines.push(Line::from(vec![
            Span::styled(first_hint, muted_style(focused)),
            Span::raw("  "),
            Span::styled(
                if app.plan_mode { "plan" } else { "run" },
                accent_style(focused),
            ),
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

    let paragraph =
        Paragraph::new(lines)
            .style(app_style())
            .block(pane_block("task", focused, app.nav_mode));

    frame.render_widget(paragraph, area);

    if app.focus == FocusPane::Task {
        let visible_cursor_line = cursor_line.saturating_sub(input_start);
        let x = area.x + 1 + cursor_column as u16;
        let y = area.y + 1 + visible_cursor_line as u16;
        if x < area.right().saturating_sub(1) && y < area.bottom().saturating_sub(1) {
            frame.set_cursor_position((x, y));
        }
    }
}

fn task_pane_height(app: &App, width: u16) -> u16 {
    let default_hint = if app.plan_mode {
        "Enter plan  Up/Down history  Tab focus  Alt-1/2/3 pane  /plan off  /run"
    } else {
        "Enter start  Up/Down history  Tab focus  Alt-1/2/3 pane  /plan  /model"
    };
    let hint = app.notice.as_deref().unwrap_or(default_hint);
    let inner_width = width.saturating_sub(2).max(1);
    let input_lines = task_input_lines(&app.task_input, app.task_cursor, inner_width)
        .len()
        .max(1) as u16;
    let hint_lines = wrap_text(hint, inner_width).len().max(1) as u16;
    2_u16
        .saturating_add(input_lines)
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
                accent_style(true)
            } else {
                app_style()
            };
            ListItem::new(Line::from(vec![
                Span::styled(marker, style),
                Span::styled(suggestion.label.clone(), style),
                Span::raw("  "),
                Span::styled(suggestion.detail.clone(), muted_style(true)),
            ]))
        })
        .collect::<Vec<_>>();

    let title = if app.task_input.starts_with("/model") {
        " model "
    } else {
        " commands "
    };
    let list = List::new(items).style(app_style()).block(
        Block::default()
            .title(title)
            .borders(Borders::ALL)
            .border_style(
                Style::default()
                    .fg(FOCUS_COLOR)
                    .add_modifier(Modifier::BOLD),
            )
            .style(app_style()),
    );

    frame.render_widget(Clear, area);
    frame.render_widget(list, area);
}

fn render_merge_prompt(frame: &mut Frame<'_>, area: Rect, app: &App) {
    let (title, body, border_color) = if let Some(confirm) = &app.merge_confirm {
        let summary = match &confirm.intent {
            MergeIntent::Selected { task, .. } => {
                format!("Merge selected worktree: {}", short_task(task))
            }
            MergeIntent::All { ids } => format!(
                "Merge {} completed worktree{}",
                ids.len(),
                if ids.len() == 1 { "" } else { "s" }
            ),
        };
        (
            " confirm merge ",
            vec![
                summary,
                "This will run git merge into the current branch.".to_string(),
                "Press y to merge, n to cancel.".to_string(),
            ],
            RUNNING_COLOR,
        )
    } else if let Some(prompt) = &app.conflict_prompt {
        let files = prompt.conflicted_files.join(", ");
        (
            " merge conflict ",
            vec![
                format!(
                    "Merge stopped with {} conflicted file{}.",
                    prompt.conflicted_files.len(),
                    if prompt.conflicted_files.len() == 1 {
                        ""
                    } else {
                        "s"
                    }
                ),
                if files.is_empty() {
                    "Git did not report conflicted files.".to_string()
                } else {
                    format!("Files: {files}")
                },
                "Press y to start an AI resolver, n to handle manually.".to_string(),
            ],
            FAILED_COLOR,
        )
    } else {
        return;
    };

    let modal = centered_modal(area, 74, (body.len() as u16).saturating_add(2));
    let inner_width = modal.width.saturating_sub(4).max(1);
    let lines = body
        .into_iter()
        .flat_map(|line| wrap_text(&line, inner_width))
        .map(|line| Line::from(Span::styled(line, app_style())))
        .collect::<Vec<_>>();
    let block = Block::default()
        .title(title)
        .borders(Borders::ALL)
        .border_style(
            Style::default()
                .fg(border_color)
                .add_modifier(Modifier::BOLD),
        )
        .style(app_style());
    let paragraph = Paragraph::new(lines)
        .style(app_style())
        .block(block)
        .wrap(Wrap { trim: true });
    frame.render_widget(Clear, modal);
    frame.render_widget(paragraph, modal);
}

fn centered_modal(area: Rect, desired_width: u16, desired_height: u16) -> Rect {
    let width = desired_width.min(area.width.saturating_sub(4)).max(24);
    let height = desired_height.min(area.height.saturating_sub(2)).max(5);
    Rect {
        x: area.x + area.width.saturating_sub(width) / 2,
        y: area.y + area.height.saturating_sub(height) / 2,
        width: width.min(area.width),
        height: height.min(area.height),
    }
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

fn task_input_lines(value: &str, cursor: usize, width: u16) -> Vec<String> {
    let mut lines = wrap_input_text(value, width);
    let (cursor_line, _) = task_cursor_position(value, cursor, width);
    while lines.len() <= cursor_line {
        lines.push(String::new());
    }
    lines
}

fn wrap_input_text(value: &str, width: u16) -> Vec<String> {
    let max_width = usize::from(width.max(1));
    let mut lines = vec![String::new()];

    for ch in value.chars() {
        if ch == '\r' {
            continue;
        }
        if ch == '\n' {
            lines.push(String::new());
            continue;
        }
        if lines
            .last()
            .is_some_and(|line| line.chars().count() == max_width)
        {
            lines.push(String::new());
        }
        if let Some(line) = lines.last_mut() {
            line.push(ch);
        }
    }

    lines
}

fn task_cursor_position(value: &str, cursor: usize, width: u16) -> (usize, usize) {
    let max_width = usize::from(width.max(1));
    let mut line = 0;
    let mut column = 0;

    for ch in value.chars().take(cursor) {
        if ch == '\r' {
            continue;
        }
        if ch == '\n' {
            line += 1;
            column = 0;
            continue;
        }
        column += 1;
        if column == max_width {
            line += 1;
            column = 0;
        }
    }

    (line, column)
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
        Style::default().fg(MODEL_COLOR)
    } else {
        Style::default()
            .fg(INACTIVE_COLOR)
            .add_modifier(Modifier::DIM)
    }
}

fn app_style() -> Style {
    Style::default()
}

fn error_style() -> Style {
    Style::default()
        .fg(FAILED_COLOR)
        .add_modifier(Modifier::BOLD)
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

fn is_scroll_mouse_event(kind: MouseEventKind) -> bool {
    matches!(
        kind,
        MouseEventKind::ScrollUp
            | MouseEventKind::ScrollDown
            | MouseEventKind::ScrollLeft
            | MouseEventKind::ScrollRight
    )
}

fn mouse_scrollback_delta(mouse: MouseEvent, viewport_height: u16) -> isize {
    let rows = wheel_scroll_rows(viewport_height, mouse.modifiers) as isize;
    match mouse.kind {
        MouseEventKind::ScrollUp => rows,
        MouseEventKind::ScrollDown => -rows,
        MouseEventKind::ScrollLeft | MouseEventKind::ScrollRight => 0,
        _ => 0,
    }
}

fn wheel_scroll_rows(viewport_height: u16, modifiers: KeyModifiers) -> u16 {
    let page = viewport_height.saturating_sub(1).max(1);
    if modifiers.intersects(
        KeyModifiers::ALT | KeyModifiers::CONTROL | KeyModifiers::META | KeyModifiers::SUPER,
    ) {
        return page;
    }

    (viewport_height / 3)
        .max(MIN_WHEEL_SCROLL_ROWS)
        .min(MAX_WHEEL_SCROLL_ROWS)
        .min(page)
        .max(1)
}

fn page_scroll_rows(area: Option<Rect>) -> isize {
    let height = area.map(block_inner).map(|inner| inner.height).unwrap_or(1);
    height.saturating_sub(1).max(1) as isize
}

fn status_style(status: AgentStatus) -> Style {
    Style::default().fg(status_color(status))
}

fn agent_status_label(agent: &AgentRun) -> &'static str {
    if agent.needs_permission {
        "needs permission"
    } else if agent.mode == AgentMode::Plan && agent.status == AgentStatus::Running {
        "planning"
    } else {
        agent.status.as_str()
    }
}

fn agent_status_style(agent: &AgentRun) -> Style {
    if agent.needs_permission {
        Style::default()
            .fg(RUNNING_COLOR)
            .add_modifier(Modifier::BOLD)
    } else {
        status_style(agent.status)
    }
}

fn status_color(status: AgentStatus) -> Color {
    match status {
        AgentStatus::Running => RUNNING_COLOR,
        AgentStatus::Done => DONE_COLOR,
        AgentStatus::Failed => FAILED_COLOR,
        AgentStatus::Stopped => INACTIVE_COLOR,
    }
}

fn selection_point_from_mouse(mouse: MouseEvent, area: Rect) -> SelectionPoint {
    SelectionPoint {
        row: mouse
            .row
            .saturating_sub(area.y)
            .min(area.height.saturating_sub(1)) as usize,
        col: mouse
            .column
            .saturating_sub(area.x)
            .min(area.width.saturating_sub(1)) as usize,
    }
}

fn task_selection_point_from_mouse(
    app: &App,
    mouse: MouseEvent,
    area: Rect,
) -> Option<SelectionPoint> {
    if !rect_contains(area, mouse.column, mouse.row) {
        return None;
    }
    let width = task_inner_width(area);
    let input_lines = task_input_lines(&app.task_input, app.task_cursor, width);
    let input_start = task_visible_input_start(app, area, &input_lines);
    let visible_count = task_visible_input_count(app, area, input_lines.len());
    let rel_row = mouse.row.saturating_sub(area.y) as usize;
    if rel_row >= visible_count {
        return None;
    }
    let row = input_start.saturating_add(rel_row);
    if row >= input_lines.len() {
        return None;
    }
    Some(SelectionPoint {
        row,
        col: mouse
            .column
            .saturating_sub(area.x)
            .min(width.saturating_sub(1)) as usize,
    })
}

fn task_visible_input_start(app: &App, area: Rect, input_lines: &[String]) -> usize {
    let width = task_inner_width(area);
    let (cursor_line, _) = task_cursor_position(&app.task_input, app.task_cursor, width);
    let max_input_lines = task_visible_input_count(app, area, input_lines.len());
    let input_start = if input_lines.len() > max_input_lines {
        cursor_line.saturating_sub(max_input_lines.saturating_sub(1))
    } else {
        0
    };
    input_start.min(input_lines.len().saturating_sub(1))
}

fn task_visible_input_count(app: &App, area: Rect, input_line_count: usize) -> usize {
    let default_hint = if app.plan_mode {
        "Enter plan  Up/Down history  Tab focus  Alt-1/2/3 pane  /plan off  /run"
    } else {
        "Enter start  Up/Down history  Tab focus  Alt-1/2/3 pane  /plan  /model"
    };
    let hint = app.notice.as_deref().unwrap_or(default_hint);
    let hint_line_count = wrap_text(hint, task_inner_width(area)).len().max(1);
    (area.height.max(1) as usize)
        .saturating_sub(hint_line_count)
        .max(1)
        .min(input_line_count.max(1))
}

fn task_inner_width(area: Rect) -> u16 {
    area.width.max(1)
}

fn task_cursor_from_selection_point(value: &str, point: SelectionPoint, width: u16) -> usize {
    let lines = wrap_input_text(value, width);
    let mut cursor = 0;
    for (row, line) in lines.iter().enumerate() {
        let line_len = line.chars().count();
        if row == point.row {
            return cursor + point.col.min(line_len);
        }
        cursor += line_len;
    }
    value.chars().count()
}

fn normalize_selection(selection: WorkerSelection) -> NormalizedSelection {
    let (start, end) =
        if (selection.start.row, selection.start.col) <= (selection.end.row, selection.end.col) {
            (selection.start, selection.end)
        } else {
            (selection.end, selection.start)
        };
    NormalizedSelection { start, end }
}

fn selection_is_empty(selection: NormalizedSelection) -> bool {
    selection.start == selection.end
}

fn selection_for_row(selection: Option<NormalizedSelection>, row: usize) -> Option<(usize, usize)> {
    let selection = selection?;
    if row < selection.start.row || row > selection.end.row {
        return None;
    }
    let start_col = if row == selection.start.row {
        selection.start.col
    } else {
        0
    };
    let end_col = if row == selection.end.row {
        selection.end.col
    } else {
        usize::MAX
    };
    Some((start_col, end_col))
}

fn selected_text_from_lines(lines: &[String], selection: WorkerSelection) -> String {
    let selection = normalize_selection(selection);
    let mut selected = Vec::new();
    for row in selection.start.row..=selection.end.row {
        let Some(line) = lines.get(row) else {
            continue;
        };
        let char_len = line.chars().count();
        let start = if row == selection.start.row {
            selection.start.col.min(char_len)
        } else {
            0
        };
        let end = if row == selection.end.row {
            selection.end.col.saturating_add(1).min(char_len)
        } else {
            char_len
        };
        selected.push(slice_chars(line, start, end));
    }
    selected.join("\n")
}

fn slice_chars(value: &str, start: usize, end: usize) -> String {
    value
        .chars()
        .skip(start)
        .take(end.saturating_sub(start))
        .collect()
}

fn copy_text_to_clipboard(text: &str) -> Result<()> {
    if text.is_empty() {
        return Ok(());
    }

    #[cfg(target_os = "macos")]
    {
        return run_clipboard_command("pbcopy", &[], text);
    }

    #[cfg(target_os = "windows")]
    {
        return run_clipboard_command("clip", &[], text);
    }

    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    {
        let commands: &[(&str, &[&str])] = &[
            ("wl-copy", &[]),
            ("xclip", &["-selection", "clipboard"]),
            ("xsel", &["--clipboard", "--input"]),
        ];
        for (command, args) in commands {
            if run_clipboard_command(command, args, text).is_ok() {
                return Ok(());
            }
        }
        bail!("no clipboard command found");
    }
}

fn run_clipboard_command(command: &str, args: &[&str], text: &str) -> Result<()> {
    let mut child = Command::new(command)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .with_context(|| format!("failed to start {command}"))?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(text.as_bytes())
            .with_context(|| format!("failed to write to {command}"))?;
    }
    let status = child
        .wait()
        .with_context(|| format!("failed to wait for {command}"))?;
    if !status.success() {
        bail!("{command} exited with {status}");
    }
    Ok(())
}

fn styled_terminal_line(
    cells: Vec<StyledTerminalCell>,
    selection: Option<(usize, usize)>,
) -> Line<'static> {
    let spans = cells
        .into_iter()
        .enumerate()
        .map(|cell| {
            let (col, cell) = cell;
            let mut style = terminal_cell_style(&cell);
            if selection.is_some_and(|(start, end)| col >= start && col <= end) {
                style = style.fg(Color::Black).bg(FOCUS_COLOR);
            }
            Span::styled(cell.contents, style)
        })
        .collect::<Vec<_>>();
    Line::from(spans)
}

fn styled_plain_line(text: &str, style: Style, selection: Option<(usize, usize)>) -> Line<'static> {
    let Some((start, end)) = selection else {
        return Line::from(Span::styled(text.to_string(), style));
    };
    let mut spans = Vec::new();
    let chars = text.chars().collect::<Vec<_>>();
    let clamped_start = start.min(chars.len());
    let clamped_end = end.saturating_add(1).min(chars.len());
    if clamped_start > 0 {
        spans.push(Span::styled(
            chars[..clamped_start].iter().collect::<String>(),
            style,
        ));
    }
    if clamped_end > clamped_start {
        spans.push(Span::styled(
            chars[clamped_start..clamped_end].iter().collect::<String>(),
            style.fg(Color::Black).bg(FOCUS_COLOR),
        ));
    }
    if clamped_end < chars.len() {
        spans.push(Span::styled(
            chars[clamped_end..].iter().collect::<String>(),
            style,
        ));
    }
    if spans.is_empty() {
        spans.push(Span::styled(text.to_string(), style));
    }
    Line::from(spans)
}

fn terminal_cell_style(cell: &StyledTerminalCell) -> Style {
    let (fg, bg) = if cell.inverse {
        (cell.bg, cell.fg)
    } else {
        (cell.fg, cell.bg)
    };
    let mut style = app_style();
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

fn initial_selection() -> InitialSelection {
    let cli = cli_selection();
    let config = load_rudder_config();
    let backend = cli
        .backend
        .or_else(|| config.as_ref().and_then(config_backend))
        .unwrap_or(Backend::Claude);
    let cli_model = cli.model.filter(|model| !model.trim().is_empty());
    let should_remember = cli.backend.is_some() || cli_model.is_some();
    let model = cli_model
        .clone()
        .or_else(|| {
            config
                .as_ref()
                .and_then(|config| config_model(config, backend))
        })
        .unwrap_or_else(|| default_model_for(backend).to_string());
    let effort = if cli_model.is_some() {
        default_effort_for(backend, &model)
    } else {
        config
            .as_ref()
            .and_then(|config| config_effort(config, backend))
            .or_else(|| default_effort_for(backend, &model))
    };

    if should_remember {
        let _ = save_model_defaults(backend, &model, effort);
    }

    InitialSelection {
        backend,
        model,
        effort,
    }
}

fn cli_selection() -> CliSelection {
    let mut selection = CliSelection::default();
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--" => break,
            "--backend" | "-b" => {
                if let Some(value) = args.next() {
                    selection.backend = provider_backend(&value);
                }
            }
            "--model" | "-m" => {
                selection.model = args.next();
            }
            _ if arg.starts_with("--backend=") => {
                selection.backend = provider_backend(&arg["--backend=".len()..]);
            }
            _ if arg.starts_with("--model=") => {
                selection.model = Some(arg["--model=".len()..].to_string());
            }
            _ => {}
        }
    }
    selection
}

fn load_rudder_config() -> Option<serde_json::Value> {
    let path = rudder_config_path()?;
    let raw = fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

fn config_backend(config: &serde_json::Value) -> Option<Backend> {
    config
        .get("lastUsedBackend")
        .and_then(serde_json::Value::as_str)
        .and_then(provider_backend)
        .or_else(|| {
            config
                .get("defaultBackend")
                .and_then(serde_json::Value::as_str)
                .and_then(provider_backend)
        })
}

fn config_model(config: &serde_json::Value, backend: Backend) -> Option<String> {
    config
        .get("backends")?
        .get(backend.as_str())?
        .get("model")?
        .as_str()
        .filter(|model| !model.trim().is_empty())
        .map(ToString::to_string)
}

fn config_effort(config: &serde_json::Value, backend: Backend) -> Option<EffortLevel> {
    let backend_config = config.get("backends")?.get(backend.as_str())?;
    let keys: &[&str] = match backend {
        Backend::Claude => &["effort", "reasoningEffort"],
        Backend::Codex => &["reasoningEffort", "effort"],
    };
    keys.iter().find_map(|key| {
        backend_config
            .get(*key)
            .and_then(serde_json::Value::as_str)
            .and_then(EffortLevel::parse)
    })
}

fn save_model_defaults(backend: Backend, model: &str, effort: Option<EffortLevel>) -> Result<()> {
    let path = rudder_config_path().context("could not determine Rudder config path")?;
    let mut config = load_rudder_config().unwrap_or_else(default_config_value);
    if !config.is_object() {
        config = default_config_value();
    }
    ensure_config_defaults(&mut config);

    let root = config
        .as_object_mut()
        .context("Rudder config root is not an object")?;
    root.insert(
        "lastUsedBackend".to_string(),
        serde_json::Value::String(backend.as_str().to_string()),
    );
    let backends = root
        .entry("backends".to_string())
        .or_insert_with(|| serde_json::json!({}));
    if !backends.is_object() {
        *backends = serde_json::json!({});
    }
    let backends = backends
        .as_object_mut()
        .context("Rudder backends config is not an object")?;
    let backend_config = backends
        .entry(backend.as_str().to_string())
        .or_insert_with(|| serde_json::json!({}));
    if !backend_config.is_object() {
        *backend_config = serde_json::json!({});
    }
    let backend_config = backend_config
        .as_object_mut()
        .context("Rudder backend config is not an object")?;
    if model.trim().is_empty() {
        backend_config.remove("model");
    } else {
        backend_config.insert(
            "model".to_string(),
            serde_json::Value::String(model.to_string()),
        );
    }
    match backend {
        Backend::Claude => {
            if let Some(effort) = effort {
                backend_config.insert(
                    "effort".to_string(),
                    serde_json::Value::String(effort.as_str().to_string()),
                );
            } else {
                backend_config.remove("effort");
            }
        }
        Backend::Codex => {
            if let Some(effort) = effort {
                backend_config.insert(
                    "reasoningEffort".to_string(),
                    serde_json::Value::String(effort.as_str().to_string()),
                );
            } else {
                backend_config.remove("reasoningEffort");
            }
        }
    }

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let temp = path.with_extension(format!(
        "json.{}.{}.tmp",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
    ));
    fs::write(
        &temp,
        format!("{}\n", serde_json::to_string_pretty(&config)?),
    )?;
    fs::rename(&temp, &path)?;
    set_private_file_mode(&path);
    Ok(())
}

fn ensure_config_defaults(config: &mut serde_json::Value) {
    let Some(root) = config.as_object_mut() else {
        return;
    };
    root.entry("version".to_string())
        .or_insert(serde_json::json!(1));
    root.entry("defaultBackend".to_string())
        .or_insert(serde_json::json!("claude"));
    root.entry("runPolicy".to_string()).or_insert_with(|| {
        serde_json::json!({
            "sameCheckout": "single-active",
            "concurrentPromptMode": "worktree",
            "mergeMode": "manual-on-conflict"
        })
    });
    root.entry("acpx".to_string())
        .or_insert_with(|| serde_json::json!({ "install": "latest" }));
    root.entry("backends".to_string())
        .or_insert_with(|| serde_json::json!({}));
}

fn default_config_value() -> serde_json::Value {
    serde_json::json!({
        "version": 1,
        "defaultBackend": "claude",
        "runPolicy": {
            "sameCheckout": "single-active",
            "concurrentPromptMode": "worktree",
            "mergeMode": "manual-on-conflict"
        },
        "acpx": { "install": "latest" },
        "backends": {
            "claude": {
                "profileId": "anthropic:claude-code",
                "model": "sonnet"
            },
            "codex": {
                "profileId": "openai-codex:default",
                "model": "gpt-5.5"
            },
            "acpx": {
                "model": "gpt-5.5"
            }
        }
    })
}

fn rudder_config_path() -> Option<PathBuf> {
    let home = if let Some(value) = std::env::var_os("RUDDER_HOME") {
        let value = PathBuf::from(value);
        if !value.as_os_str().is_empty() {
            value
        } else {
            user_home_dir()?.join(".rudder")
        }
    } else {
        user_home_dir()?.join(".rudder")
    };
    Some(home.join("config.json"))
}

fn user_home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("USERPROFILE").map(PathBuf::from))
}

#[cfg(unix)]
fn set_private_file_mode(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    if let Ok(metadata) = fs::metadata(path) {
        let mut permissions = metadata.permissions();
        permissions.set_mode(0o600);
        let _ = fs::set_permissions(path, permissions);
    }
}

#[cfg(not(unix))]
fn set_private_file_mode(_path: &Path) {}

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
            label: "/plan".to_string(),
            detail: "toggle Rudder read-only planning".to_string(),
            action: SuggestionAction::Insert("/plan".to_string()),
        },
        Suggestion {
            label: "/plan <task>".to_string(),
            detail: "plan one task without toggling".to_string(),
            action: SuggestionAction::Insert("/plan ".to_string()),
        },
        Suggestion {
            label: "/run <task>".to_string(),
            detail: "start implementation even when plan mode is on".to_string(),
            action: SuggestionAction::Insert("/run ".to_string()),
        },
        Suggestion {
            label: "/model".to_string(),
            detail: "pick Claude or Codex model".to_string(),
            action: SuggestionAction::Insert("/model ".to_string()),
        },
        Suggestion {
            label: "/login".to_string(),
            detail: "authenticate Rudder Cloud in the browser".to_string(),
            action: SuggestionAction::Insert("/login".to_string()),
        },
        Suggestion {
            label: "/cloud".to_string(),
            detail: "list, start, pause, resume, or onload cloud workers".to_string(),
            action: SuggestionAction::Insert("/cloud ".to_string()),
        },
        Suggestion {
            label: "/sail".to_string(),
            detail: "short alias for starting a cloud worker".to_string(),
            action: SuggestionAction::Insert("/sail ".to_string()),
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
    mode: AgentMode,
) -> TerminalCommand {
    let prompt = match mode {
        AgentMode::Execute => execution_prompt(task),
        AgentMode::Plan => plan_prompt(task),
    };
    match backend {
        Backend::Claude => {
            let mut args = match mode {
                AgentMode::Execute => vec![
                    "--permission-mode".to_string(),
                    "bypassPermissions".to_string(),
                ],
                AgentMode::Plan => vec![
                    "--permission-mode".to_string(),
                    "default".to_string(),
                    "--tools".to_string(),
                    claude_plan_tools().join(","),
                    "--allowedTools".to_string(),
                    claude_plan_tools().join(","),
                    "--disallowedTools".to_string(),
                    claude_plan_disallowed_tools().join(","),
                    "--append-system-prompt".to_string(),
                    plan_mode_contract(),
                    "--name".to_string(),
                    format!("plan:{}", short_task(task)),
                ],
            };
            if !model.trim().is_empty() {
                args.push("--model".to_string());
                args.push(model.to_string());
            }
            if let Some(effort) = effort {
                args.push("--effort".to_string());
                args.push(effort.as_str().to_string());
            }
            args.push(prompt);
            TerminalCommand::with_args("claude", args).with_env("CLAUDE_CODE_NO_FLICKER", "0")
        }
        Backend::Codex => {
            let mut args = vec![
                "--no-alt-screen".to_string(),
                "--ask-for-approval".to_string(),
                "never".to_string(),
            ];
            match mode {
                AgentMode::Execute => {
                    args.push("--sandbox".to_string());
                    args.push("danger-full-access".to_string());
                    args.push("--dangerously-bypass-approvals-and-sandbox".to_string());
                }
                AgentMode::Plan => {
                    args.push("--sandbox".to_string());
                    args.push("read-only".to_string());
                    args.push("--search".to_string());
                }
            }
            args.push("-c".to_string());
            args.push("model_reasoning_summary=\"detailed\"".to_string());
            args.push("-c".to_string());
            args.push("model_supports_reasoning_summaries=true".to_string());
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

fn execution_prompt(task: &str) -> String {
    format!(
        "[RUDDER PROMPT INJECTION]\nRead RUDDER.md first if it exists. Rudder generated that file to show active Rudder agents and worktrees in this repo. If a Hunk review is open for this worktree, run `hunk skill path`, load that skill, and use `hunk session review --repo . --json` plus `hunk session comment ...` commands to inspect and annotate the live review.\n[END RUDDER PROMPT INJECTION]\n\nUSER TASK:\n{task}"
    )
}

fn plan_prompt(task: &str) -> String {
    format!(
        "{}\n\nUSER TASK:\nPlan this task before implementation:\n{}\n\nFirst inspect the repository and relevant external/read-only context. Ask follow-up questions if the plan cannot be made decision-complete from inspection alone.",
        plan_mode_contract(),
        task
    )
}

fn plan_mode_contract() -> String {
    [
        "[RUDDER PLAN MODE]",
        "You are running inside Rudder's own plan mode, not the backend's native implementation mode.",
        "Your job is to investigate and produce a decision-complete implementation plan.",
        "",
        "Rules:",
        "- Do not write, edit, create, delete, move, rename, install, commit, merge, deploy, migrate, or otherwise mutate local or remote state.",
        "- Use only read-only inspection. It is OK to read files, search the repo, inspect git state or read-only CLI state when the active tool profile permits it, and use web search/fetch when it improves the plan.",
        "- If secrets or environment state matter, inspect only what is needed and do not print secret values. Mention presence, absence, names, or configuration shape instead.",
        "- Ask concise follow-up questions when important product or implementation choices cannot be discovered from the environment.",
        "- When the plan is ready, put the final answer in a single <proposed_plan>...</proposed_plan> block.",
        "[END RUDDER PLAN MODE]",
    ]
    .join("\n")
}

fn claude_plan_tools() -> Vec<&'static str> {
    vec!["Read", "Grep", "Glob", "LS", "WebSearch", "WebFetch"]
}

fn claude_plan_disallowed_tools() -> Vec<&'static str> {
    vec![
        "Edit",
        "Write",
        "MultiEdit",
        "NotebookEdit",
        "Bash",
        "Bash(rm *)",
        "Bash(mv *)",
        "Bash(cp *)",
        "Bash(mkdir *)",
        "Bash(touch *)",
        "Bash(chmod *)",
        "Bash(chown *)",
        "Bash(git add*)",
        "Bash(git commit*)",
        "Bash(git checkout*)",
        "Bash(git switch*)",
        "Bash(git reset*)",
        "Bash(git clean*)",
        "Bash(git merge*)",
        "Bash(git rebase*)",
        "Bash(git push*)",
        "Bash(fly deploy*)",
        "Bash(fly secrets set*)",
        "Bash(fly secrets unset*)",
        "Bash(fly scale*)",
        "Bash(fly apps destroy*)",
    ]
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

fn preview_text(value: &str, max_chars: usize) -> String {
    let normalized = value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .replace('"', "\\\"");
    let mut chars = normalized.chars();
    let preview = chars.by_ref().take(max_chars).collect::<String>();
    if chars.next().is_some() {
        format!("{preview}...")
    } else {
        preview
    }
}

fn record_agent_prompt(run: &mut AgentRun, prompt: String, source: &str) {
    let ts = now_stamp();
    if source == "user" {
        run.last_user_input_at = ts.clone();
    }
    run.current_prompt = prompt.clone();
    run.turns.push(AgentTurn {
        ts,
        prompt,
        source: source.to_string(),
    });
}

fn update_worker_prompt_draft_for_key(
    draft: &mut String,
    cursor: &mut usize,
    is_prompt: &mut bool,
    key: KeyEvent,
    capture_as_prompt: bool,
) -> Option<String> {
    match key.code {
        KeyCode::Enter if !key.modifiers.contains(KeyModifiers::SHIFT) => {
            return finish_worker_prompt_draft(draft, cursor, is_prompt);
        }
        KeyCode::Char('u') | KeyCode::Char('U')
            if key.modifiers.contains(KeyModifiers::CONTROL) =>
        {
            draft.clear();
            *cursor = 0;
            *is_prompt = false;
            return None;
        }
        KeyCode::Char('w') | KeyCode::Char('W')
            if key.modifiers.contains(KeyModifiers::CONTROL) =>
        {
            delete_previous_word_at(draft, cursor);
            return None;
        }
        KeyCode::Backspace => {
            if key
                .modifiers
                .intersects(KeyModifiers::SUPER | KeyModifiers::META)
            {
                draft.clear();
                *cursor = 0;
                *is_prompt = false;
            } else if key
                .modifiers
                .intersects(KeyModifiers::ALT | KeyModifiers::CONTROL)
            {
                delete_previous_word_at(draft, cursor);
            } else {
                delete_char_before_cursor(draft, cursor);
            }
        }
        KeyCode::Delete => delete_char_at_cursor(draft, *cursor),
        KeyCode::Left => {
            if key
                .modifiers
                .intersects(KeyModifiers::ALT | KeyModifiers::META)
            {
                *cursor = previous_word_position(draft, *cursor);
            } else {
                *cursor = (*cursor).saturating_sub(1);
            }
        }
        KeyCode::Right => {
            let len = draft.chars().count();
            if key
                .modifiers
                .intersects(KeyModifiers::ALT | KeyModifiers::META)
            {
                *cursor = next_word_position(draft, *cursor);
            } else {
                *cursor = (*cursor + 1).min(len);
            }
        }
        KeyCode::Home => *cursor = 0,
        KeyCode::End => *cursor = draft.chars().count(),
        KeyCode::Char(ch)
            if !key.modifiers.intersects(
                KeyModifiers::ALT
                    | KeyModifiers::CONTROL
                    | KeyModifiers::SUPER
                    | KeyModifiers::META,
            ) =>
        {
            if draft.is_empty() {
                *is_prompt = capture_as_prompt;
            }
            insert_char_at_cursor(draft, cursor, ch);
        }
        _ => {}
    }

    None
}

fn update_worker_prompt_draft_for_paste(
    draft: &mut String,
    cursor: &mut usize,
    is_prompt: &mut bool,
    text: &str,
    capture_as_prompt: bool,
) -> Vec<String> {
    let mut prompts = Vec::new();
    let mut previous_was_carriage_return = false;

    for ch in text.chars() {
        match ch {
            '\r' => {
                if let Some(prompt) = finish_worker_prompt_draft(draft, cursor, is_prompt) {
                    prompts.push(prompt);
                }
                previous_was_carriage_return = true;
            }
            '\n' if previous_was_carriage_return => {
                previous_was_carriage_return = false;
            }
            '\n' => {
                if let Some(prompt) = finish_worker_prompt_draft(draft, cursor, is_prompt) {
                    prompts.push(prompt);
                }
                previous_was_carriage_return = false;
            }
            '\u{7f}' | '\u{8}' => {
                delete_char_before_cursor(draft, cursor);
                previous_was_carriage_return = false;
            }
            _ if ch.is_control() => {
                previous_was_carriage_return = false;
            }
            _ => {
                if draft.is_empty() {
                    *is_prompt = capture_as_prompt;
                }
                insert_char_at_cursor(draft, cursor, ch);
                previous_was_carriage_return = false;
            }
        }
    }

    prompts
}

fn finish_worker_prompt_draft(
    draft: &mut String,
    cursor: &mut usize,
    is_prompt: &mut bool,
) -> Option<String> {
    let prompt = draft.trim().to_string();
    let should_record = *is_prompt;
    draft.clear();
    *cursor = 0;
    *is_prompt = false;
    if prompt.is_empty() || !should_record {
        None
    } else {
        Some(prompt)
    }
}

fn previous_task_history_entry(
    history: &[String],
    index: &mut Option<usize>,
    draft: &mut String,
    current_input: &str,
) -> Option<String> {
    if history.is_empty() {
        return None;
    }

    let next_index = match *index {
        Some(current) => current
            .min(history.len().saturating_sub(1))
            .saturating_sub(1),
        None => {
            *draft = current_input.to_string();
            history.len().saturating_sub(1)
        }
    };
    *index = Some(next_index);
    history.get(next_index).cloned()
}

fn next_task_history_entry(
    history: &[String],
    index: &mut Option<usize>,
    draft: &mut String,
) -> Option<String> {
    let current = (*index)?.min(history.len().saturating_sub(1));
    if current + 1 < history.len() {
        let next_index = current + 1;
        *index = Some(next_index);
        return history.get(next_index).cloned();
    }

    *index = None;
    Some(std::mem::take(draft))
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

fn is_copy_key(key: KeyEvent) -> bool {
    matches!(key.code, KeyCode::Char('c') | KeyCode::Char('C'))
        && key
            .modifiers
            .intersects(KeyModifiers::SUPER | KeyModifiers::META)
        && !key.modifiers.contains(KeyModifiers::CONTROL)
}

fn terminal_bytes_for_key(key: KeyEvent) -> Option<Vec<u8>> {
    if is_copy_key(key) {
        return None;
    }

    let bytes = match key.code {
        KeyCode::Char(ch) => {
            if key.modifiers.contains(KeyModifiers::CONTROL) {
                control_char_bytes(ch)?
            } else if key.modifiers.contains(KeyModifiers::SUPER) {
                return None;
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
        KeyCode::Enter if key.modifiers.contains(KeyModifiers::SHIFT) => b"\x1b[13;2u".to_vec(),
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
        KeyCode::PageUp => b"\x1b[5~".to_vec(),
        KeyCode::PageDown => b"\x1b[6~".to_vec(),
        KeyCode::Delete => b"\x1b[3~".to_vec(),
        _ => return None,
    };
    Some(bytes)
}

fn bracketed_paste_bytes(text: &str) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(text.len() + "\x1b[200~\x1b[201~".len());
    bytes.extend_from_slice(b"\x1b[200~");
    bytes.extend_from_slice(text.as_bytes());
    bytes.extend_from_slice(b"\x1b[201~");
    bytes
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
    let button = button + mouse_modifier_code(mouse.modifiers);

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

fn mouse_modifier_code(modifiers: KeyModifiers) -> u16 {
    let mut code = 0;
    if modifiers.contains(KeyModifiers::SHIFT) {
        code += 4;
    }
    if modifiers.intersects(KeyModifiers::ALT | KeyModifiers::META) {
        code += 8;
    }
    if modifiers.contains(KeyModifiers::CONTROL) {
        code += 16;
    }
    code
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

fn native_runs_dir(repo_root: &Path) -> PathBuf {
    repo_root.join(".rudder").join("runs")
}

fn native_run_dir(repo_root: &Path, run_id: &str) -> PathBuf {
    native_runs_dir(repo_root).join(run_id)
}

fn load_persisted_agents(repo_root: &Path) -> Vec<AgentRun> {
    let Ok(entries) = fs::read_dir(native_runs_dir(repo_root)) else {
        return Vec::new();
    };
    let mut agents = entries
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
        .filter_map(|entry| fs::read_to_string(entry.path().join("run.json")).ok())
        .filter_map(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .filter_map(|record| agent_from_run_record(repo_root, record))
        .collect::<Vec<_>>();
    agents.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    agents
}

fn agent_from_run_record(repo_root: &Path, record: serde_json::Value) -> Option<AgentRun> {
    let id = record.get("id")?.as_str()?.to_string();
    let task = record.get("task")?.as_str()?.to_string();
    let backend = record
        .get("backend")
        .and_then(|value| value.as_str())
        .and_then(Backend::parse)
        .unwrap_or(Backend::Claude);
    let model = record
        .get("model")
        .and_then(|value| value.as_str())
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| default_model_for(backend).to_string());
    let effort = record
        .get("effort")
        .and_then(|value| value.as_str())
        .and_then(EffortLevel::parse);
    let status = agent_status_from_record(record.get("status").and_then(|value| value.as_str()));
    let created_at = record
        .get("createdAt")
        .and_then(|value| value.as_str())
        .map(ToOwned::to_owned)
        .unwrap_or_else(now_stamp);
    let turns = turns_from_run_record(&record, &created_at, &task);
    let current_prompt = record
        .get("currentPrompt")
        .and_then(|value| value.as_str())
        .map(ToOwned::to_owned)
        .or_else(|| turns.last().map(|turn| turn.prompt.clone()))
        .unwrap_or_else(|| task.clone());
    let last_user_input_at = record
        .get("lastUserInputAt")
        .and_then(|value| value.as_str())
        .map(ToOwned::to_owned)
        .or_else(|| {
            turns
                .iter()
                .rev()
                .find(|turn| turn.source == "user")
                .map(|turn| turn.ts.clone())
        })
        .unwrap_or_else(|| created_at.clone());
    let mode = record
        .get("mode")
        .and_then(|value| value.as_str())
        .and_then(AgentMode::parse)
        .unwrap_or(AgentMode::Execute);
    let worktree = record.get("worktree");
    let worktree_enabled = worktree
        .and_then(|value| value.get("enabled"))
        .and_then(|value| value.as_bool())
        .unwrap_or(false);
    let cwd = worktree
        .and_then(|value| value.get("path"))
        .and_then(|value| value.as_str())
        .map(PathBuf::from)
        .unwrap_or_else(|| repo_root.to_path_buf());
    let worktree_branch = worktree
        .and_then(|value| value.get("branch"))
        .and_then(|value| value.as_str())
        .map(ToOwned::to_owned);
    let worktree_path = worktree_enabled.then_some(cwd.clone());

    Some(AgentRun {
        id,
        created_at,
        mode,
        task,
        current_prompt,
        turns,
        last_user_input_at,
        backend,
        model,
        effort,
        status,
        cwd,
        worktree_branch,
        worktree_path,
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
        worker_input_draft: String::new(),
        worker_input_cursor: 0,
        worker_input_is_prompt: false,
    })
}

fn turns_from_run_record(
    record: &serde_json::Value,
    created_at: &str,
    task: &str,
) -> Vec<AgentTurn> {
    let mut turns = record
        .get("turns")
        .and_then(|value| value.as_array())
        .map(|values| {
            values
                .iter()
                .filter_map(turn_from_json)
                .collect::<Vec<AgentTurn>>()
        })
        .unwrap_or_default();

    if turns.is_empty() {
        turns.push(AgentTurn {
            ts: created_at.to_string(),
            prompt: task.to_string(),
            source: "user".to_string(),
        });
    }

    turns
}

fn turn_from_json(value: &serde_json::Value) -> Option<AgentTurn> {
    let prompt = value.get("prompt")?.as_str()?.to_string();
    let ts = value
        .get("ts")
        .and_then(|value| value.as_str())
        .map(ToOwned::to_owned)
        .unwrap_or_else(now_stamp);
    let source = value
        .get("source")
        .and_then(|value| value.as_str())
        .unwrap_or("user")
        .to_string();

    Some(AgentTurn { ts, prompt, source })
}

fn agent_status_from_record(status: Option<&str>) -> AgentStatus {
    match status {
        Some("completed") | Some("merged") => AgentStatus::Done,
        Some("failed") => AgentStatus::Failed,
        Some("running") | Some("steering") | Some("verifying") | Some("created") => {
            AgentStatus::Stopped
        }
        Some("cancelled") | Some("merge-conflict") => AgentStatus::Stopped,
        _ => AgentStatus::Stopped,
    }
}

fn run_record_status(status: AgentStatus) -> &'static str {
    match status {
        AgentStatus::Running => "running",
        AgentStatus::Done => "completed",
        AgentStatus::Failed => "failed",
        AgentStatus::Stopped => "cancelled",
    }
}

fn save_native_run_record(repo_root: &Path, run: &AgentRun) -> Result<()> {
    let run_dir = native_run_dir(repo_root, &run.id);
    fs::create_dir_all(&run_dir)?;
    let record_path = run_dir.join("run.json");
    let target_branch = current_branch().unwrap_or_else(|| "HEAD".to_string());
    let base_commit = git_output(repo_root, ["rev-parse", "HEAD"])
        .map(|value| value.trim().to_string())
        .unwrap_or_default();
    let now = now_stamp();
    let turns = run
        .turns
        .iter()
        .map(|turn| {
            serde_json::json!({
                "ts": turn.ts,
                "prompt": turn.prompt,
                "source": turn.source,
            })
        })
        .collect::<Vec<_>>();
    let record = serde_json::json!({
        "id": run.id,
        "status": run_record_status(run.status),
        "mode": run.mode.as_str(),
        "task": run.task,
        "backend": run.backend.as_str(),
        "model": run.model,
        "effort": run.effort.map(|effort| effort.as_str()),
        "createdAt": run.created_at,
        "updatedAt": now,
        "repoRoot": repo_root,
        "targetBranch": target_branch,
        "baseCommit": base_commit,
        "worktree": {
            "enabled": run.worktree_path.is_some(),
            "path": run.cwd,
            "branch": run.worktree_branch,
        },
        "currentPrompt": run.current_prompt,
        "turns": turns,
        "lastUserInputAt": run.last_user_input_at,
        "autoSteer": { "count": if run.autosteered { 1 } else { 0 }, "max": 2 },
    });
    let temp = record_path.with_extension(format!(
        "json.{}.{}.tmp",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
    ));
    fs::write(
        &temp,
        format!("{}\n", serde_json::to_string_pretty(&record)?),
    )?;
    fs::rename(temp, record_path)?;
    Ok(())
}

fn remove_native_run_record(repo_root: &Path, run_id: &str) -> Result<()> {
    let dir = native_run_dir(repo_root, run_id);
    if dir.exists() {
        fs::remove_dir_all(dir)?;
    }
    Ok(())
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

fn conflicted_files(cwd: &Path) -> Vec<String> {
    git_output(cwd, ["diff", "--name-only", "--diff-filter=U"])
        .unwrap_or_default()
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(ToOwned::to_owned)
        .collect()
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
    let mut body = String::from("# RUDDER PROMPT INJECTION CONTEXT\n\nThis file is generated and prompt-injected by Rudder. It is not user-authored repo documentation. Use it to coordinate with other Rudder agents in this checkout.\n\n## Active local Rudder agents\n");
    if agents.is_empty() && pending.is_none() {
        body.push_str("- none\n");
    }
    for agent in agents {
        let current_prompt = if agent.current_prompt != agent.task {
            format!(" current=\"{}\"", preview_text(&agent.current_prompt, 140))
        } else {
            String::new()
        };
        body.push_str(&format!(
            "- {}: {} [{} {}] cwd={}{}\n",
            agent.id,
            agent.task,
            agent.backend.as_str(),
            agent.model,
            agent.cwd.display(),
            current_prompt
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
        "\n## Rudder review integration\n\nRudder opens `hunk diff --watch` in the review pane when available. If a live Hunk review is open, run `hunk skill path`, load that skill, then use `hunk session review --repo . --json` to inspect the review and `hunk session comment add/apply --repo .` to leave inline notes for the user.\n",
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
    let theme = hunk_light_theme();
    let contents = [
        format!("theme = \"{theme}\""),
        "mode = \"auto\"".to_string(),
        "vcs = \"git\"".to_string(),
        "exclude_untracked = false".to_string(),
        "line_numbers = true".to_string(),
        "wrap_lines = false".to_string(),
        "agent_notes = true".to_string(),
        String::new(),
    ]
    .join("\n");
    fs::write(config, contents)?;
    Ok(())
}

fn hunk_light_theme() -> String {
    match env::var("RUDDER_HUNK_THEME") {
        Ok(value) if value == "light" => "paper".to_string(),
        Ok(value) if matches!(value.as_str(), "paper" | "graphite" | "midnight" | "ember") => value,
        _ => "paper".to_string(),
    }
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

fn now_stamp() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .to_string()
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
