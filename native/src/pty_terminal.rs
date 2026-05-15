//! PTY-backed terminal pane abstraction for the native Rudder app.
//!
//! `TerminalPane` intentionally keeps the process/PTY plumbing separate from
//! the rest of the app. It currently uses `portable-pty` for cross-platform PTY
//! creation and `vt100` for a plain-text terminal screen buffer. The public API
//! is small enough that the buffer backend can be replaced with
//! `alacritty_terminal` later without forcing app layout code to change.

use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::mpsc::{self, Receiver};
use std::thread::{self, JoinHandle};

use anyhow::{anyhow, Context, Result};
use portable_pty::{Child, CommandBuilder, MasterPty, PtySize};

const DEFAULT_ROWS: u16 = 24;
const DEFAULT_COLS: u16 = 80;
const DEFAULT_SCROLLBACK_LINES: usize = 2_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TerminalSize {
    pub rows: u16,
    pub cols: u16,
}

impl TerminalSize {
    pub fn new(rows: u16, cols: u16) -> Result<Self> {
        if rows == 0 || cols == 0 {
            return Err(anyhow!("terminal size must be non-zero"));
        }

        Ok(Self { rows, cols })
    }

    fn pty_size(self) -> PtySize {
        PtySize {
            rows: self.rows,
            cols: self.cols,
            pixel_width: 0,
            pixel_height: 0,
        }
    }
}

