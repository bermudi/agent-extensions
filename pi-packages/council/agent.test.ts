import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { EvidenceStore } from "./agent.ts";

const schema = Type.Object({ path: Type.String() });

function fakeTool(): AgentTool<typeof schema, { ok: true }> {
  return {
    name: "read",
    label: "Read",
    description: "fake read",
    parameters: schema,
    execute: async (_id, params) => ({
      content: [{ type: "text", text: `contents of ${params.path}` }],
      details: { ok: true },
    }),
  };
}

describe("EvidenceStore", () => {
  test("assigns mechanical IDs and exposes them to the model", async () => {
    const root = await mkdtemp(join(tmpdir(), "council-evidence-"));
    await writeFile(join(root, "inside.txt"), "hello");
    const persisted: string[] = [];
    const store = new EvidenceStore(root, async (record) => {
      persisted.push(record.id);
    });
    const wrapped = store.wrap("Member 1", "read", fakeTool());

    const result = await wrapped.execute("call-1", { path: "inside.txt" });

    expect(result.content[0]).toEqual({
      type: "text",
      text: "Evidence ID: E1",
    });
    expect(store.records[0]?.output).toContain("inside.txt");
    expect(persisted).toEqual(["E1"]);
  });

  test("rejects parent paths and symlink escapes", async () => {
    const parent = await mkdtemp(join(tmpdir(), "council-boundary-"));
    const root = join(parent, "repo");
    await mkdir(root);
    await writeFile(join(parent, "secret.txt"), "not for council");
    await symlink(join(parent, "secret.txt"), join(root, "escape.txt"));
    const store = new EvidenceStore(root, async () => {});
    const wrapped = store.wrap("Member 1", "read", fakeTool());

    await expect(
      wrapped.execute("call-1", { path: "../secret.txt" }),
    ).rejects.toThrow("outside repository");
    await expect(
      wrapped.execute("call-2", { path: "escape.txt" }),
    ).rejects.toThrow("outside repository");
    expect(store.records.every((record) => record.error)).toBe(true);
  });

  test("rejects invented and failed evidence references", async () => {
    const root = await mkdtemp(join(tmpdir(), "council-reference-"));
    const store = new EvidenceStore(root, async () => {});
    expect(() => store.assertValidReferences({ evidence: ["E99"] })).toThrow(
      "nonexistent or failed",
    );
  });
});
