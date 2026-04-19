/**
 * Pi Notify Extension
 *
 * Sends a native desktop notification when Pi finishes and is waiting for input.
 *
 * Detection order:
 * 1. WSL (Windows Terminal) → PowerShell toast
 * 2. macOS → osascript (works in any terminal)
 * 3. Linux with notify-send → libnotify desktop notification
 * 4. Kitty → OSC 99
 * 5. Fallback → BEL character (\x07) for terminals with bell.command configured
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { execFile } from "node:child_process";
import { platform } from "node:os";

function notifyOSC99(title: string, body: string): void {
	process.stdout.write(`\x1b]99;i=1:d=1:p=${title};${body}\x1b\\`);
}

function notifyMacOS(title: string, body: string): void {
	execFile("osascript", [
		"-e",
		`display notification "${body}" with title "${title}"`,
	]);
}

function notifyWindows(title: string, body: string): void {
	const type = "Windows.UI.Notifications";
	const mgr = `[${type}.ToastNotificationManager, ${type}, ContentType = WindowsRuntime]`;
	const template = `[${type}.ToastTemplateType]::ToastText01`;
	const toast = `[${type}.ToastNotification]::new($xml)`;
	const script = [
		`${mgr} > $null`,
		`$xml = [${type}.ToastNotificationManager]::GetTemplateContent(${template})`,
		`$xml.GetElementsByTagName('text')[0].AppendChild($xml.CreateTextNode('${body}')) > $null`,
		`[${type}.ToastNotificationManager]::CreateToastNotifier('${title}').Show(${toast})`,
	].join("; ");

	execFile("powershell.exe", ["-NoProfile", "-Command", script], (err) => {
		if (err) fallback();
	});
}

function notifyLibnotify(title: string, body: string): void {
	execFile("notify-send", [title, body], (err) => {
		if (err) fallback();
	});
}

function fallback(): void {
	process.stdout.write("\x07");
}

function notify(title: string, body: string): void {
	if (process.env.WT_SESSION) {
		notifyWindows(title, body);
	} else if (platform() === "darwin") {
		notifyMacOS(title, body);
	} else if (process.env.KITTY_WINDOW_ID) {
		notifyOSC99(title, body);
	} else {
		// Linux with any terminal — try libnotify first, BEL as last resort
		notifyLibnotify(title, body);
	}
}

export default function (pi: ExtensionAPI) {
	pi.on("agent_end", async () => {
		notify("Pi", "Ready for input");
	});
}
