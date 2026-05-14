use std::{
    fs,
    hash::{Hash, Hasher},
    io::{self, Stdout},
    path::{Path, PathBuf},
    process::Command,
    time::{Duration, Instant},
    time::{SystemTime, UNIX_EPOCH},
};

use anyhow::{Context, Result};
use crossterm::{
    event::{self, Event, KeyCode, KeyEvent, KeyModifiers},
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
    TerminalCommand, TerminalPane, TerminalPaneOptions, TerminalSize,
};

type Tui = Terminal<CrosstermBackend<Stdout>>;

const TICK_RATE: Duration = Duration::from_millis(50);
const AUTO_STEER_DELAY: Duration = Duration::from_secs(10);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum FocusPane {
    Agents,
    Worker,
    Task,
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
    fn toggle(self) -> Self {
        match self {
            Self::Claude => Self::Codex,
            Self::Codex => Self::Claude,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
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
    cwd: PathBuf,
    branch: Option<String>,
    task_input: String,
    agents: Vec<AgentRun>,
    selected_agent: usize,
    backend: Backend,
    model: String,
    notice: Option<String>,
    delete_pending: Option<String>,
}

struct AgentRun {
    id: String,
    task: String,
    backend: Backend,
    model: String,
    status: AgentStatus,
    cwd: PathBuf,
    worktree_branch: Option<String>,
    worktree_path: Option<PathBuf>,
    terminal: Option<TerminalPane>,
    terminal_size: Option<TerminalSize>,
    last_output_at: Instant,
    completed_at: Option<Instant>,
    autosteered: bool,
    last_error: Option<String>,
}

impl App {
    fn new() -> Self {
        let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
        Self {
            focus: FocusPane::Task,
            cwd,
            branch: current_branch(),
            task_input: String::new(),
            agents: Vec::new(),
            selected_agent: 0,
            backend: Backend::Claude,
            model: "default".to_string(),
            notice: None,
            delete_pending: None,
        }
    }

    fn handle_key(&mut self, key: KeyEvent) -> bool {
        if key.modifiers.contains(KeyModifiers::CONTROL) && key.code == KeyCode::Char('c') {
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

    fn handle_agents_key(&mut self, key: KeyEvent) -> bool {
        match key.code {
            KeyCode::Char('q') => return true,
            KeyCode::Up | KeyCode::Char('k') => {
                self.selected_agent = self.selected_agent.saturating_sub(1);
            }
            KeyCode::Down | KeyCode::Char('j') => {
                let last = self.agents.len().saturating_sub(1);
                self.selected_agent = (self.selected_agent + 1).min(last);
            }
            KeyCode::Enter => {
                if !self.agents.is_empty() {
                    self.focus = FocusPane::Worker;
                }
            }
            KeyCode::Char('m') => self.merge_selected_agent(),
            KeyCode::Char('d') => self.delete_selected_agent(),
            _ => {}
        }
        false
    }

    fn handle_worker_key(&mut self, key: KeyEvent) -> bool {
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

    fn handle_task_key(&mut self, key: KeyEvent) -> bool {
        match key.code {
            KeyCode::Esc => self.task_input.clear(),
            KeyCode::Enter => self.start_task(),
            KeyCode::Backspace => {
                if key
                    .modifiers
                    .intersects(KeyModifiers::ALT | KeyModifiers::CONTROL)
                {
                    delete_previous_word(&mut self.task_input);
                } else {
                    self.task_input.pop();
                }
            }
            KeyCode::Char('u') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                self.task_input.clear();
            }
            KeyCode::Char('w') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                delete_previous_word(&mut self.task_input);
            }
            KeyCode::Char('/') if self.task_input.is_empty() => {
                self.task_input.push('/');
                self.notice =
                    Some("commands: /backend claude|codex, /model <id>, /clear".to_string());
            }
            KeyCode::Char(ch) => self.task_input.push(ch),
            _ => {}
        }
        false
    }

    fn handle_paste(&mut self, text: String) {
        match self.focus {
            FocusPane::Worker => {
                if let Some(terminal) = self.selected_terminal_mut() {
                    if let Err(error) = terminal.write_input(text.as_bytes()) {
                        self.set_selected_error(error.to_string());
                    }
                }
            }
            FocusPane::Task => self.task_input.push_str(&text),
            FocusPane::Agents => {}
        }
    }

    fn start_task(&mut self) {
        let input = self.task_input.trim().to_string();
        if input.is_empty() {
            return;
        }
        self.task_input.clear();

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

        let model = self.model.clone();
        let backend = self.backend;
        let command = agent_command(backend, &model, &input);
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
            status: AgentStatus::Running,
            cwd: worktree.path.clone(),
            worktree_branch: worktree.branch.clone(),
            worktree_path: worktree.path_is_worktree.then_some(worktree.path.clone()),
            terminal: None,
            terminal_size: None,
            last_output_at: Instant::now(),
            completed_at: None,
            autosteered: false,
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
            Some("/clear") => {
                self.agents.clear();
                self.selected_agent = 0;
                self.notice = Some("cleared local dashboard runs".to_string());
                true
            }
            Some("/backend") => {
                match parts.next() {
                    Some("claude") => self.backend = Backend::Claude,
                    Some("codex") => self.backend = Backend::Codex,
                    _ => self.backend = self.backend.toggle(),
                }
                self.notice = Some(format!("backend {}", self.backend.as_str()));
                true
            }
            Some("/model") => {
                let model = parts.collect::<Vec<_>>().join(" ");
                if model.is_empty() {
                    self.notice = Some("usage: /model <model-id-or-alias>".to_string());
                } else {
                    self.model = model;
                    self.notice = Some(format!("model {}", self.model));
                }
                true
            }
            Some("/help") => {
                self.notice =
                    Some("Tab focus pane, Enter start/focus, /backend, /model, /clear".to_string());
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

    fn set_selected_error(&mut self, message: String) {
        if let Some(run) = self.agents.get_mut(self.selected_agent) {
            run.status = AgentStatus::Failed;
            run.last_error = Some(message);
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
        let Some(run) = self.agents.get(self.selected_agent) else {
            return;
        };
        let Some(branch) = run.worktree_branch.clone() else {
            self.notice = Some("selected agent is not in a worktree".to_string());
            return;
        };
        let cwd = run.cwd.clone();
        let task = run.task.clone();
        let worktree_path = run.worktree_path.clone();

        if has_git_changes(&cwd) {
            if let Err(error) = git_status_command(&cwd, &["add", "-A"]) {
                self.notice = Some(format!("merge failed: {error}"));
                return;
            }
            let message = format!("rudder: {}", short_task(&task));
            let _ = git_status_command(&cwd, &["commit", "-m", &message]);
        }

        match git_status_command(&self.cwd, &["merge", "--no-ff", &branch]) {
            Ok(()) => {
                if let Some(path) = worktree_path {
                    let _ = Command::new("git")
                        .args(["worktree", "remove", "--force"])
                        .arg(path)
                        .current_dir(&self.cwd)
                        .output();
                }
                if let Some(run) = self.agents.get_mut(self.selected_agent) {
                    run.worktree_path = None;
                    run.worktree_branch = None;
                }
                self.delete_pending = None;
                self.notice = Some("merged selected worktree".to_string());
            }
            Err(error) => {
                self.notice = Some(format!("merge stopped: {error}"));
            }
        }
    }

    fn poll_agents(&mut self) {
        for run in &mut self.agents {
            let Some(terminal) = run.terminal.as_mut() else {
                continue;
            };
            if !terminal.drain_output().is_empty() {
                run.last_output_at = Instant::now();
            }
            if run.status == AgentStatus::Running {
                match terminal.try_wait() {
                    Ok(Some(status)) => {
                        run.status = if status.success() {
                            AgentStatus::Done
                        } else {
                            AgentStatus::Failed
                        };
                        run.completed_at = Some(Instant::now());
                    }
                    Ok(None) => {}
                    Err(error) => {
                        run.status = AgentStatus::Failed;
                        run.completed_at = Some(Instant::now());
                        run.last_error = Some(error.to_string());
                    }
                }
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
            let command = agent_command(run.backend, &run.model, &prompt);
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
    execute!(stdout, EnterAlternateScreen)?;
    Ok(Terminal::new(CrosstermBackend::new(stdout))?)
}

fn restore_terminal(terminal: &mut Tui) -> Result<()> {
    disable_raw_mode()?;
    execute!(terminal.backend_mut(), LeaveAlternateScreen)?;
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
                Event::Key(key) => {
                    if app.handle_key(key) {
                        break;
                    }
                }
                Event::Paste(text) => app.handle_paste(text),
                _ => {}
            }
        }
    }

    Ok(())
}

fn render(frame: &mut Frame<'_>, app: &mut App) {
    let area = frame.area();
    frame.render_widget(Clear, area);

    let rows = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Min(8),
            Constraint::Length(1),
            Constraint::Length(4),
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

    render_agents(frame, main[0], app);
    render_gutter(frame, main[1], Gutter::Vertical);
    render_worker(frame, main[2], app);
    render_gutter(frame, rows[1], Gutter::Horizontal);
    render_task(frame, rows[2], app);
}

#[derive(Clone, Copy)]
enum Gutter {
    Horizontal,
    Vertical,
}

fn render_gutter(frame: &mut Frame<'_>, area: Rect, gutter: Gutter) {
    let style = Style::default().fg(Color::DarkGray);
    let line = match gutter {
        Gutter::Horizontal => "─".repeat(area.width as usize),
        Gutter::Vertical => " ".to_string(),
    };

    let lines = vec![Line::from(Span::styled(line, style)); area.height as usize];
    frame.render_widget(Paragraph::new(lines), area);
}

fn render_agents(frame: &mut Frame<'_>, area: Rect, app: &App) {
    let mut lines = vec![
        ListItem::new(Line::from(Span::styled(
            "rudder",
            Style::default().add_modifier(Modifier::BOLD),
        ))),
        ListItem::new(Line::from(vec![
            Span::raw(app.cwd.display().to_string()),
            Span::raw(" "),
            Span::styled(
                app.branch.as_deref().unwrap_or("no-branch"),
                Style::default().fg(Color::Gray),
            ),
        ])),
        ListItem::new(Line::from(vec![
            Span::raw("agents "),
            Span::styled(
                app.agents.len().to_string(),
                Style::default().fg(Color::Cyan),
            ),
            Span::raw(" runs"),
        ])),
        ListItem::new(Line::default()),
    ];

    for (index, agent) in app.agents.iter().enumerate() {
        let selected = index == app.selected_agent;
        let marker = if selected { "> " } else { "  " };
        let task_style = if selected {
            Style::default()
                .fg(Color::Cyan)
                .add_modifier(Modifier::BOLD)
        } else {
            Style::default().fg(status_color(agent.status))
        };

        lines.push(ListItem::new(Line::from(vec![
            Span::styled(marker, Style::default().fg(Color::Cyan)),
            Span::styled(short_task(&agent.task), task_style),
        ])));
        lines.push(ListItem::new(Line::from(vec![
            Span::raw("  "),
            Span::styled(
                if agent.worktree_path.is_some() {
                    "wt"
                } else {
                    "co"
                },
                Style::default().fg(Color::Gray),
            ),
            Span::raw("  "),
            Span::styled(agent.status.as_str(), status_style(agent.status)),
            Span::raw("  "),
            Span::styled(agent.backend.as_str(), Style::default().fg(Color::Gray)),
            Span::raw("  "),
            Span::styled(agent.model.as_str(), Style::default().fg(Color::Magenta)),
            Span::raw("  "),
            Span::styled(
                agent.worktree_branch.as_deref().unwrap_or("current"),
                Style::default().fg(Color::DarkGray),
            ),
        ])));
    }

    if app.agents.is_empty() {
        lines.push(ListItem::new(Line::from(Span::styled(
            "no agents yet",
            Style::default().fg(Color::DarkGray),
        ))));
    }

    lines.push(ListItem::new(Line::default()));
    lines.push(ListItem::new(Line::from(Span::styled(
        "j/k select  Enter focus  d delete",
        Style::default().fg(Color::Gray),
    ))));

    frame.render_widget(
        List::new(lines).block(pane_block("agents", app.focus == FocusPane::Agents)),
        area,
    );
}

fn render_worker(frame: &mut Frame<'_>, area: Rect, app: &mut App) {
    let inner = block_inner(area);
    let terminal_size = TerminalSize::new(inner.height.max(1), inner.width.max(1)).ok();
    let focused = app.focus == FocusPane::Worker;

    if let Some(size) = terminal_size {
        if let Some(run) = app.agents.get_mut(app.selected_agent) {
            if run.terminal_size != Some(size) {
                if let Some(terminal) = run.terminal.as_mut() {
                    if terminal.resize(size).is_ok() {
                        run.terminal_size = Some(size);
                    }
                }
            }
        }
    }

    let lines = worker_lines(app, inner.height as usize);
    let paragraph = Paragraph::new(lines)
        .block(pane_block("worker", focused))
        .wrap(Wrap { trim: false });

    frame.render_widget(paragraph, area);
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
        .visible_lines()
        .into_iter()
        .map(Line::from)
        .collect::<Vec<_>>();
    if lines.len() > height {
        lines = lines.split_off(lines.len() - height);
    }
    lines
}

fn render_task(frame: &mut Frame<'_>, area: Rect, app: &App) {
    let input = if app.task_input.is_empty() {
        Line::from(Span::styled(
            "Type a task or /help",
            Style::default().fg(Color::DarkGray),
        ))
    } else {
        Line::from(app.task_input.as_str())
    };

    let hint = app
        .notice
        .as_deref()
        .unwrap_or("Enter start  Tab focus pane  / commands");
    let paragraph = Paragraph::new(vec![
        input,
        Line::from(vec![
            Span::styled(hint.to_string(), Style::default().fg(Color::Gray)),
            Span::raw("  "),
            Span::styled(app.backend.as_str(), Style::default().fg(Color::Cyan)),
            Span::raw(" "),
            Span::styled(app.model.as_str(), Style::default().fg(Color::Magenta)),
        ]),
    ])
    .block(pane_block("task", app.focus == FocusPane::Task));

    frame.render_widget(paragraph, area);

    if app.focus == FocusPane::Task {
        let x = area.x + 1 + app.task_input.chars().count() as u16;
        let y = area.y + 1;
        if x < area.right().saturating_sub(1) {
            frame.set_cursor_position((x, y));
        }
    }
}

fn pane_block(title: &'static str, focused: bool) -> Block<'static> {
    let border_style = if focused {
        Style::default()
            .fg(Color::Blue)
            .add_modifier(Modifier::BOLD)
    } else {
        Style::default().fg(Color::DarkGray)
    };

    let title_style = if focused {
        Style::default()
            .fg(Color::Black)
            .bg(Color::Blue)
            .add_modifier(Modifier::BOLD)
    } else {
        Style::default().fg(Color::Gray)
    };

    Block::default()
        .title(Line::from(Span::styled(format!(" {title} "), title_style)))
        .borders(Borders::ALL)
        .border_style(border_style)
}

fn block_inner(area: Rect) -> Rect {
    Rect {
        x: area.x.saturating_add(1),
        y: area.y.saturating_add(1),
        width: area.width.saturating_sub(2),
        height: area.height.saturating_sub(2),
    }
}

fn status_style(status: AgentStatus) -> Style {
    Style::default().fg(status_color(status))
}

fn status_color(status: AgentStatus) -> Color {
    match status {
        AgentStatus::Running => Color::Yellow,
        AgentStatus::Done => Color::Green,
        AgentStatus::Failed => Color::Red,
    }
}

fn agent_command(backend: Backend, model: &str, task: &str) -> TerminalCommand {
    let prompt = format!("Read RUDDER.md first if it exists.\n\n{task}");
    match backend {
        Backend::Claude => {
            let mut args = vec![
                "--permission-mode".to_string(),
                "bypassPermissions".to_string(),
            ];
            if model != "default" {
                args.push("--model".to_string());
                args.push(model.to_string());
            }
            args.push(prompt);
            TerminalCommand::with_args("claude", args)
        }
        Backend::Codex => {
            let mut args = vec![
                "-c".to_string(),
                "model_reasoning_effort=\"xhigh\"".to_string(),
                "--ask-for-approval".to_string(),
                "never".to_string(),
                "--sandbox".to_string(),
                "danger-full-access".to_string(),
                "-c".to_string(),
                "model_reasoning_summary=\"detailed\"".to_string(),
                "-c".to_string(),
                "model_supports_reasoning_summaries=true".to_string(),
            ];
            if model != "default" {
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

fn delete_previous_word(input: &mut String) {
    while input.ends_with(char::is_whitespace) {
        input.pop();
    }
    while input.chars().last().is_some_and(|ch| !ch.is_whitespace()) {
        input.pop();
    }
}

fn terminal_bytes_for_key(key: KeyEvent) -> Option<Vec<u8>> {
    let bytes = match key.code {
        KeyCode::Char(ch) => {
            if key.modifiers.contains(KeyModifiers::CONTROL) {
                match ch {
                    'c' => vec![0x03],
                    'd' => vec![0x04],
                    'u' => vec![0x15],
                    'w' => vec![0x17],
                    _ => return None,
                }
            } else {
                ch.to_string().into_bytes()
            }
        }
        KeyCode::Enter => b"\r".to_vec(),
        KeyCode::Backspace => vec![0x7f],
        KeyCode::Esc => vec![0x1b],
        KeyCode::Left => b"\x1b[D".to_vec(),
        KeyCode::Right => b"\x1b[C".to_vec(),
        KeyCode::Up => b"\x1b[A".to_vec(),
        KeyCode::Down => b"\x1b[B".to_vec(),
        KeyCode::Home => b"\x1b[H".to_vec(),
        KeyCode::End => b"\x1b[F".to_vec(),
        KeyCode::Delete => b"\x1b[3~".to_vec(),
        _ => return None,
    };
    Some(bytes)
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
    fs::write(repo_root.join("RUDDER.md"), body.as_bytes())?;
    if let Some(worktree) = pending {
        if worktree.path_is_worktree {
            fs::write(worktree.path.join("RUDDER.md"), body.as_bytes())?;
        }
    }
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
