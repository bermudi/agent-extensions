import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { DaemonHarness } from "../helpers.js";
import net from "net";

describe("concurrency and edge cases", () => {
  const h = new DaemonHarness();

  beforeAll(async () => {
    await h.start();
  });

  afterAll(async () => {
    await h.stop();
  });

  test("multiple sessions simultaneously", async () => {
    const shells = await Promise.all(
      ["s1", "s2", "s3", "s4", "s5"].map((name) => h.spawnShell(name)),
    );
    shells.forEach((r) => expect(r.ok).toBe(true));

    const list = await h.cmd("list-sessions");
    expect(list.ok).toBe(true);
    expect(list.sessions).toHaveLength(5);

    await Promise.all(
      ["s1", "s2", "s3", "s4", "s5"].map((name) => h.cmd("kill", { name })),
    );
  });

  test("independent session state", async () => {
    await h.spawnShell("ind-a");
    await h.spawnShell("ind-b");

    await h.cmd("type", { name: "ind-a", text: "echo ALPHA" });
    await h.cmd("key", { name: "ind-a", key: "enter" });
    await h.cmd("type", { name: "ind-b", text: "echo BETA" });
    await h.cmd("key", { name: "ind-b", key: "enter" });

    // Wait for output to appear
    await h.cmd("wait-for", { name: "ind-a", pattern: "ALPHA", timeout: 3000 });
    await h.cmd("wait-for", { name: "ind-b", pattern: "BETA", timeout: 3000 });

    const snapA = await h.cmd("snapshot", { name: "ind-a" });
    const snapB = await h.cmd("snapshot", { name: "ind-b" });

    expect(snapA.text).toContain("ALPHA");
    expect(snapA.text).not.toContain("BETA");
    expect(snapB.text).toContain("BETA");
    expect(snapB.text).not.toContain("ALPHA");

    await h.cmd("kill", { name: "ind-a" });
    await h.cmd("kill", { name: "ind-b" });
  });

  test("rapid-fire commands", async () => {
    await h.spawnShell("rapid");

    const last = "LINE49";
    const promises: Promise<unknown>[] = [];
    for (let i = 0; i < 50; i++) {
      promises.push(
        h.cmd("type", { name: "rapid", text: `echo LINE${i}\n` }),
      );
    }
    await Promise.all(promises);

    await h.cmd("wait-for", { name: "rapid", pattern: last, timeout: 5000 });
    const snap = await h.cmd("snapshot", { name: "rapid" });

    expect(snap.ok).toBe(true);
    expect(snap.text).toContain("LINE49");

    await h.cmd("kill", { name: "rapid" });
  });

  test("concurrent wait-for on different sessions", async () => {
    await h.spawnShell("wait-a");
    await h.spawnShell("wait-b");

    const pA = h.cmd("wait-for", {
      name: "wait-a",
      pattern: "HELLO",
      timeout: 5000,
    });
    const pB = h.cmd("wait-for", {
      name: "wait-b",
      pattern: "WORLD",
      timeout: 5000,
    });

    // Give the wait-fors time to register before typing
    await new Promise((r) => setTimeout(r, 100));

    await h.cmd("type", { name: "wait-a", text: "echo HELLO" });
    await h.cmd("key", { name: "wait-a", key: "enter" });
    await h.cmd("type", { name: "wait-b", text: "echo WORLD" });
    await h.cmd("key", { name: "wait-b", key: "enter" });

    const [rA, rB] = await Promise.all([pA, pB]);
    expect(rA.ok).toBe(true);
    expect(rA.matched).toBe(true);
    expect(rB.ok).toBe(true);
    expect(rB.matched).toBe(true);

    await h.cmd("kill", { name: "wait-a" });
    await h.cmd("kill", { name: "wait-b" });
  });

  test("unknown command", async () => {
    const res = await h.cmd("fly-to-moon");
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/unknown command/);
  });

  test("unknown key", async () => {
    await h.spawnShell("unk-key");
    const res = await h.cmd("key", { name: "unk-key", key: "explode" });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/unknown key/);
    await h.cmd("kill", { name: "unk-key" });
  });

  test("type on non-existent session", async () => {
    const res = await h.cmd("type", { name: "ghost", text: "hi" });
    expect(res.ok).toBe(false);
  });

  test("client disconnect during wait-for", async () => {
    // Open raw socket, send wait-for, immediately close
    await new Promise<void>((resolve, reject) => {
      const client = net.createConnection(h.sockPath, () => {
        client.write(
          JSON.stringify({
            cmd: "wait-for",
            name: "nowhere",
            pattern: "NEVER",
            timeout: 30000,
          }) + "\n",
        );
        client.end();
      });
      client.on("close", () => resolve());
      client.on("error", reject);
    });

    // Daemon should still be alive
    const list = await h.cmd("list-sessions");
    expect(list.ok).toBe(true);
  });
});
