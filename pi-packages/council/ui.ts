import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  matchesKey,
  truncateToWidth,
  type Component,
} from "@earendil-works/pi-tui";

interface ActorState {
  phase: string;
  tail: string;
  status: "waiting" | "running" | "done" | "failed";
}

function clean(value: string): string {
  return value
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export class CouncilDashboard {
  private readonly actors = new Map<string, ActorState>();
  private lastRender = 0;

  constructor(
    private readonly ctx: ExtensionCommandContext,
    actorNames: string[],
  ) {
    for (const actor of actorNames) {
      this.actors.set(actor, {
        phase: "waiting",
        tail: "",
        status: "waiting",
      });
    }
    this.render(true);
  }

  update(
    actor: string,
    change: Partial<ActorState> & { delta?: string },
  ): void {
    const previous = this.actors.get(actor) ?? {
      phase: "waiting",
      tail: "",
      status: "waiting",
    };
    const tail = change.delta
      ? clean(`${previous.tail}${change.delta}`).slice(-180)
      : (change.tail ?? previous.tail);
    this.actors.set(actor, { ...previous, ...change, tail });
    this.render(change.status === "done" || change.status === "failed");
  }

  close(): void {
    this.ctx.ui.setWidget("council", undefined);
    this.ctx.ui.setStatus("council", undefined);
  }

  private render(force = false): void {
    const now = Date.now();
    if (!force && now - this.lastRender < 80) return;
    this.lastRender = now;
    const icons = {
      waiting: "○",
      running: "●",
      done: "✓",
      failed: "✗",
    } as const;
    const lines = ["Design council · Ctrl+Shift+X cancels"];
    for (const [actor, state] of this.actors) {
      const tail = state.tail ? ` — ${state.tail}` : "";
      lines.push(
        `${icons[state.status]} ${actor}: ${state.phase}${tail}`.slice(0, 220),
      );
    }
    this.ctx.ui.setWidget("council", lines);
    const running = [...this.actors.values()].filter(
      (actor) => actor.status === "running",
    ).length;
    this.ctx.ui.setStatus(
      "council",
      running > 0
        ? `Council: ${running} model${running === 1 ? "" : "s"} running`
        : "Council",
    );
  }
}

const START = Symbol("start");
const CANCEL = Symbol("cancel");
type MultiSelectRow = string | typeof START | typeof CANCEL;

export class ModelMultiSelect implements Component {
  private cursor = 0;
  private offset = 0;
  private readonly selected = new Set<string>();
  private readonly rows: MultiSelectRow[];

  constructor(
    private readonly models: string[],
    private readonly onChange: () => void,
    private readonly done: (result: string[] | null) => void,
    private readonly visibleRows = 12,
  ) {
    this.rows = [...models, START, CANCEL];
  }

  render(width: number): string[] {
    const end = Math.min(this.rows.length, this.offset + this.visibleRows);
    const lines = [
      "Council members — Enter/Space toggles; choose Start when ready",
      "",
    ];
    for (let index = this.offset; index < end; index++) {
      const row = this.rows[index]!;
      const focused = index === this.cursor ? "› " : "  ";
      let text: string;
      if (row === START) {
        text =
          this.selected.size >= 2
            ? `Start with ${this.selected.size} members`
            : `Start (select ${2 - this.selected.size} more)`;
      } else if (row === CANCEL) {
        text = "Cancel";
      } else {
        text = `${this.selected.has(row) ? "[x]" : "[ ]"} ${row}`;
      }
      lines.push(truncateToWidth(`${focused}${text}`, width));
    }
    if (this.rows.length > this.visibleRows) {
      lines.push(
        truncateToWidth(
          `  ${this.cursor + 1}/${this.rows.length} · ↑↓ move · Esc cancel`,
          width,
        ),
      );
    }
    return lines;
  }

  handleInput(data: string): void {
    if (matchesKey(data, "up")) {
      this.cursor = Math.max(0, this.cursor - 1);
      this.revealCursor();
      this.onChange();
      return;
    }
    if (matchesKey(data, "down")) {
      this.cursor = Math.min(this.rows.length - 1, this.cursor + 1);
      this.revealCursor();
      this.onChange();
      return;
    }
    if (matchesKey(data, "escape")) {
      this.done(null);
      return;
    }
    if (!matchesKey(data, "enter") && data !== " ") return;

    const row = this.rows[this.cursor];
    if (row === START) {
      if (this.selected.size >= 2) this.done([...this.selected]);
      return;
    }
    if (row === CANCEL) {
      this.done(null);
      return;
    }
    if (typeof row === "string") {
      if (this.selected.has(row)) this.selected.delete(row);
      else this.selected.add(row);
      this.onChange();
    }
  }

  invalidate(): void {}

  private revealCursor(): void {
    if (this.cursor < this.offset) this.offset = this.cursor;
    if (this.cursor >= this.offset + this.visibleRows) {
      this.offset = this.cursor - this.visibleRows + 1;
    }
  }
}

export function pickCouncilMembers(
  ctx: ExtensionCommandContext,
  models: string[],
): Promise<string[] | null> {
  return ctx.ui.custom<string[] | null>((tui, _theme, _keybindings, done) => {
    return new ModelMultiSelect(models, () => tui.requestRender(), done);
  });
}
