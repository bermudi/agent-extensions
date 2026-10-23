#!/usr/bin/env python3
"""Copy the focused pane's Herdr context variables to the clipboard.

Runs as the `pane.context.copy` plugin action. Herdr injects the focused
pane's ids before launching it, so a keybinding never has to inspect the UI.
The clipboard gets one KEY=value line per entry, in pasteable env-file order:
HERDR_PANE_ID, HERDR_SOCKET_PATH, HERDR_TAB_ID, HERDR_WORKSPACE_ID.

A toast confirms the copy; failures exit nonzero and surface in
`herdr plugin log list --plugin pane.context`.
"""

import os
import shutil
import subprocess
import sys
from typing import Callable, Iterable, NoReturn, Optional, Sequence, Tuple

KEYS = (
    "HERDR_PANE_ID",
    "HERDR_SOCKET_PATH",
    "HERDR_TAB_ID",
    "HERDR_WORKSPACE_ID",
)

TOAST_TITLE = "Pane context copied"
_BIN_WARNED = False


class ContextError(RuntimeError):
    pass


def herdr_bin() -> str:
    """Prefer the running server's binary; HERDR_BIN_PATH can go stale."""
    global _BIN_WARNED
    candidate = os.environ.get("HERDR_BIN_PATH", "").strip()
    if candidate.endswith(" (deleted)"):
        candidate = candidate[: -len(" (deleted)")]
    if candidate and os.path.isfile(candidate) and os.access(candidate, os.X_OK):
        return candidate
    if candidate and not _BIN_WARNED:
        _BIN_WARNED = True
        print(
            f"warning: HERDR_BIN_PATH {candidate!r} is missing or not executable; "
            "falling back to 'herdr' on PATH",
            file=sys.stderr,
        )
    return "herdr"


def run(args: Sequence[str], *, stdin: Optional[bytes] = None, timeout: float = 10) -> Tuple[int, bytes, bytes]:
    try:
        proc = subprocess.run(args, input=stdin, capture_output=True, timeout=timeout)
    except FileNotFoundError:
        raise ContextError(f"command not found: {args[0]}")
    except subprocess.TimeoutExpired:
        raise ContextError(f"command timed out: {args[0]}")
    return proc.returncode, proc.stdout, proc.stderr


def clipboard_commands() -> Iterable[Tuple[Sequence[str], Callable[[], bool]]]:
    wayland = bool(os.environ.get("WAYLAND_DISPLAY"))
    x11 = bool(os.environ.get("DISPLAY"))
    if sys.platform == "darwin":
        yield ("pbcopy",), lambda: True
    if wayland:
        yield ("wl-copy",), lambda: bool(shutil.which("wl-copy"))
    if x11:
        yield ("xclip", "-selection", "clipboard"), lambda: bool(shutil.which("xclip"))
        yield ("xsel", "--clipboard", "--input"), lambda: bool(shutil.which("xsel"))
    yield ("wl-copy",), lambda: bool(shutil.which("wl-copy"))
    yield ("xclip", "-selection", "clipboard"), lambda: bool(shutil.which("xclip"))


def feed_stdin(args: Sequence[str], data: bytes, timeout: float = 10) -> int:
    """Write data to a clipboard tool's stdin and return its exit code.

    Clipboard daemons like wl-copy fork a long-lived child to serve the
    selection; that child inherits any piped stdout/stderr and would keep
    subprocess.run blocked past our timeout even though the copy succeeded.
    DEVNULL keeps the wait bounded to the parent process only.
    """
    try:
        proc = subprocess.Popen(
            args,
            stdin=subprocess.PIPE,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    except FileNotFoundError:
        return 127
    try:
        proc.communicate(data, timeout=timeout)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait()
        return 124
    return proc.returncode or 0


def copy_to_clipboard(payload: str) -> str:
    data = payload.encode("utf-8")
    attempts = []
    for args, available in clipboard_commands():
        if not available():
            continue
        rc = feed_stdin(args, data)
        if rc == 0:
            return str(args[0])
        attempts.append(f"{args[0]} exited {rc}")
    detail = "; ".join(attempts) or "no supported clipboard command found"
    raise ContextError(f"clipboard copy failed: {detail}")


def payload(env: dict[str, str]) -> str:
    missing = [key for key in KEYS if not env.get(key)]
    if missing:
        raise ContextError(f"missing focused-pane context: {', '.join(missing)}")
    return "\n".join(f"{key}={env[key]}" for key in KEYS)


def notify(body: str) -> None:
    run([herdr_bin(), "notification", "show", TOAST_TITLE, "--body", body])


def die(message: str) -> NoReturn:
    print(message, file=sys.stderr)
    try:
        notify(message)
    except Exception:
        pass
    raise SystemExit(1)


def main() -> int:
    try:
        text = payload(dict(os.environ))
        tool = copy_to_clipboard(text)
        pane_id = os.environ["HERDR_PANE_ID"]
        notify(f"{pane_id} copied via {tool}")
    except ContextError as exc:
        die(str(exc))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
