"""Regression tests for the pure logic in reload_pi.py.

Run from this directory:  uv run -m unittest test_reload_pi -v
"""

import contextlib
import importlib.util
import io
import json
import os
import pathlib
import tempfile
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location(
    "reload_pi", pathlib.Path(__file__).with_name("reload_pi.py")
)
reload_pi = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reload_pi)

R = "─" * 60  # a real full-width editor border


def snap(*lines):
    return "\n".join(lines)


class EditorHasTextTests(unittest.TestCase):
    def test_idle_empty_editor(self):
        self.assertIs(reload_pi.editor_has_text(snap("banner", "", R, "", R, "~/proj (main)", "stats")), False)

    def test_idle_draft(self):
        self.assertIs(reload_pi.editor_has_text(snap("banner", "", R, "hello world", R, "stats")), True)

    def test_working_empty_editor(self):
        text = snap("transcript", " ⠦ Working (14s)...", "", R, "", R, "stats")
        self.assertIs(reload_pi.editor_has_text(text), False)

    def test_working_typed_ahead(self):
        text = snap("transcript", "", R, "typed ahead while working", R, "stats")
        self.assertIs(reload_pi.editor_has_text(text), True)

    def test_multi_line_draft(self):
        text = snap(R, "line one", "line two", "", "line four", R, "stats")
        self.assertIs(reload_pi.editor_has_text(text), True)

    def test_queued_message_renders_outside_editor(self):
        text = snap(" ⠦ Working...", "", R, "", R, "stats")
        self.assertIs(reload_pi.editor_has_text(text), False)

    def test_markdown_rule_in_transcript_is_not_the_anchor(self):
        text = snap("para", R, "more text", "", R, "", R, "stats")
        self.assertIs(reload_pi.editor_has_text(text), False)

    def test_scrolled_editor_indicator_is_not_a_rule(self):
        text = snap("─ 3 more ─", "", R, "", R, "stats")
        self.assertIs(reload_pi.editor_has_text(text), False)

    def test_short_rule_inside_draft_does_not_defeat_the_guard(self):
        # A pasted divider narrower than the pane must not become the
        # anchor: the draft below it must still be detected.
        text = snap(R, "pasted text", "─" * 5, " ", R, "stats")
        self.assertIs(reload_pi.editor_has_text(text), True)

    def test_draft_whose_tail_is_a_full_width_rule_is_undetectable(self):
        # Residual limitation, pinned on purpose: a full-width rule inside
        # the draft is indistinguishable from the editor's top border.
        # The guard fails OPEN here (would send); documented in the source.
        text = snap(R, "pasted text", R, " ", R, "stats")
        self.assertIs(reload_pi.editor_has_text(text), False)

    def test_adjacent_rules_are_unparseable(self):
        # An empty editor always renders its blank cursor line between the
        # borders; adjacent rules mean we don't understand the layout.
        self.assertIs(reload_pi.editor_has_text(snap(R, "intro", R, R, "stats")), None)

    def test_no_rules(self):
        self.assertIs(reload_pi.editor_has_text("just text\nmore text"), None)

    def test_one_rule(self):
        self.assertIs(reload_pi.editor_has_text(snap(R, "stuff")), None)

    def test_blank_snapshot(self):
        self.assertIs(reload_pi.editor_has_text(""), None)

    def test_narrow_rules_below_width_floor_are_unparseable(self):
        # min_width floors at 10; an 8-wide pane's borders can't qualify.
        self.assertIs(reload_pi.editor_has_text(snap("─" * 8, "", "─" * 8, "stats")), None)


