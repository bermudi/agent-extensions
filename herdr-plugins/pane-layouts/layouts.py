#!/usr/bin/env python3
"""Apply common pane layouts to a Herdr tab.

Invoked by Herdr as a plugin action (one action per preset), or by hand:

    HERDR_SOCKET_PATH=... python3 layouts.py columns --count 2

The script talks Herdr's newline-delimited JSON socket API (the same protocol
the CLI client uses) and calls `layout.apply` with a binary split tree. Each
layout is built from two primitives:

  * `pane`   — a leaf node (spawns the default shell unless `command` is set)
  * `split`  — a binary node: `direction` is "right" (side-by-side, first on the
               left) or "down" (stacked, first on top); `ratio` is the share of
               the area given to the *first* child, clamped to [0.1, 0.9] by
               Herdr, so values outside that range are snapped to the edge.

By default the layout is applied to a NEW tab in the active workspace, so
existing panes and running processes are never disturbed. Pass `--replace` to
reshape the current tab instead (note: replace closes the tab's existing panes).

Useful offline modes (no socket needed):
    python3 layouts.py --list           list the available layouts
    python3 layouts.py quad --dry-run   print the tree that would be applied
    python3 layouts.py --selftest       build every preset and check limits
"""

import argparse
import json
import os
import socket
import sys

# Herdr clamps split ratios into this range (see src/layout.rs::valid_split_ratio).
RATIO_MIN, RATIO_MAX = 0.1, 0.9
# Hard limits enforced by layout.apply (see src/app/api/layouts.rs).
MAX_PANES = 24
MAX_DEPTH = 16


# --- tree primitives ---------------------------------------------------------

def pane(**extra):
    """A leaf pane. Extra keys (label, cwd, command, env) are forwarded as-is."""
    node = {"type": "pane"}
    node.update(extra)
    return node


def split(direction, ratio, first, second):
    """A binary split. `ratio` is the first child's share, clamped to the
    Herdr-legal range so the printed tree matches what the server enforces."""
    ratio = max(RATIO_MIN, min(RATIO_MAX, float(ratio)))
    return {
        "type": "split",
        "direction": direction,
        "ratio": round(ratio, 4),
        "first": first,
        "second": second,
    }


def line(count, direction):
    """`count` evenly-divided panes along `direction` ("right" = columns,
    "down" = rows).

    Built right-to-left so each split hands its single leading pane exactly
    1/k of the remaining area, which makes every pane end up equal-sized:
    for 3 columns the outer split is 1/3, the inner 1/2 (of the 2/3 tail)."""
    count = max(1, int(count))
    if count == 1:
        return pane()
    node = pane()  # rightmost / bottom pane
    for remaining in range(2, count + 1):
        node = split(direction, 1.0 / remaining, pane(), node)
    return node


def quad():
    """A 2x2 grid."""
    return split("down", 0.5, line(2, "right"), line(2, "right"))


def main_left(count, main_ratio):
    """One large pane on the left, `count` stacked panes on the right."""
    return split("right", main_ratio, pane(), line(count, "down"))


def main_right(count, main_ratio):
    """`count` stacked panes on the left, one large pane on the right."""
    return split("right", 1.0 - main_ratio, line(count, "down"), pane())


def main_top(count, main_ratio):
    """One large pane on top, `count` side-by-side panes below."""
    return split("down", main_ratio, pane(), line(count, "right"))


def main_bottom(count, main_ratio):
    """`count` side-by-side panes on top, one large pane on the bottom."""
    return split("down", 1.0 - main_ratio, line(count, "right"), pane())


# name -> (builder(count, main_ratio), accepts_count, description)
LAYOUTS = {
    "columns": (lambda c, r: line(c, "right"), True, "N panes side by side"),
    "rows": (lambda c, r: line(c, "down"), True, "N panes stacked vertically"),
    "quad": (lambda c, r: quad(), False, "2x2 grid"),
    "main-left": (lambda c, r: main_left(c, r), True, "large pane left + N stacked right"),
    "main-right": (lambda c, r: main_right(c, r), True, "N stacked left + large pane right"),
    "main-top": (lambda c, r: main_top(c, r), True, "large pane top + N below"),
    "main-bottom": (lambda c, r: main_bottom(c, r), True, "N above + large pane bottom"),
}


def build(name, count, main_ratio):
    builder = LAYOUTS[name][0]
    return builder(count, main_ratio)


def label_for(name, count):
    """Human label used as the new tab's name."""
    if name == "quad":
        return "2x2 grid"
    if name in ("columns", "rows"):
        noun = "columns" if name == "columns" else "rows"
        return f"{count} {noun}"
    side = name.split("-", 1)[1]
    return f"main-{side} + {count}"


# --- tree utilities ----------------------------------------------------------

def count_panes(node):
    if node["type"] == "pane":
        return 1
    return count_panes(node["first"]) + count_panes(node["second"])


def max_depth(node):
    if node["type"] == "pane":
        return 1
    return 1 + max(max_depth(node["first"]), max_depth(node["second"]))


def walk_panes(node):
    if node["type"] == "pane":
        yield node
    else:
        yield from walk_panes(node["first"])
        yield from walk_panes(node["second"])


def set_cwd(node, cwd):
    """Set `cwd` on every leaf pane (used by --cwd)."""
    for leaf in walk_panes(node):
        leaf["cwd"] = cwd


# --- herdr transport ---------------------------------------------------------

