/**
 * /z — Open Zed editor on cwd.
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { spawn } from "node:child_process";

export default function (pi: ExtensionAPI) {
	// Arch packages the CLI as "zeditor"
	const zedBin = process.platform === "linux" ? "zeditor" : "zed";

	pi.registerCommand("z", {
		description: "Open Zed editor on cwd",
		handler: async (_args, ctx) => {
			const child = spawn(zedBin, [ctx.cwd], {
				detached: true,
				stdio: "ignore",
			});
			child.unref();
			ctx.ui.notify(`Opening Zed: ${ctx.cwd}`, "info");
		},
	});
}
