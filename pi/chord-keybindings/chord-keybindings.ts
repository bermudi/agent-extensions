import { type ExtensionAPI, type ExtensionContext, CustomEditor, type KeybindingsManager } from "@mariozechner/pi-coding-agent";
import { type EditorTheme, Key, matchesKey, truncateToWidth, type TUI, visibleWidth } from "@mariozechner/pi-tui";

type ChordAction = "model" | "resume" | "new" | "ext" | "reload" | "compact" | "queue" | "search";

const CHORDS: { key: string; label: string; desc: string; action: ChordAction }[] = [
	{ key: "M", label: "Model", desc: "Switch model", action: "model" },
	{ key: "L", label: "Load", desc: "Resume session", action: "resume" },
	{ key: "N", label: "New", desc: "New session", action: "new" },
	{ key: "E", label: "Ext", desc: "Extensions", action: "ext" },
	{ key: "R", label: "Reload", desc: "Reload config", action: "reload" },
	{ key: "C", label: "Compact", desc: "Compact context", action: "compact" },
	{ key: "Q", label: "Queue", desc: "Queue follow-up", action: "queue" },
	{ key: "S", label: "Search", desc: "Search sessions", action: "search" },
];

// Padding: 1 row top/bottom, 2 cols left/right
const PAD_X = 4;
const PAD_Y = 1;
const CONTENT_WIDTH = Math.max(...CHORDS.map((c) => visibleWidth(`${c.key}  ${c.desc}`))) + 2;
const BOX_WIDTH = CONTENT_WIDTH + 2 + PAD_X * 2; // 2 border + side padding
const BOX_HEIGHT = CHORDS.length + 2 + PAD_Y * 2; // 2 border rows + top/bottom padding

class ChordEditor extends CustomEditor {
	private ctx: ExtensionContext;

	constructor(
		tui: TUI,
		theme: EditorTheme,
		keybindings: KeybindingsManager,
		ctx: ExtensionContext,
	) {
		super(tui, theme, keybindings);
		this.ctx = ctx;
	}

	private trigger(action: "app.model.select" | "app.session.resume" | "app.session.new"): void {
		this.actionHandlers.get(action)?.();
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.ctrl("x"))) {
			this.showChordOverlay();
			return;
		}
		super.handleInput(data);
	}

	private showChordOverlay(): void {
		const editor = this;

		this.ctx.ui.custom<ChordAction | null>((_tui, theme, _kb, done) => {
			const innerWidth = BOX_WIDTH - 2; // inside borders
			const emptyRow = theme.fg("border", "│") + " ".repeat(innerWidth) + theme.fg("border", "│");

			return {
				render(_width: number): string[] {
					const lines: string[] = [];

					// Top border with title
					const title = " C-x ";
					const titlePad = BOX_WIDTH - 2 - visibleWidth(title);
					const leftPad = Math.floor(titlePad / 2);
					const rightPad = titlePad - leftPad;
					lines.push(
						theme.fg("border", "╭" + "─".repeat(leftPad) + title + "─".repeat(rightPad) + "╮"),
					);

					// Top padding
					for (let i = 0; i < PAD_Y; i++) lines.push(emptyRow);

					// Chord rows
					for (const chord of CHORDS) {
						const keyStr = theme.fg("accent", theme.bold(`${chord.key}`));
						const descStr = theme.fg("muted", `  ${chord.desc}`);
						const contentVisible = visibleWidth(chord.key) + visibleWidth(`  ${chord.desc}`);
						const padLen = innerWidth - PAD_X * 2 - contentVisible;
						const row = theme.fg("border", "│") + " ".repeat(PAD_X) + keyStr + descStr + " ".repeat(Math.max(0, padLen)) + " ".repeat(PAD_X) + theme.fg("border", "│");
						lines.push(truncateToWidth(row, BOX_WIDTH));
					}

					// Bottom padding
					for (let i = 0; i < PAD_Y; i++) lines.push(emptyRow);

					// Bottom border
					lines.push(theme.fg("border", "╰" + "─".repeat(BOX_WIDTH - 2) + "╯"));

					return lines;
				},

				handleInput(data: string): void {
					if (
						matchesKey(data, Key.escape) ||
						matchesKey(data, Key.ctrl("g")) ||
						matchesKey(data, Key.ctrl("c"))
					) {
						done(null);
						return;
					}

					const key = data.length === 1 ? data.toLowerCase() : "";
					const chord = CHORDS.find((c) => c.key.toLowerCase() === key);
					if (chord) {
						done(chord.action);
						return;
					}

					// Unknown key cancels
					done(null);
				},

				invalidate(): void {},
			};
		}, {
			overlay: true,
			overlayOptions: {
				anchor: "center",
				width: BOX_WIDTH,
				maxHeight: BOX_HEIGHT,
				margin: 1,
			},
		}).then((action) => {
			if (!action) return;
			if (action === "model") editor.trigger("app.model.select");
			else if (action === "resume") editor.trigger("app.session.resume");
			else if (action === "new") editor.trigger("app.session.new");
			else if (action === "ext") {
				editor.setText("/ext");
				editor.onSubmit?.("/ext");
			} else if (action === "reload") {
				editor.setText("/reload");
				editor.onSubmit?.("/reload");
			} else if (action === "compact") {
				editor.setText("/compact");
				editor.onSubmit?.("/compact");
			} else if (action === "queue") {
				const text = editor.getText().trim();
				if (text) {
					editor.setText(`/queue ${text}`);
					editor.onSubmit?.(`/queue ${text}`);
				}
			} else if (action === "search") {
				editor.setText("/search");
				editor.onSubmit?.("/search");
			}
		});
	}
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		ctx.ui.setEditorComponent(
			(tui, theme, keybindings) => new ChordEditor(tui, theme, keybindings, ctx),
		);
	});
}
