/**
 * /z — Open Zed editor on cwd.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";

export default function (pi: ExtensionAPI) {
  // Arch packages the CLI as "zeditor"
  const zedBin = process.platform === "linux" ? "zeditor" : "zed";

  pi.registerCommand("z", {
    description: "Open Zed editor on cwd (new window)",
    handler: async (_args, ctx) => {
      const child = spawn(zedBin, ["--new", ctx.cwd], {
        detached: true,
        stdio: "ignore",
      });
      child.on("error", (err) => {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
          ctx.ui.notify(
            `Zed not found: \`${zedBin}\` is not installed or not on PATH`,
            "error",
          );
        } else {
          ctx.ui.notify(`Failed to open Zed: ${err.message}`, "error");
        }
      });
      // Only announce once the process has actually started — spawn()'s
      // 'error' event fires asynchronously, so notifying synchronously would
      // show "Opening Zed" before a missing-binary error lands.
      child.on("spawn", () => {
        ctx.ui.notify(`Opening Zed: ${ctx.cwd}`, "info");
      });
      child.unref();
    },
  });
}
