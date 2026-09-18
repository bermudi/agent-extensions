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
       working      -> pi refuses /reload mid-turn ("Wait for the
                       current response to finish before reloading.")
                       and drops the text; skipped — rerun when idle
       blocked      -> pi is showing an approval/question dialog; Enter
                       would CONFIRM the highlighted dialog option, so
                       these panes are never typed into; skipped
       unknown      -> state hook not authoritative, a dialog cannot be
                       ruled out; skipped
3. Before typing anywhere, each candidate's input box is checked via
   `herdr agent read --source detection` (the bottom-of-screen snapshot):
   pi renders the editor between the last two full-width border rules, so
   any non-blank content there means a draft is sitting in the input box.
   Typing `/reload` would append to that draft and Enter would submit it,
   so those panes are skipped. If the region can't be parsed at all
   (alternate-screen app, odd layout), the pane is skipped too — when in
   doubt, don't type.
4. Immediately before sending, the pane's status is re-checked
   (`herdr agent get`): the listing is seconds stale by then, and a pane
   that was `working` can be sitting at a fresh approval dialog — exactly
   the pane Enter must never touch. A residual millisecond-level race
   remains (state can change between re-check and keystrokes); herdr has
   no guarded prompt to close it fully.
5. Each remaining target gets `herdr agent prompt <pane> "/reload"`, which
   types the command into pi's editor and presses Enter.
6. A per-pane report goes to stdout (captured in `herdr plugin log`) and a
   summary toast is raised via `herdr notification show`.

Exit codes: 0 = every targeted pane reloaded with no failures,
1 = any send failure, nothing sent (no pi instances or everything
skipped), or an operational failure, 2 = usage error.
"""

import argparse
import json
import os
import re
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor

PROMPT_TIMEOUT = 30  # seconds per herdr CLI call
TOAST_BODY_MAX = 240  # herdr truncates notification bodies to 240 chars

_BIN_WARNED = False  # warn once per run about a stale HERDR_BIN_PATH


def herdr_bin():
    """Plugins should call Herdr through HERDR_BIN_PATH; fall back to PATH.

    The env var is exported by the RUNNING server and points at its own
    binary. After `herdr update` that file is gone, and the server (read
    from /proc/self/exe) exports "<path> (deleted)" — so verify before
    trusting it, and warn (lands in the plugin log) when falling back.
    """
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
            "falling back to 'herdr' on PATH (restart the herdr server to refresh it)",
            file=sys.stderr,
        )
    return "herdr"


def run_cli(args, timeout=PROMPT_TIMEOUT):
    """Run a herdr CLI command, returning (returncode, stdout, stderr)."""
    try:
        proc = subprocess.run(
            [herdr_bin(), *args],
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except FileNotFoundError:
        raise RuntimeError(f"herdr CLI not found ({herdr_bin()!r}); is Herdr installed?")
    except subprocess.TimeoutExpired:
        raise RuntimeError(f"herdr {' '.join(args[:2])} timed out after {timeout}s")
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
        return "skip", "busy (mid-turn) — pi would drop /reload; rerun when idle"
    if status == "blocked":
        return "skip", "blocked — approval dialog open, not touched (Enter would confirm it)"
    return "skip", f"unknown state ({status}) — cannot rule out a dialog; not touched"


def is_border_rule(line, min_width):
    """pi draws editor borders as (near-)full-width box-drawing lines.

    The width check keeps box-drawing lines INSIDE a draft (pasted
    dividers, table rules) from being mistaken for editor borders.
    """
    stripped = line.rstrip()
    return len(stripped) >= min_width and all(ch in "─━═" for ch in stripped)


def editor_has_text(detection_text):
    """Inspect a `agent read --source detection` snapshot for draft text.

    pi renders its input box between the last two border rules of the
    bottom region; queued messages, spinners, and warnings render outside
    that region (verified against idle/working/queued/warning states).
    Returns True (draft present), False (empty), or None (layout not
    parseable — caller should skip the pane).

    Fragile assumption: nothing may render a full-width box-drawing rule
    between the editor's top and bottom borders (a below-editor widget
    would shift the anchor and permanently false-skip the pane —
    fail-closed, but worth knowing). A draft whose visible tail is itself
    a full-width rule is likewise undetectable from text alone.
    """
    lines = detection_text.splitlines()
    widths = [len(ln.rstrip()) for ln in lines if ln.strip()]
    if not widths:
        return None
    min_width = max(10, int(max(widths) * 0.9))
    rules = [i for i, line in enumerate(lines) if is_border_rule(line, min_width)]
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


def current_status(pane_id):
    """Re-read an agent's status right before typing (the listing is stale
    by then). Returns (status, error_detail)."""
    rc, stdout, stderr = run_cli(["agent", "get", pane_id])
    if rc != 0:
        return None, (stderr.strip() or stdout.strip())[:120] or f"exit {rc}"
    try:
        agent = json.loads(stdout).get("result", {}).get("agent", {})
    except json.JSONDecodeError:
        return None, "invalid JSON from agent get"
    status = agent.get("agent_status")
    if not status:
        return None, "no agent_status in response"
    return status, None


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
    if not reloaded_agents:
        return summary[:TOAST_BODY_MAX]
    names = sorted({project_name(a["cwd"]) for a in reloaded_agents})
    suffix = ""
    while names:
        candidate = f"{summary} · {', '.join(names)}{suffix}"
        if len(candidate) <= TOAST_BODY_MAX:
            return candidate
        if suffix:
            names.pop()
        else:
            suffix = ", …"
    return summary[:TOAST_BODY_MAX]


def show_toast(title, body):
    try:
        rc, stdout, stderr = run_cli(["notification", "show", title, "--body", body])
    except RuntimeError as exc:
        print(f"warning: notification show failed: {exc}", file=sys.stderr)
        return
    if rc != 0:
        print(f"warning: notification show failed (exit {rc}): {stderr.strip()}", file=sys.stderr)


def natural_key(value):
    """Sort w9 after w10: split digit runs into integers."""
    return [int(part) if part.isdigit() else part for part in re.split(r"(\d+)", value)]


def print_report(rows):
    """Per-pane lines, aligned, in workspace order for easy scanning."""
    labels = {
        "reload": "would send",  # classified, not yet sent (dry-run)
        "reloaded": "reloaded",
        "failed": "FAILED",
        "skip": "skipped",
    }
    width = max(len(r["pane_id"]) for r in rows) if rows else 0
    for row in sorted(rows, key=lambda r: (natural_key(r["workspace_id"]), natural_key(r["pane_id"]))):
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
        row = {**agent, "outcome": action, "detail": reason or ""}
        if action == "skip":
            row["skip_kind"] = "busy" if agent["status"] == "working" else "status"
        rows.append(row)

    # Per-pane work (draft guard -> status re-check -> prompt) runs
    # in a thread pool: each pane keeps its own strict ordering, while the
    # panes run concurrently. Two reasons this matters:
    # - herdr's `agent prompt` deliberately sleeps ~300ms between typing the
    #   text and pressing Enter (paste-boundary guard, see herdr's
    #   AGENT_PROMPT_SUBMIT_DELAY); serially that is 0.3s x N panes before
    #   the last /reload lands. Concurrently it's ~0.3s total.
    # - checks run as close to their own prompt as possible; a check done
    #   up front for all panes would be seconds stale by the time the last
    #   pane is reached.
    def process_row(row):
        # Draft guard: typing into a pane whose input box has content
        # would append to the draft and Enter would submit it.
        try:
            has_text, err = input_box_state(row["pane_id"])
        except RuntimeError as exc:
            has_text, err = None, str(exc)
        if has_text is not False:
            row["outcome"] = "skip"
            # Confirmed drafts and unreadable panes are reported separately:
            # the toast must not count a parse failure as "draft text".
            row["skip_kind"] = "editor" if has_text else "editor-unreadable"
            reason = (
                "input box has text"
                if has_text
                else f"could not read input box ({err or 'empty/unparseable snapshot'})"
            )
            row["detail"] = f"{reason} — not touched"
            return
        # TOCTOU guard: the listing status is stale, and a pane that was
        # `working` can be sitting at a fresh approval dialog now — exactly
        # the pane Enter must never touch.
        try:
            status, err = current_status(row["pane_id"])
        except RuntimeError as exc:
            status, err = None, str(exc)
        if status not in ("idle", "done"):
            row["outcome"] = "skip"
            row["skip_kind"] = "busy" if status == "working" else "status"
            if status == "working":
                # Turn started in the gap between the listing and the send.
                row["detail"] = "busy before the send — rerun when idle"
            else:
                shown = status or "unreadable"
                row["detail"] = f"status now {shown}" + (f" ({err})" if err else "") + " — not touched"
            return
        if args.dry_run:
            return  # checks passed; would send
        try:
            ok, detail = reload_one(row["pane_id"])
        except RuntimeError as exc:
            ok, detail = False, str(exc)
        if ok:
            row["outcome"] = "reloaded"  # keep the classify detail (mid-turn note)
        else:
            row["outcome"] = "failed"
            row["detail"] = detail

    targets = [row for row in rows if row["outcome"] == "reload"]
    if targets:
        with ThreadPoolExecutor(max_workers=min(8, len(targets))) as pool:
            for _ in pool.map(process_row, targets):
                pass

    if args.dry_run:
        print(f"dry run — {len(agents)} pi instance(s) found:")
        print_report(rows)
        would_send = sum(1 for r in rows if r["outcome"] == "reload")
        print(f"would send /reload to {would_send} of {len(agents)}")
        return 0 if would_send else 1

    print_report(rows)

    reloaded = [r for r in rows if r["outcome"] == "reloaded"]
    failed = [r for r in rows if r["outcome"] == "failed"]
    skipped = [r for r in rows if r["outcome"] == "skip"]
    editor_skips = [r for r in skipped if r.get("skip_kind") == "editor"]
    unreadable = [r for r in skipped if r.get("skip_kind") == "editor-unreadable"]
    busy_skips = [r for r in skipped if r.get("skip_kind") == "busy"]
    status_skips = [r for r in skipped if r.get("skip_kind") == "status"]
    total = len(rows)

    summary = f"sent /reload to {len(reloaded)}/{total} pi instances"
    if busy_skips:
        summary += f", {len(busy_skips)} busy"
    if editor_skips:
        summary += f", {len(editor_skips)} had draft text"
    if unreadable:
        summary += f", {len(unreadable)} unreadable"
    if status_skips:
        summary += f", {len(status_skips)} blocked/unknown"
    if failed:
        summary += f", {len(failed)} failed"

    print(summary)
    show_toast("pi reload", build_toast(summary, reloaded))
    # 0 only for complete success: every targeted pane reloaded, no send
    # failures. Partial failure or nothing-sent is nonzero so whatever
    # invokes the action can tell the difference.
    return 0 if reloaded and not failed else 1


if __name__ == "__main__":
    sys.exit(main())