impl Default for TerminalSize {
    fn default() -> Self {
        Self {
            rows: DEFAULT_ROWS,
            cols: DEFAULT_COLS,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TerminalCommand {
    pub program: String,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
}

impl TerminalCommand {
    pub fn new(program: impl Into<String>) -> Self {
        Self {
            program: program.into(),
            args: Vec::new(),
            env: Vec::new(),
        }
    }

    pub fn with_args(
        program: impl Into<String>,
        args: impl IntoIterator<Item = impl Into<String>>,
    ) -> Self {
        Self {
            program: program.into(),
            args: args.into_iter().map(Into::into).collect(),
            env: Vec::new(),
        }
    }

    pub fn with_env(mut self, key: impl Into<String>, value: impl Into<String>) -> Self {
        self.env.push((key.into(), value.into()));
        self
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TerminalPaneOptions {
    pub size: TerminalSize,
    pub cwd: Option<PathBuf>,
    pub scrollback_lines: usize,
    pub term: String,
}

impl Default for TerminalPaneOptions {
    fn default() -> Self {
        Self {
            size: TerminalSize::default(),
            cwd: None,
            scrollback_lines: DEFAULT_SCROLLBACK_LINES,
            term: "xterm-256color".to_string(),
        }
    }
}

pub struct TerminalPane {
    master: Box<dyn MasterPty + Send>,
    child: Box<dyn Child + Send + Sync>,
    writer: Box<dyn Write + Send>,
    output_rx: Receiver<Vec<u8>>,
    reader_thread: Option<JoinHandle<()>>,
    parser: vt100::Parser,
    size: TerminalSize,
    alternate_history: Vec<Vec<String>>,
    alternate_history_offset: usize,
    last_alternate_snapshot: Vec<String>,
    alternate_history_limit: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StyledTerminalCell {
    pub contents: String,
    pub fg: vt100::Color,
    pub bg: vt100::Color,
    pub bold: bool,
    pub dim: bool,
    pub italic: bool,
    pub underline: bool,
    pub inverse: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TerminalCursor {
    pub row: u16,
    pub col: u16,
    pub visible: bool,
}

impl TerminalPane {
    /// Spawn the user's shell when `command` is `None`, or spawn the supplied
    /// program and arguments when it is `Some`.
    ///
    /// Output is collected by a background reader thread. Call
    /// [`drain_output`](Self::drain_output) to feed pending bytes into the
    /// terminal buffer, then [`visible_lines_snapshot`](Self::visible_lines_snapshot)
    /// to render the current screen as plain text without draining again.
    pub fn spawn_shell_or_command(
        command: Option<TerminalCommand>,
        options: TerminalPaneOptions,
    ) -> Result<Self> {
        let pty_system = portable_pty::native_pty_system();
        let pair = pty_system
            .openpty(options.size.pty_size())
            .context("failed to open PTY")?;

        let mut builder = command_builder(command)?;
        builder.env("TERM", &options.term);
        if let Some(cwd) = &options.cwd {
            builder.cwd(cwd);
        }

        let child = pair
            .slave
            .spawn_command(builder)
            .context("failed to spawn command in PTY")?;
        drop(pair.slave);

        let mut reader = pair
            .master
            .try_clone_reader()
            .context("failed to clone PTY reader")?;
        let writer = pair
            .master
            .take_writer()
            .context("failed to open PTY writer")?;
        let (output_tx, output_rx) = mpsc::channel();
        let reader_thread = thread::Builder::new()
            .name("rudder-pty-reader".to_string())
            .spawn(move || {
                let mut buf = [0_u8; 8192];
                loop {
                    match reader.read(&mut buf) {
                        Ok(0) => break,
                        Ok(n) => {
                            if output_tx.send(buf[..n].to_vec()).is_err() {
                                break;
                            }
                        }
                        Err(_) => break,
                    }
                }
            })
            .context("failed to start PTY reader thread")?;

        Ok(Self {
            master: pair.master,
            child,
            writer,
            output_rx,
            reader_thread: Some(reader_thread),
            parser: vt100::Parser::new(
                options.size.rows,
                options.size.cols,
                options.scrollback_lines,
            ),
            size: options.size,
            alternate_history: Vec::new(),
            alternate_history_offset: 0,
            last_alternate_snapshot: Vec::new(),
            alternate_history_limit: options.scrollback_lines.max(DEFAULT_ROWS as usize),
        })
    }

    pub fn write_input(&mut self, bytes: &[u8]) -> Result<()> {
        self.writer
            .write_all(bytes)
            .context("failed to write input to PTY")?;
        self.writer.flush().context("failed to flush PTY input")
    }

    pub fn resize(&mut self, size: TerminalSize) -> Result<()> {
        self.master
            .resize(size.pty_size())
            .context("failed to resize PTY")?;
        self.parser.screen_mut().set_size(size.rows, size.cols);
        self.size = size;
        self.last_alternate_snapshot.clear();
        Ok(())
    }

    /// Drain all currently available process output into the terminal buffer.
    ///
    /// The returned bytes are raw terminal output for logging/debugging. The
    /// in-memory buffer is updated before this method returns.
    pub fn drain_output(&mut self) -> Vec<u8> {
        let mut drained = Vec::new();
        while let Ok(chunk) = self.output_rx.try_recv() {
            self.parser.process(&chunk);
            drained.extend_from_slice(&chunk);
        }
        if !drained.is_empty() {
            self.capture_alternate_snapshot();
        }
        drained
    }

    /// Return the current visible terminal rows as plain text.
    ///
    /// This omits attributes, cursor shape, selection state, and image/graphics
    /// protocols. Those are the main reasons the interface is isolated: a later
    /// `alacritty_terminal` backend can preserve richer cell metadata while
    /// keeping callers on this app-facing API.
    pub fn visible_lines(&mut self) -> Vec<String> {
        self.drain_output();
        self.visible_lines_snapshot()
    }

    pub fn visible_lines_snapshot(&self) -> Vec<String> {
        if let Some(snapshot) = self.alternate_history_snapshot() {
            return snapshot.clone();
        }

        self.current_visible_lines_snapshot()
    }

    fn current_visible_lines_snapshot(&self) -> Vec<String> {
        self.parser
            .screen()
            .rows(0, self.size.cols)
            .map(|line| line.trim_end_matches(' ').to_string())
            .collect()
    }

    pub fn styled_lines(&mut self) -> Vec<Vec<StyledTerminalCell>> {
        self.drain_output();
        self.styled_lines_snapshot()
    }

    pub fn styled_lines_snapshot(&self) -> Vec<Vec<StyledTerminalCell>> {
        if let Some(snapshot) = self.alternate_history_snapshot() {
            return snapshot
                .iter()
                .map(|line| {
                    line.chars()
                        .map(|ch| StyledTerminalCell::plain(ch.to_string()))
                        .collect()
                })
                .collect();
        }

        let screen = self.parser.screen();
        let mut rows = Vec::with_capacity(self.size.rows as usize);

        for row in 0..self.size.rows {
            let mut cells = Vec::with_capacity(self.size.cols as usize);
            for col in 0..self.size.cols {
                let Some(cell) = screen.cell(row, col) else {
                    continue;
                };
                if cell.is_wide_continuation() {
                    continue;
                }
                let contents = if cell.has_contents() {
                    cell.contents().to_string()
                } else {
                    " ".to_string()
                };
                cells.push(StyledTerminalCell {
                    contents,
                    fg: cell.fgcolor(),
                    bg: cell.bgcolor(),
                    bold: cell.bold(),
                    dim: cell.dim(),
                    italic: cell.italic(),
                    underline: cell.underline(),
                    inverse: cell.inverse(),
                });
            }

            while cells
                .last()
                .is_some_and(|cell| cell.contents == " " && cell.bg == vt100::Color::Default)
            {
                cells.pop();
            }
            rows.push(cells);
        }

        rows
    }

    pub fn size(&self) -> TerminalSize {
        self.size
    }

    pub fn scrollback(&self) -> usize {
        if self.parser.screen().alternate_screen() {
            return self.alternate_history_offset;
        }
        self.parser.screen().scrollback()
    }

    pub fn wants_sgr_mouse_events(&mut self) -> bool {
        self.drain_output();
        let screen = self.parser.screen();
        screen.mouse_protocol_mode() != vt100::MouseProtocolMode::None
            && screen.mouse_protocol_encoding() == vt100::MouseProtocolEncoding::Sgr
    }

    pub fn uses_alternate_screen(&mut self) -> bool {
        self.drain_output();
        self.parser.screen().alternate_screen()
    }

    pub fn scrollback_by(&mut self, rows: isize) {
        if self.parser.screen().alternate_screen() {
            self.capture_alternate_snapshot();
            let max_offset = self.alternate_history.len().saturating_sub(1);
            self.alternate_history_offset = if rows.is_negative() {
                self.alternate_history_offset
                    .saturating_sub(rows.unsigned_abs())
            } else {
                self.alternate_history_offset.saturating_add(rows as usize)
            }
            .min(max_offset);
            return;
        }

        let current = self.parser.screen().scrollback();
        let next = if rows.is_negative() {
            current.saturating_sub(rows.unsigned_abs())
        } else {
            current.saturating_add(rows as usize)
        };
        self.parser.screen_mut().set_scrollback(next);
    }

    pub fn reset_scrollback(&mut self) {
        self.alternate_history_offset = 0;
        self.parser.screen_mut().set_scrollback(0);
    }

    pub fn cursor(&self) -> TerminalCursor {
        let (row, col) = self.parser.screen().cursor_position();
        TerminalCursor {
            row,
            col,
            visible: !self.parser.screen().hide_cursor(),
        }
    }

    pub fn child_process_id(&self) -> Option<u32> {
        self.child.process_id()
    }

    pub fn try_wait(&mut self) -> Result<Option<portable_pty::ExitStatus>> {
        self.child.try_wait().context("failed to poll child status")
    }
}

impl StyledTerminalCell {
    fn plain(contents: String) -> Self {
        Self {
            contents,
            fg: vt100::Color::Default,
            bg: vt100::Color::Default,
            bold: false,
            dim: false,
            italic: false,
            underline: false,
            inverse: false,
        }
    }
}

impl TerminalPane {
    fn capture_alternate_snapshot(&mut self) {
        if !self.parser.screen().alternate_screen() {
            self.alternate_history_offset = 0;
            self.last_alternate_snapshot.clear();
            return;
        }

        let snapshot = self.current_visible_lines_snapshot();
        if snapshot == self.last_alternate_snapshot {
            return;
        }

        self.last_alternate_snapshot = snapshot.clone();
        self.alternate_history.push(snapshot);
        if self.alternate_history.len() > self.alternate_history_limit {
            let overflow = self.alternate_history.len() - self.alternate_history_limit;
            self.alternate_history.drain(0..overflow);
            self.alternate_history_offset = self.alternate_history_offset.saturating_sub(overflow);
        }
    }

    fn alternate_history_snapshot(&self) -> Option<&Vec<String>> {
        if !self.parser.screen().alternate_screen() || self.alternate_history_offset == 0 {
            return None;
        }
        let index = self
            .alternate_history
            .len()
            .checked_sub(1 + self.alternate_history_offset)?;
        self.alternate_history.get(index)
    }
}

impl Drop for TerminalPane {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.reader_thread.take();
    }
}

fn command_builder(command: Option<TerminalCommand>) -> Result<CommandBuilder> {
    match command {
        Some(command) => {
            if command.program.is_empty() {
                return Err(anyhow!("command program must not be empty"));
            }

            let mut builder = CommandBuilder::new(command.program);
            builder.args(command.args);
            for (key, value) in command.env {
                builder.env(key, value);
            }
            Ok(builder)
        }
        None => {
            let shell = default_shell();
            if shell.is_empty() {
                return Err(anyhow!("could not determine default shell"));
            }
            Ok(CommandBuilder::new(shell))
        }
    }
}

#[cfg(windows)]
fn default_shell() -> String {
    std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_string())
}

#[cfg(not(windows))]
fn default_shell() -> String {
    std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn terminal_size_rejects_zero_dimensions() {
        assert!(TerminalSize::new(0, 80).is_err());
        assert!(TerminalSize::new(24, 0).is_err());
    }

    #[test]
    fn visible_lines_are_plain_text_after_vt100_sequences() {
        let mut pane_buffer = vt100::Parser::new(2, 10, 10);
        pane_buffer.process(b"\x1b[31mred\x1b[0m\r\nplain");

        let lines: Vec<_> = pane_buffer
            .screen()
            .rows(0, 10)
            .map(|line| line.trim_end_matches(' ').to_string())
            .collect();

        assert_eq!(lines, vec!["red", "plain"]);
    }
}
