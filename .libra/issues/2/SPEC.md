## Problem Summary

When the `codex` or `claude` CLI tools are not installed/available on the system, the application throws an unhandled error instead of gracefully handling the missing dependency. This likely causes a crash or unhelpful error message rather than a clear, actionable notification to the user.

## Acceptance Criteria

1. If `codex` is not found on the system, the application displays a clear, human-readable error message (e.g., "codex is not installed or not found in PATH. Please install it before using this feature.") and exits gracefully.
2. If `claude` is not found on the system, the application displays a clear, human-readable error message similarly and exits gracefully.
3. No unhandled exceptions or stack traces are shown to the user when either tool is missing.
4. The error message should ideally include a hint or link on how to install the missing tool.
5. The rest of the application continues to function for features that do not depend on the missing tool (if applicable).

## Likely Files/Areas

- `rudder/` — main application source directory; any module that invokes `codex` or `claude` as a subprocess or shell command
- Files that use `subprocess.run`, `subprocess.Popen`, `os.system`, or `shutil.which` to call `codex`/`claude`
- Entry point script (e.g., `main.py`, `cli.py`, `rudder.py`, or `__main__.py`)
- Any configuration or provider abstraction layer that selects between `codex` and `claude`

## Implementation Plan

1. **Locate all invocation sites** where `codex` and `claude` are called (search for `subprocess`, `os.system`, `shutil.which`, or string literals `"codex"` / `"claude"` in the codebase).

2. **Add a pre-flight availability check** using `shutil.which`:
   ```python
   import shutil

   def check_tool_available(tool_name: str) -> bool:
       return shutil.which(tool_name) is not None
   ```

3. **Integrate the check** before any invocation of `codex` or `claude`:
   ```python
   INSTALL_HINTS = {
       "codex": "https://github.com/openai/codex",
       "claude": "https://github.com/anthropics/claude-cli",
   }

   def require_tool(tool_name: str):
       if not check_tool_available(tool_name):
           hint = INSTALL_HINTS.get(tool_name, "Please install it and ensure it is in your PATH.")
           print(f"Error: '{tool_name}' is not installed or not found in PATH.\n"
                 f"Install it from: {hint}")
           sys.exit(1)
   ```

4. **Wrap subprocess calls** in a try/except for `FileNotFoundError` as a secondary safety net:
   ```python
   try:
       result = subprocess.run([tool_name, ...], ...)
   except FileNotFoundError:
       require_tool(tool_name)  # will print message and exit
   ```

5. **Add the check at startup** (or at the point of feature selection) so the user is informed immediately rather than mid-execution.

6. **Update any provider/selector logic** so that if a tool is unavailable and the user explicitly requested it, the error is surfaced clearly rather than falling through silently.

## Verification Plan

1. **Unit tests**: Mock `shutil.which` to return `None` for `codex`/`claude` and assert that `require_tool` prints the expected message and calls `sys.exit(1)`.
2. **Integration test**: Temporarily rename/remove `codex` or `claude` from PATH in a test environment and run `rudder`; confirm the error message is shown and the process exits with a non-zero code.
3. **Happy path**: Confirm that when both tools are present, existing behavior is unchanged.
4. **Partial availability**: Confirm that if only one tool is missing, only the relevant error is shown when that tool's feature is invoked.

## Risk/Rollback Notes

- **Low risk**: This change is purely additive — it adds guard checks before existing invocations without altering core logic.
- **Rollback**: Revert the added `require_tool` calls and `check_tool_available` function; no data or state is affected.
- **Edge case**: On some systems, a tool may be installed but not in `PATH` at the time of the check (e.g., nvm-managed tools, conda envs). The error message should guide users to check their PATH in addition to installation.
- **Windows compatibility**: `shutil.which` works cross-platform, but ensure the tool names do not need `.exe` suffixes explicitly (Python handles this automatically on Windows).