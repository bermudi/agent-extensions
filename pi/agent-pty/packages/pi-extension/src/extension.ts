import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { ensureDaemon } from "@agent-pty/core";
import { setupPtyTools } from "./tools/pty.js";
import { setupPtyCommands } from "./commands/pty.js";

export default async function agentPtyExtension(pi: ExtensionAPI) {
  // Ensure the Unix-socket daemon is running before any PTY operations.
  // This also fires on extension reload via /reload.
  await ensureDaemon();

  pi.on("session_start", async () => {
    // Re-check daemon health on every new session start.
    await ensureDaemon();
  });

  // Register agent tools (LLM-callable)
  setupPtyTools(pi);

  // Register slash commands (user-callable)
  setupPtyCommands(pi);
}
