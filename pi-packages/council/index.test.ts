import { expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import councilExtension from "./index.ts";

test("registers a human-only council command and no model-callable tool", () => {
  const commands: string[] = [];
  const shortcuts: string[] = [];
  let tools = 0;
  const api = {
    registerCommand(name: string) {
      commands.push(name);
    },
    registerTool() {
      tools++;
    },
    registerShortcut(name: string) {
      shortcuts.push(name);
    },
  } as unknown as ExtensionAPI;

  councilExtension(api);

  expect(commands).toEqual(["council-cancel", "council"]);
  expect(shortcuts).toEqual(["ctrl+shift+x"]);
  expect(tools).toBe(0);
});
