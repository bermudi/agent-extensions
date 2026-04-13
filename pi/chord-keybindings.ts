import { CustomEditor, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

class ChordEditor extends CustomEditor {
  private prefixActive = false;

  private trigger(action: "app.model.select" | "app.session.resume" | "app.session.new"): void {
    this.prefixActive = false;
    this.actionHandlers.get(action)?.();
  }

  handleInput(data: string): void {
    if (this.prefixActive) {
      if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("g")) || matchesKey(data, Key.ctrl("c"))) {
        this.prefixActive = false;
        return;
      }

      const key = data.length === 1 ? data.toLowerCase() : "";
      if (key === "m") {
        this.trigger("app.model.select");
        return;
      }
      if (key === "l") {
        this.trigger("app.session.resume");
        return;
      }
      if (key === "n") {
        this.trigger("app.session.new");
        return;
      }
      if (key === "e") {
        this.prefixActive = false;
        this.setText("/ext");
        this.onSubmit?.("/ext");
        return;
      }
      if (key === "r") {
        this.prefixActive = false;
        this.setText("/reload");
        this.onSubmit?.("/reload");
        return;
      }

      this.prefixActive = false;
      return;
    }

    if (matchesKey(data, Key.ctrl("x"))) {
      this.prefixActive = true;
      return;
    }

    super.handleInput(data);
  }

  render(width: number): string[] {
    const lines = super.render(width);
    if (!this.prefixActive || lines.length === 0) return lines;

    const label = " C-x (M/L/N/E/R) ";
    const last = lines.length - 1;
    if (visibleWidth(lines[last]!) >= label.length) {
      lines[last] = truncateToWidth(lines[last]!, width - label.length, "") + label;
    }
    return lines;
  }
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.hasUI) return;
    ctx.ui.setEditorComponent((tui, theme, keybindings) => new ChordEditor(tui, theme, keybindings));
  });


}
