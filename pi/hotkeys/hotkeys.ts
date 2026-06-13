import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  type EditorTheme,
  truncateToWidth,
  visibleWidth,
} from "@mariozechner/pi-tui";

// ── Your favorite Pi hotkeys — customize this list ────────────────────────
const HOTKEYS: { key: string; desc: string }[] = [
  { key: "Esc", desc: "Cancel / abort agent" },
  { key: "Ctrl+C", desc: "Clear editor" },
  { key: "Ctrl+D", desc: "Exit (when editor empty)" },
  { key: "Ctrl+L", desc: "Switch model" },
  { key: "Ctrl+P", desc: "Toggle path / cycle model" },
  { key: "Ctrl+O", desc: "Expand / collapse tool output" },
  { key: "Ctrl+T", desc: "Toggle thinking display" },
  { key: "Shift+Tab", desc: "Cycle thinking level" },
  { key: "Alt+Enter", desc: "Queue follow-up message" },
  { key: "Ctrl+G", desc: "Open in external editor" },
  { key: "Ctrl+V", desc: "Paste image from clipboard" },
  { key: "Ctrl+Z", desc: "Suspend to background" },
  { key: "Ctrl+R", desc: "Rename session" },
  { key: "Ctrl+N", desc: "Toggle named-only filter" },
  { key: "Ctrl+S", desc: "Toggle session sort" },
];
// ──────────────────────────────────────────────────────────────────────────

const PAD_X = 2;
const PAD_Y = 1;
const KEY_WIDTH = Math.max(...HOTKEYS.map((h) => visibleWidth(h.key))) + 3;
const BOX_WIDTH =
  KEY_WIDTH +
  Math.max(...HOTKEYS.map((h) => visibleWidth(h.desc))) +
  2 +
  PAD_X * 2;
const BOX_HEIGHT = HOTKEYS.length + 2 + PAD_Y * 2; // borders + padding

function renderOverlay(theme: EditorTheme): string[] {
  const inner = BOX_WIDTH - 2;
  const empty =
    theme.fg("border", "│") + " ".repeat(inner) + theme.fg("border", "│");
  const lines: string[] = [];

  // Top border ─────────────────────────────────────────────────────────
  const title = " Pi Hotkeys ";
  const pad = inner - visibleWidth(title);
  const left = Math.floor(pad / 2);
  lines.push(
    theme.fg(
      "border",
      "╭" + "─".repeat(left) + title + "─".repeat(pad - left) + "╮",
    ),
  );

  for (let i = 0; i < PAD_Y; i++) lines.push(empty);

  for (const { key, desc } of HOTKEYS) {
    const styledKey = theme.fg("accent", theme.bold(key));
    const gap = KEY_WIDTH - visibleWidth(key);
    const row =
      theme.fg("border", "│") +
      " ".repeat(PAD_X) +
      styledKey +
      " ".repeat(gap) +
      theme.fg("muted", desc) +
      " ".repeat(PAD_X) +
      theme.fg("border", "│");
    lines.push(truncateToWidth(row, BOX_WIDTH));
  }

  for (let i = 0; i < PAD_Y; i++) lines.push(empty);

  // Bottom border with dismiss hint ────────────────────────────────────
  const hint = " press any key to close ";
  const hintPad = inner - visibleWidth(hint);
  const hintLeft = Math.floor(hintPad / 2);
  lines.push(
    theme.fg(
      "border",
      "╰" +
        "─".repeat(hintLeft) +
        theme.fg("dim", hint) +
        "─".repeat(hintPad - hintLeft) +
        "╯",
    ),
  );

  return lines;
}

export default function (pi: ExtensionAPI) {
  pi.registerShortcut("ctrl+\\", {
    description: "Show Pi hotkeys cheat sheet",
    handler: async (ctx) => {
      if (!ctx.hasUI) return;

      await ctx.ui.custom<null>(
        (_tui, theme, _kb, done) => ({
          render: () => renderOverlay(theme),
          handleInput: () => done(null),
          invalidate() {},
        }),
        {
          overlay: true,
          overlayOptions: {
            anchor: "center",
            width: BOX_WIDTH,
            maxHeight: BOX_HEIGHT,
            margin: 1,
          },
        },
      );
    },
  });
}
