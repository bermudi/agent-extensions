import { describe, it, expect } from "bun:test";
import { buildCopyPayload } from "./copy-with-model.ts";

const text = (t: string) => [{ type: "text", text: t }];

const assistant = (overrides: Record<string, unknown> = {}) => ({
  type: "message",
  message: {
    role: "assistant",
    content: text("hello"),
    ...overrides,
  },
});

describe("buildCopyPayload", () => {
  it("prefers the model that actually ran (responseModel) over the requested one", () => {
    // Ask model A, provider reroutes to A-resolved: the fence must credit
    // what produced the text, not what was requested.
    expect(
      buildCopyPayload(
        [assistant({ model: "claude-opus-4-5", responseModel: "glm-5" })],
        undefined,
      )?.tag,
    ).toBe("glm-5");
  });

  it("falls back to the requested model when the provider echoes nothing", () => {
    expect(
      buildCopyPayload([assistant({ model: "claude-opus-4-5" })], undefined)
        ?.tag,
    ).toBe("claude-opus-4-5");
  });

  it("falls back to the active model only when the message carries none", () => {
    // The exact bug this fixes: the active model must not win over the
    // message's own model — only fill in when the message has neither.
    expect(
      buildCopyPayload([assistant()], { provider: "x", id: "active-model" })
        ?.tag,
    ).toBe("active-model");
    expect(
      buildCopyPayload([assistant({ model: "m-a" })], {
        provider: "x",
        id: "active-model",
      })?.tag,
    ).toBe("m-a");
  });

  it("returns undefined tag when neither message nor session has a model", () => {
    const payload = buildCopyPayload([assistant()], undefined);
    expect(payload?.text).toBe("hello");
    expect(payload?.tag).toBeUndefined();
  });

  it("ignores non-string junk in the model fields instead of crashing", () => {
    expect(
      buildCopyPayload([assistant({ model: 42, responseModel: null })], {
        provider: "x",
        id: "active",
      })?.tag,
    ).toBe("active");
  });

  it("returns the text of the last assistant message", () => {
    expect(
      buildCopyPayload(
        [
          assistant({ content: text("older") }),
          assistant({ content: text("newer") }),
        ],
        undefined,
      )?.text,
    ).toBe("newer");
  });

  it("skips aborted messages with no content", () => {
    expect(
      buildCopyPayload(
        [assistant({ stopReason: "aborted", content: [] }), assistant()],
        undefined,
      )?.text,
    ).toBe("hello");
  });

  it("returns undefined when the last assistant message has no text", () => {
    // A trailing text-less message keeps the historical behavior: no copy.
    expect(
      buildCopyPayload(
        [assistant({ content: [{ type: "thinking", thinking: "hmm" }] })],
        undefined,
      ),
    ).toBeUndefined();
  });

  it("returns undefined when there are no assistant messages", () => {
    expect(
      buildCopyPayload(
        [{ type: "message", message: { role: "user", content: text("hi") } }],
        undefined,
      ),
    ).toBeUndefined();
  });
});
