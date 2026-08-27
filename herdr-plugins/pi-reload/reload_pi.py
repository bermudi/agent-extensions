#!/usr/bin/env python3
"""Send /reload to the pi coding agents in this Herdr session.

Invoked by Herdr as the plugin action `pi.reload.reload-all`, or by hand:

    python3 reload_pi.py [--dry-run]

How it works
------------
1. `herdr agent list` finds every live agent in the session; entries whose
   kind is `pi` are pi coding-agent instances.
2. pi reports its own lifecycle state to Herdr through the `herdr:pi`
   extension hook, so `agent_status` is authoritative:
       idle / done  -> editor is free: /reload takes effect immediately
       working      -> sent anyway: pi refuses mid-turn with a warning
                       ("Wait for the current response to finish before
                       reloading.") and drops the text; rerun when idle
       blocked      -> pi is showing an approval/question dialog; Enter
                       would CONFIRM the highlighted dialog option, so
                       these panes are never typed into; skipped
       unknown      -> state hook not authoritative, a dialog cannot be
                       ruled out; skipped
3. Before typing anywhere, each candidate's input box is checked via
   `herdr agent read --source detection` (the bottom-of-screen snapshot):
   pi renders the editor between the last two border rules, so any
   non-blank content there means a draft is sitting in the input box.
   Typing `/reload` would append to that draft and Enter would submit it,
   so those panes are skipped. If the region can't be parsed at all
   (alternate-screen app, odd layout), the pane is skipped too — when in
   doubt, don't type.
4. Each remaining target gets `herdr agent prompt <pane> "/reload"`, which
   types the command into pi's editor and presses Enter.
5. A per-pane report goes to stdout (captured in `herdr plugin log`) and a
   summary toast is raised via `herdr notification show`.

Exit codes: 0 = at least one /reload sent (or would be, with --dry-run),
1 = nothing sent (no pi instances, or every candidate was skipped) or an
operational failure, 2 = usage error.
"""

import argparse
import json
import os
import subprocess
import sys

PROMPT_TIMEOUT = 30  # seconds per herdr CLI call
TOAST_BODY_MAX = 240  # herdr truncates notification bodies to 240 chars


def herdr_bin():
    """Plugins should call Herdr through HERDR_BIN_PATH; fall back to PATH."""
    return os.environ.get("HERDR_BIN_PATH") or "herdr"


def run_cli(args):
    """Run a herdr CLI command, returning (returncode, stdout, stderr)."""
    try:
        proc = subprocess.run(
            [herdr_bin(), *args],
            capture_output=True,
            text=True,
            timeout=PROMPT_TIMEOUT,
        )
    except FileNotFoundError:
        raise RuntimeError(f"herdr CLI not found ({herdr_bin()!r}); is Herdr installed?")
    except subprocess.TimeoutExpired:
        raise RuntimeError(f"herdr {' '.join(args[:2])} timed out after {PROMPT_TIMEOUT}s")
    return proc.returncode, proc.stdout, proc.stderr


def list_pi_agents():
    """Return the live pi agents: [{pane_id, cwd, status, workspace_id, tab_id}]."""
    rc, stdout, stderr = run_cli(["agent", "list"])
    if rc != 0:
        raise RuntimeError(f"herdr agent list failed (exit {rc}): {stderr.strip() or stdout.strip()}")
    try:
        payload = json.loads(stdout)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"herdr agent list returned invalid JSON: {exc}")
    agents = (payload.get("result") or {}).get("agents") or []
    pi_agents = []
    for agent in agents:
        if agent.get("agent") != "pi":
            continue
        pi_agents.append(
            {
                "pane_id": agent.get("pane_id") or "?",
                "cwd": agent.get("cwd") or "",
                "status": agent.get("agent_status") or "unknown",
                "workspace_id": agent.get("workspace_id") or "?",
                "tab_id": agent.get("tab_id") or "?",
            }
        )
    return pi_agents


def classify(status):
    """Map a pi agent_status to an action: reload, or a skip reason."""
    if status in ("idle", "done"):
        return "reload", None
    if status == "working":
        # bermudi's call: send anyway. pi warns ("Wait for the current
        # response to finish before reloading.") and drops the text.
        return "reload", "mid-turn — pi will warn and drop it; rerun when idle"
    if status == "blocked":
        return "skip", "blocked — approval dialog open, not touched (Enter would confirm it)"
    return "skip", f"unknown state ({status}) — cannot rule out a dialog; not touched"


def is_border_rule(line):
    """pi draws rules as full-width box-drawing lines."""
    stripped = line.rstrip()
    return bool(stripped) and all(ch in "─━═" for ch in stripped)


def editor_has_text(detection_text):
    """Inspect a `agent read --source detection` snapshot for draft text.

    pi renders its input box between the last two border rules of the
    bottom region; queued messages, spinners, and warnings render outside
    that region (verified against idle/working/queued/warning states).
    Returns True (draft present), False (empty), or None (layout not
    parseable — caller should skip the pane).
    """
    lines = detection_text.splitlines()
    rules = [i for i, line in enumerate(lines) if is_border_rule(line)]
    if len(rules) < 2:
        return None
    top, bottom = rules[-2], rules[-1]
    region = lines[top + 1 : bottom]
    if not region:
        # Adjacent rules: an empty editor always renders its blank cursor
        # line between the borders, so this is something else (e.g. a
        # draft whose last line is itself a rule). Don't guess.
        return None
    return any(line.strip() for line in region)