class HerdrBinTests(unittest.TestCase):
    def setUp(self):
        self._orig = reload_pi._BIN_WARNED
        reload_pi._BIN_WARNED = False

    def tearDown(self):
        reload_pi._BIN_WARNED = self._orig

    def make_executable(self):
        f = tempfile.NamedTemporaryFile(suffix="-herdr", delete=False)
        f.close()
        os.chmod(f.name, 0o755)
        return f.name

    def test_valid_env_path_wins(self):
        exe = self.make_executable()
        try:
            with mock.patch.dict(os.environ, {"HERDR_BIN_PATH": exe}):
                self.assertEqual(reload_pi.herdr_bin(), exe)
        finally:
            os.unlink(exe)

    def test_deleted_binary_falls_back_to_path(self):
        with mock.patch.dict(os.environ, {"HERDR_BIN_PATH": "/gone/herdr (deleted)"}):
            self.assertEqual(reload_pi.herdr_bin(), "herdr")

    def test_missing_file_falls_back_to_path(self):
        with mock.patch.dict(os.environ, {"HERDR_BIN_PATH": "/nonexistent/herdr"}):
            self.assertEqual(reload_pi.herdr_bin(), "herdr")

    def test_unset_env_uses_path(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertEqual(reload_pi.herdr_bin(), "herdr")

    def test_fallback_warns_once(self):
        err = io.StringIO()
        with mock.patch.dict(os.environ, {"HERDR_BIN_PATH": "/gone/herdr (deleted)"}):
            with contextlib.redirect_stderr(err):
                reload_pi.herdr_bin()
                reload_pi.herdr_bin()
        self.assertEqual(err.getvalue().count("HERDR_BIN_PATH"), 1)


class ClassifyTests(unittest.TestCase):
    def test_idle_and_done_are_sent(self):
        self.assertEqual(reload_pi.classify("idle"), ("reload", None))
        self.assertEqual(reload_pi.classify("done"), ("reload", None))

    def test_working_is_skipped(self):
        action, reason = reload_pi.classify("working")
        self.assertEqual(action, "skip")
        self.assertIn("rerun when idle", reason)

    def test_blocked_is_never_sent(self):
        action, _ = reload_pi.classify("blocked")
        self.assertEqual(action, "skip")

    def test_unknown_is_never_sent(self):
        action, _ = reload_pi.classify("something-else")
        self.assertEqual(action, "skip")


class MainFlowTests(unittest.TestCase):
    """End-to-end through main() with a scripted herdr CLI."""

    def setUp(self):
        self._orig = reload_pi.run_cli

    def tearDown(self):
        reload_pi.run_cli = self._orig

    @staticmethod
    def scripted(list_status, calls):
        def run_cli(args, timeout=None):
            calls.append(args)
            if args[:2] == ["agent", "list"]:
                payload = {
                    "result": {
                        "agents": [
                            {
                                "agent": "pi",
                                "pane_id": "p1",
                                "cwd": "/x/proj",
                                "agent_status": list_status,
                                "workspace_id": "w1",
                                "tab_id": "t1",
                            }
                        ]
                    }
                }
                return 0, json.dumps(payload), ""
            if args[:2] == ["agent", "read"]:
                # valid empty-editor snapshot: two border rules, blank line between
                return 0, f"banner\n\n{R}\n\n{R}\nstats\n", ""
            if args[:2] == ["agent", "get"]:
                return 0, json.dumps({"result": {"agent": {"agent_status": "idle"}}}), ""
            return 0, "", ""  # notification show

        return run_cli

    def run_main(self, argv):
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            code = reload_pi.main(argv)
        return code, buf.getvalue()

    def test_busy_pane_is_skipped_without_waiting(self):
        calls = []
        reload_pi.run_cli = self.scripted("working", calls)
        code, out = self.run_main([])
        self.assertEqual(code, 1)  # nothing reloaded
        self.assertFalse(any(a[:2] == ["agent", "wait"] for a in calls))
        self.assertFalse(any(a[:2] == ["agent", "prompt"] for a in calls))
        self.assertFalse(any(a[:2] == ["agent", "read"] for a in calls))  # skipped before any checks
        self.assertIn("rerun when idle", out)
        self.assertIn("1 busy", out)

    def test_dry_run_reports_busy_as_skip(self):
        calls = []
        reload_pi.run_cli = self.scripted("working", calls)
        code, out = self.run_main(["--dry-run"])
        self.assertEqual(code, 1)  # nothing would be sent
        self.assertIn("skipped", out)
        self.assertIn("would send /reload to 0 of 1", out)
        self.assertFalse(any(a[:2] == ["agent", "wait"] for a in calls))

    def test_idle_pane_reloads(self):
        calls = []
        reload_pi.run_cli = self.scripted("idle", calls)
        code, out = self.run_main([])
        self.assertEqual(code, 0)
        self.assertIn("reloaded", out)
        self.assertTrue(any(a[:2] == ["agent", "read"] for a in calls))
        self.assertTrue(any(a[:2] == ["agent", "prompt"] for a in calls))


class BuildToastTests(unittest.TestCase):
    def test_no_agents(self):
        self.assertEqual(reload_pi.build_toast("sent 0/3", []), "sent 0/3")

    def test_names_fit(self):
        agents = [{"cwd": "/x/alpha"}, {"cwd": "/x/beta"}]
        body = reload_pi.build_toast("sent 2/2 pi instances", agents)
        self.assertEqual(body, "sent 2/2 pi instances · alpha, beta")

    def test_names_truncate_with_ellipsis_and_respect_cap(self):
        agents = [{"cwd": f"/x/{'a' * 100}{i}"} for i in range(6)]
        body = reload_pi.build_toast("sent 6/6 pi instances", agents)
        self.assertLessEqual(len(body), reload_pi.TOAST_BODY_MAX)
        self.assertIn("…", body)

    def test_extreme_case_still_returns_summary(self):
        agents = [{"cwd": f"/x/{'a' * 300}"}]
        body = reload_pi.build_toast("sent 1/1", agents)
        self.assertEqual(body, "sent 1/1")


class NaturalKeyTests(unittest.TestCase):
    def test_w10_sorts_after_w9(self):
        rows = [{"workspace_id": "w10", "pane_id": "p1"}, {"workspace_id": "w9", "pane_id": "p2"}]
        ordered = sorted(rows, key=lambda r: reload_pi.natural_key(r["workspace_id"]))
        self.assertEqual([r["workspace_id"] for r in ordered], ["w9", "w10"])


if __name__ == "__main__":
    unittest.main()
