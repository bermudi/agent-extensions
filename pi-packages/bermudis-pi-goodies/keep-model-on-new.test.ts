import { describe, expect, test } from "bun:test";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import keepModelOnNew from "./keep-model-on-new.ts";

type Handler = (event: never, ctx: ExtensionContext) => unknown;

class PiHarness {
  readonly handlers = new Map<string, Handler>();
  readonly selected: { provider: string; id: string }[] = [];
  setModelResult = true;

  readonly api = {
    on: (event: string, handler: Handler) => {
      this.handlers.set(event, handler);
    },
    setModel: async (model: { provider: string; id: string }) => {
      this.selected.push(model);
      return this.setModelResult;
    },
  } as unknown as ExtensionAPI;

  async emit(
    event: string,
    payload: object,
    ctx: ExtensionContext,
  ): Promise<void> {
    await this.handlers.get(event)?.(payload as never, ctx);
  }
}

function context(
  model: { provider: string; id: string },
  sessionFile: string,
  available: { provider: string; id: string }[] = [model],
): ExtensionContext {
  return {
    cwd: "/project",
    model,
    sessionManager: {
      getSessionFile: () => sessionFile,
    },
    modelRegistry: {
      find: (provider: string, id: string) =>
        available.find(
          (candidate) => candidate.provider === provider && candidate.id === id,
        ),
    },
    ui: { notify() {} },
  } as unknown as ExtensionContext;
}

describe("keep-model-on-new", () => {
  test("carries the active model into the replacement extension instance", async () => {
    const handoffs = new Map();
    const oldPi = new PiHarness();
    keepModelOnNew(oldPi.api, { pendingModels: handoffs });
    await oldPi.emit(
      "session_before_switch",
      { reason: "new" },
      context({ provider: "zai", id: "glm-5.3" }, "/sessions/old.jsonl"),
    );

    const newPi = new PiHarness();
    keepModelOnNew(newPi.api, { pendingModels: handoffs });
    await newPi.emit(
      "session_start",
      { reason: "new", previousSessionFile: "/sessions/old.jsonl" },
      context(
        { provider: "openai-codex", id: "gpt-5.6-sol" },
        "/sessions/new.jsonl",
        [{ provider: "zai", id: "glm-5.3" }],
      ),
    );

    expect(newPi.selected).toEqual([{ provider: "zai", id: "glm-5.3" }]);
    expect(handoffs.size).toBe(0);
  });

  test("does nothing when Pi already selected the same model", async () => {
    const handoffs = new Map([
      ["/sessions/old.jsonl", { provider: "openai-codex", id: "gpt-5.6-sol" }],
    ]);
    const pi = new PiHarness();
    keepModelOnNew(pi.api, { pendingModels: handoffs });
    await pi.emit(
      "session_start",
      { reason: "new", previousSessionFile: "/sessions/old.jsonl" },
      context(
        { provider: "openai-codex", id: "gpt-5.6-sol" },
        "/sessions/new.jsonl",
      ),
    );

    expect(pi.selected).toEqual([]);
    expect(handoffs.size).toBe(0);
  });

  test("does not carry a model into resume", async () => {
    const handoffs = new Map();
    const pi = new PiHarness();
    keepModelOnNew(pi.api, { pendingModels: handoffs });
    await pi.emit(
      "session_before_switch",
      { reason: "resume" },
      context({ provider: "zai", id: "glm-5.3" }, "/sessions/old.jsonl"),
    );

    expect(handoffs.size).toBe(0);
  });

  test("warns when Pi refuses to restore an unauthenticated model", async () => {
    const handoffs = new Map([
      [
        "/sessions/old.jsonl",
        { provider: "openai-codex", id: "gpt-5.6-terra" },
      ],
    ]);
    const notifications: Array<{ message: string; level: string }> = [];
    const pi = new PiHarness();
    pi.setModelResult = false;
    keepModelOnNew(pi.api, { pendingModels: handoffs });
    const ctx = context(
      { provider: "kilo", id: "tencent/hy3:free" },
      "/sessions/new.jsonl",
      [{ provider: "openai-codex", id: "gpt-5.6-terra" }],
    );
    ctx.ui.notify = (message, level) => {
      notifications.push({ message, level });
    };

    await pi.emit(
      "session_start",
      { reason: "new", previousSessionFile: "/sessions/old.jsonl" },
      ctx,
    );

    expect(pi.selected).toEqual([
      { provider: "openai-codex", id: "gpt-5.6-terra" },
    ]);
    expect(notifications).toEqual([
      {
        message:
          "Could not keep model after /new: openai-codex/gpt-5.6-terra is not authenticated",
        level: "warning",
      },
    ]);
  });
});
