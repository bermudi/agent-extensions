import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

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
    const lines = ["Design council"];
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
