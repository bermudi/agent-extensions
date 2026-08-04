#!/usr/bin/env python3
"""Interactive pane-layout picker for Herdr.

Runs inside a plugin popup pane (`placement = "popup"`). Draws a small
arrow-driven menu of the layouts defined in `layouts.py`, applies the chosen
one as a new tab via `layout.apply`, and exits — which closes the popup.

It reuses the layout engine in `layouts.py`, so the menu and the engine never
drift apart. Open it with one keybind (see README) and never leave the TUI.

Non-interactive modes (no socket needed for --list; --apply needs the socket):
    python3 picker.py --list
    python3 picker.py --apply main-left --count 3   # script/headless apply
"""

import os
import select
import sys
import tty
import termios

import layouts

# Menu order and per-layout default count. Parametric layouts (columns, rows,
# main-*) let the user nudge the count with -/+ or left/right; quad ignores it.
ORDER = list(layouts.LAYOUTS.keys())
DEFAULT_COUNT = 2
MIN_COUNT, MAX_COUNT = 1, 6

# Control how big the main pane is in main-* layouts.
MAIN_RATIO = 0.6


def read_key(fd):
    """Read one logical key from `fd` (already in raw mode), decoding arrows."""
    ch = os.read(fd, 1)
    if not ch:
        return "eof"
    c = ch.decode("latin-1")  # one byte -> one char; arrows are pure ASCII
    if c == "\x1b":  # ESC, or the start of an arrow-key sequence
        ready, _, _ = select.select([fd], [], [], 0.05)
        if ready:
            rest = os.read(fd, 2).decode("latin-1")
            return {
                "[A": "up",
                "[B": "down",
                "[C": "right",
                "[D": "left",
            }.get(rest, "esc")
        return "esc"
    return {
        "\r": "enter",
        "\n": "enter",
        "\x03": "ctrl-c",
        "\x04": "ctrl-d",
    }.get(c, c)


def render(selected, counts):
    """Redraw the menu. Highlighted row is drawn in reverse video."""
    out = ["\033[2J\033[H", "\033[1mPane layouts\033[0m"]
    out.append("\033[2m  up/down move   -/+ or </> count   enter apply   esc cancel\033[0m")
    out.append("")
    for i, name in enumerate(ORDER):
        _, accepts_count, desc = layouts.LAYOUTS[name]
        suffix = f"  x{counts[name]}" if accepts_count else ""
        marker = ">" if i == selected else " "
        line = f"  {marker} {desc}{suffix}"
        if i == selected:
            line = f"\033[7m{line}\033[0m"
        out.append(line)
    out.append("")
    out.append("\033[2m  opens a new tab; existing panes are untouched\033[0m")
    sys.stdout.write("\r\n".join(out) + "\r\n")
    sys.stdout.flush()


def adjust(counts, name, delta):
    _, accepts_count, _ = layouts.LAYOUTS[name]
    if accepts_count:
        counts[name] = max(MIN_COUNT, min(MAX_COUNT, counts[name] + delta))


def apply_layout(name, count, sock_path):
    """Apply the chosen layout and print a one-line confirmation."""
    params = layouts.apply_params(name, count, MAIN_RATIO, replace=False, cwd=None)
    result = layouts.rpc(sock_path, "layout.apply", params)
    layout = (result or {}).get("layout", {})
    panes = layouts.count_panes(layout["root"]) if layout.get("root") else count
    tab = layout.get("tab_id", "?")
    sys.stdout.write(f"\r\n\033[2J\033[Happlied {layouts.label_for(name, count)} ({panes} panes) -> {tab}\r\n")
    sys.stdout.flush()


def run_menu(sock_path):
    # Raw mode for the whole interactive loop: input arriving between key
    # reads must not be echoed or line-buffered by the cooked discipline, or
    # arrow keys get swallowed waiting for a newline.
    fd = sys.stdin.fileno()
    saved = termios.tcgetattr(fd)
    tty.setraw(fd)
    try:
        counts = {name: DEFAULT_COUNT for name in ORDER}
        selected = 0
        while True:
            render(selected, counts)
            key = read_key(fd)
            if key in ("up", "k"):
                selected = (selected - 1) % len(ORDER)
            elif key in ("down", "j"):
                selected = (selected + 1) % len(ORDER)
            elif key in ("right", "l", "+", "="):
                adjust(counts, ORDER[selected], +1)
            elif key in ("left", "h", "-", "_"):
                adjust(counts, ORDER[selected], -1)
            elif key in ("enter",):
                name = ORDER[selected]
                apply_layout(name, counts[name], sock_path)
                return 0
            elif key in ("esc", "q", "ctrl-c", "ctrl-d", "eof"):
                return 0
    finally:
        termios.tcsetattr(fd, termios.TCSADRAIN, saved)


def main(argv):
    if "--list" in argv:
        layouts.print_layouts()
        return 0
    if "--apply" in argv:
        idx = argv.index("--apply")
        name = argv[idx + 1] if idx + 1 < len(argv) else None
        if name not in layouts.LAYOUTS:
            print(f"unknown layout '{name}' (try --list)", file=sys.stderr)
            return 2
        count = DEFAULT_COUNT
        if "--count" in argv:
            count = int(argv[argv.index("--count") + 1])
        sock_path = os.environ.get("HERDR_SOCKET_PATH")
        if not sock_path:
            print("HERDR_SOCKET_PATH is not set", file=sys.stderr)
            return 2
        apply_layout(name, count, sock_path)
        return 0

    # Default: interactive menu.
    if not sys.stdin.isatty():
        print("picker needs an interactive terminal (run it in the popup pane)", file=sys.stderr)
        return 2
    sock_path = os.environ.get("HERDR_SOCKET_PATH")
    if not sock_path:
        print("HERDR_SOCKET_PATH is not set", file=sys.stderr)
        return 2
    try:
        return run_menu(sock_path)
    except (KeyboardInterrupt, EOFError):
        return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