def input_box_state(pane_id):
    """Read a pane's bottom region and classify its input box.
    Returns (has_text, detail) where has_text is True/False/None."""
    rc, stdout, stderr = run_cli(["agent", "read", pane_id, "--source", "detection", "--lines", "40"])
    if rc != 0:
        return None, (stderr.strip() or stdout.strip())[:120] or f"exit {rc}"
    return editor_has_text(stdout), None


def reload_one(pane_id):
    """Submit /reload to one pi instance. Returns (ok, detail)."""
    rc, stdout, stderr = run_cli(["agent", "prompt", pane_id, "/reload"])
    if rc != 0:
        detail = (stderr.strip() or stdout.strip())[:200]
        return False, detail or f"exit {rc}"
    return True, "sent"


def project_name(cwd):
    return os.path.basename(cwd.rstrip("/")) or cwd


def build_toast(summary, reloaded_agents):
    """Toast body: counts first, then reloaded project names if they fit."""
    parts = [summary]
    if reloaded_agents:
        names = sorted({project_name(a["cwd"]) for a in reloaded_agents})
        listing = ", ".join(names)
        base = f"{parts[0]}: "
        if len(base) + len(listing) <= TOAST_BODY_MAX:
            parts.append(listing)
        else:
            while names and len(base) + len(", ".join(names)) + 1 > TOAST_BODY_MAX:
                names.pop()
                listing = ", ".join(names) + ", …"
            if names:
                parts.append(listing)
    body = " · ".join(parts)
    return body[:TOAST_BODY_MAX]


def show_toast(title, body):
    rc, stdout, stderr = run_cli(["notification", "show", title, "--body", body])
    if rc != 0:
        print(f"warning: notification show failed (exit {rc}): {stderr.strip()}", file=sys.stderr)


def print_report(rows):
    """Per-pane lines, aligned, in workspace order for easy scanning."""
    labels = {
        "reload": "would send",  # classified, not yet sent (dry-run)
        "reloaded": "reloaded",
        "failed": "FAILED",
        "skip": "skipped",
    }
    width = max(len(r["pane_id"]) for r in rows) if rows else 0
    for row in sorted(rows, key=lambda r: (r["workspace_id"], r["pane_id"])):
        name = project_name(row["cwd"])
        label = labels.get(row["outcome"], row["outcome"])
        detail = row["detail"] or (f"(was {row['status']})" if row["outcome"] in ("reload", "reloaded") else "")
        print(f"  {label:<10}  {row['pane_id']:<{width}}  {name:<30} {detail}")


def main(argv=None):
    parser = argparse.ArgumentParser(
        prog="reload_pi.py",
        description="Send /reload to every idle pi instance in this Herdr session.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="show what would be sent, change nothing",
    )
    args = parser.parse_args(argv)

    try:
        agents = list_pi_agents()
    except RuntimeError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    if not agents:
        print("no pi instances found in this session")
        if not args.dry_run:
            show_toast("pi reload", "no pi instances found in this session")
        return 1

    rows = []
    for agent in agents:
        action, reason = classify(agent["status"])
        rows.append({**agent, "outcome": action, "detail": reason or ""})

    # Draft-text guard: typing into a pane whose input box already has
    # content would append to the draft and Enter would submit it.
    for row in rows:
        if row["outcome"] != "reload":
            continue
        has_text, err = input_box_state(row["pane_id"])
        if has_text is False:
            row["skip_kind"] = None
            continue
        row["outcome"] = "skip"
        row["skip_kind"] = "editor"
        row["detail"] = (
            "input box has text — not touched"
            if has_text
            else f"could not read input box ({err}) — not touched"
        )

    if args.dry_run:
        print(f"dry run — {len(agents)} pi instance(s) found:")
        print_report(rows)
        would_send = sum(1 for r in rows if r["outcome"] == "reload")
        print(f"would send /reload to {would_send} of {len(agents)}")
        return 0 if would_send else 1

    for row in rows:
        if row["outcome"] != "reload":
            continue
        ok, detail = reload_one(row["pane_id"])
        row["outcome"] = "reloaded" if ok else "failed"
        row["detail"] = detail

    print_report(rows)

    reloaded = [r for r in rows if r["outcome"] == "reloaded"]
    failed = [r for r in rows if r["outcome"] == "failed"]
    skipped = [r for r in rows if r["outcome"] == "skip"]
    editor_skips = [r for r in skipped if r.get("skip_kind") == "editor"]
    status_skips = [r for r in skipped if r.get("skip_kind") != "editor"]
    midturn = [r for r in reloaded if r["status"] == "working"]
    total = len(rows)

    summary = f"sent /reload to {len(reloaded)}/{total} pi instances"
    if midturn:
        summary += f", {len(midturn)} mid-turn (rerun when idle)"
    if editor_skips:
        summary += f", {len(editor_skips)} had draft text"
    if status_skips:
        summary += f", {len(status_skips)} blocked/unknown"
    if failed:
        summary += f", {len(failed)} failed"

    print(summary)
    show_toast("pi reload", build_toast(summary, reloaded))
    return 0 if reloaded else 1


if __name__ == "__main__":
    sys.exit(main())
