#!/usr/bin/env python3
"""Tests for copy_pane_context.py's pure context/clipboard selection logic."""

import importlib.util
import pathlib
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location(
    "copy_pane_context", pathlib.Path(__file__).with_name("copy_pane_context.py")
)
assert spec is not None and spec.loader is not None
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class PayloadTests(unittest.TestCase):
    def test_payload_preserves_requested_order(self):
        env = {
            "HERDR_WORKSPACE_ID": "w1",
            "HERDR_TAB_ID": "w1:t1",
            "HERDR_SOCKET_PATH": "/tmp/herdr.sock",
            "HERDR_PANE_ID": "w1:p1",
        }
        self.assertEqual(
            module.payload(env),
            "HERDR_PANE_ID=w1:p1\n"
            "HERDR_SOCKET_PATH=/tmp/herdr.sock\n"
            "HERDR_TAB_ID=w1:t1\n"
            "HERDR_WORKSPACE_ID=w1",
        )

    def test_payload_requires_every_key(self):
        env = {
            "HERDR_PANE_ID": "w1:p1",
            "HERDR_SOCKET_PATH": "/tmp/herdr.sock",
            "HERDR_TAB_ID": "w1:t1",
        }
        with self.assertRaisesRegex(module.ContextError, "HERDR_WORKSPACE_ID"):
            module.payload(env)


class ClipboardCommandTests(unittest.TestCase):
    def test_wayland_prefers_wl_copy(self):
        env = {"WAYLAND_DISPLAY": "wayland-0", "DISPLAY": ":0"}
        with mock.patch.dict(module.os.environ, env, clear=True), mock.patch.object(
            module.sys, "platform", "linux"
        ):
            self.assertEqual(next(module.clipboard_commands())[0], ("wl-copy",))

    def test_x11_uses_xclip_before_xsel(self):
        env = {"DISPLAY": ":0"}
        with mock.patch.dict(module.os.environ, env, clear=True), mock.patch.object(
            module.sys, "platform", "linux"
        ):
            commands = [command for command, _ in module.clipboard_commands()]
        self.assertEqual(
            commands[:2],
            [("xclip", "-selection", "clipboard"), ("xsel", "--clipboard", "--input")],
        )

    def test_copy_reports_selected_command(self):
        def fake_feed(args, data, timeout=10):
            self.assertEqual(args[0], "wl-copy")
            self.assertIn(b"HERDR_PANE_ID=w1:p1", data)
            return 0

        with mock.patch.object(
            module, "clipboard_commands", return_value=[(("wl-copy",), lambda: True)]
        ), mock.patch.object(module, "feed_stdin", side_effect=fake_feed):
            self.assertEqual(module.copy_to_clipboard("HERDR_PANE_ID=w1:p1"), "wl-copy")

    def test_copy_tries_next_tool_on_failure(self):
        calls = []

        def fake_feed(args, data, timeout=10):
            calls.append(args[0])
            return 0 if args[0] == "xclip" else 1

        commands = [(("wl-copy",), lambda: True), (("xclip",), lambda: True)]
        with mock.patch.object(
            module, "clipboard_commands", return_value=commands
        ), mock.patch.object(module, "feed_stdin", side_effect=fake_feed):
            self.assertEqual(module.copy_to_clipboard("x"), "xclip")
        self.assertEqual(calls, ["wl-copy", "xclip"])


if __name__ == "__main__":
    unittest.main()