def rpc(sock_path, method, params):
    request = json.dumps({"id": "pane-layouts", "method": method, "params": params}) + "\n"
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
        client.connect(sock_path)
        client.sendall(request.encode())
        buf = b""
        while b"\n" not in buf:
            chunk = client.recv(65536)
            if not chunk:
                break
            buf += chunk
    if not buf:
        raise RuntimeError(f"{method}: empty response from Herdr")
    reply = json.loads(buf.split(b"\n", 1)[0])
    if "error" in reply:
        raise RuntimeError(f"{method}: " + json.dumps(reply["error"]))
    return reply.get("result")


def apply_params(name, count, main_ratio, *, replace, cwd):
    """Build the layout.apply request params for the given preset."""
    tree = build(name, count, main_ratio)
    if cwd:
        set_cwd(tree, cwd)

    params = {"root": tree, "focus": True}

    # Default: a fresh tab. --replace reshapes the current tab in place.
    want_replace = replace or os.environ.get("HERDR_LAYOUT_REPLACE") == "1"
    tab_id = os.environ.get("HERDR_TAB_ID") if want_replace else None
    if want_replace and not tab_id:
        print(
            "--replace requested but HERDR_TAB_ID is unset; creating a new tab instead",
            file=sys.stderr,
        )
        tab_id = None

    if tab_id:
        params["tab_id"] = tab_id  # replaces the tab (preserves its label)
    else:
        params["tab_label"] = label_for(name, count)  # names the new tab
    return params


# --- cli ---------------------------------------------------------------------

def parse_args(argv):
    p = argparse.ArgumentParser(
        prog="layouts.py",
        description="Apply a common pane layout to a Herdr tab.",
        epilog="Offline: --list, --dry-run, and --selftest need no Herdr socket.",
    )
    p.add_argument("name", nargs="?", help="layout preset (see --list)")
    p.add_argument("--count", type=int, default=2, help="pane count for layouts that use it")
    p.add_argument(
        "--main-ratio",
        type=float,
        default=0.6,
        help="share of area for the main pane in main-* layouts (default 0.6)",
    )
    p.add_argument("--cwd", help="open every pane in this directory")
    p.add_argument("--replace", action="store_true", help="replace the current tab instead of a new tab")
    p.add_argument("--dry-run", action="store_true", help="print the request, do not send it")
    p.add_argument("--list", action="store_true", help="list available layouts and exit")
    p.add_argument("--selftest", action="store_true", help="build every preset and verify limits")
    return p.parse_args(argv)


def print_layouts():
    print("available layouts:")
    width = max(len(name) for name in LAYOUTS)
    for name, (_builder, accepts_count, desc) in LAYOUTS.items():
        suffix = " [--count N]" if accepts_count else ""
        print(f"  {name:<{width}}{suffix}  {desc}")


def run_selftest():
    """Build every preset at a few counts and assert Herdr's limits hold."""
    failures = 0
    cases = []
    for name in LAYOUTS:
        accepts_count = LAYOUTS[name][1]
        counts = [1, 2, 3, 4, 6] if accepts_count else [1]
        for count in counts:
            cases.append((name, count))
    print(f"checking {len(cases)} layout cases...")
    for name, count in cases:
        try:
            tree = build(name, count, 0.6)
        except Exception as exc:  # noqa: BLE001 - surface any builder failure
            print(f"  FAIL {name} x{count}: builder raised {exc}")
            failures += 1
            continue
        panes = count_panes(tree)
        depth = max_depth(tree)
        ok = panes <= MAX_PANES and depth <= MAX_DEPTH
        status = "ok  " if ok else "FAIL"
        print(f"  {status} {name:<12} x{count}: {panes} panes, depth {depth}")
        if not ok:
            failures += 1
    if failures:
        print(f"\n{failures} failure(s)")
        return 1
    print("\nall layouts within Herdr limits (<=24 panes, <=16 depth)")
    return 0


def main(argv=None):
    args = parse_args(argv or sys.argv[1:])

    if args.selftest:
        return run_selftest()
    if args.list or args.name is None:
        print_layouts()
        return 0
    if args.name not in LAYOUTS:
        print(f"unknown layout '{args.name}' (try --list)", file=sys.stderr)
        return 2

    main_ratio = max(RATIO_MIN, min(RATIO_MAX, args.main_ratio))
    params = apply_params(
        args.name,
        args.count,
        main_ratio,
        replace=args.replace,
        cwd=args.cwd,
    )

    if args.dry_run:
        print(json.dumps({"method": "layout.apply", "params": params}, indent=2))
        return 0

    sock_path = os.environ.get("HERDR_SOCKET_PATH")
    if not sock_path:
        print(
            "HERDR_SOCKET_PATH is not set; run this through a Herdr plugin action, "
            "or export it and retry. Use --dry-run to preview the tree.",
            file=sys.stderr,
        )
        return 2

    label = label_for(args.name, args.count)
    requested_tab = params.get("tab_id")
    result = rpc(sock_path, "layout.apply", params)
    layout = (result or {}).get("layout", {})
    result_tab = layout.get("tab_id", "?")
    applied_panes = count_panes(layout["root"]) if layout.get("root") else count_panes(params["root"])
    # Replace swaps in a fresh tab carrying a new id, so report both ids.
    if requested_tab:
        print(f"applied {label} ({applied_panes} panes): replaced {requested_tab} -> {result_tab}")
    else:
        print(f"applied {label} ({applied_panes} panes) to new tab {result_tab}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
