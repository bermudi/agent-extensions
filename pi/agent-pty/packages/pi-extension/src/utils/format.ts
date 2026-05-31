import type { Theme, ThemeColor } from "@mariozechner/pi-coding-agent";

export interface SessionListEntry {
  name: string;
  command: string;
  cwd: string;
  pid: number;
  createdAt: string;
  killedAt?: string;
}

export interface SessionStatus {
  status: "running" | "killed" | "exited";
  exitCode?: number;
  signal?: number;
}

function parseDate(s: string): number {
  return new Date(s).getTime();
}

export function formatRuntime(createdAt: string, killedAt?: string): string {
  const start = parseDate(createdAt);
  const end = killedAt ? parseDate(killedAt) : Date.now();
  const ms = end - start;
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  }
  return `${seconds}s`;
}

export function statusIcon(status: SessionStatus): string {
  switch (status.status) {
    case "running":
      return "●";
    case "exited":
      return status.exitCode === 0 ? "✓" : "✗";
    case "killed":
      return "✗";
    default:
      return "○";
  }
}

export function statusColor(status: SessionStatus): ThemeColor {
  switch (status.status) {
    case "running":
      return "success";
    case "exited":
      return status.exitCode === 0 ? "dim" : "error";
    case "killed":
      return "warning";
    default:
      return "dim";
  }
}

export function statusLabel(status: SessionStatus): string {
  switch (status.status) {
    case "running":
      return "running";
    case "exited":
      return status.exitCode === 0 ? "exited(0)" : `exited(${status.exitCode})`;
    case "killed":
      return status.signal ? `killed(${status.signal})` : "killed";
    default:
      return "unknown";
  }
}

export function formatSessionStatus(
  status: SessionStatus,
  theme: Theme,
): string {
  const icon = statusIcon(status);
  const label = statusLabel(status);
  const color = statusColor(status);
  return theme.fg(color, `${icon} ${label}`);
}

export function truncate(str: string, maxLen: number): string {
  if (maxLen <= 3) return str.slice(0, maxLen);
  if (str.length <= maxLen) return str;
  return `${str.slice(0, maxLen - 3)}...`;
}

export function deriveStatus(entry: SessionListEntry): SessionStatus {
  if (!entry.killedAt) {
    return { status: "running" };
  }
  // list-sessions doesn't include exitInfo; we only know it was killed.
  // Future: extend daemon protocol to include exitCode in list response.
  return { status: "killed" };
}

export function deriveStatusFromResult(
  res: Record<string, unknown>,
): SessionStatus {
  if (res.exited === true) {
    const exitCode =
      typeof res.exitCode === "number" ? res.exitCode : undefined;
    if (typeof res.signal === "number") {
      return { status: "killed", signal: res.signal };
    }
    return { status: "exited", exitCode };
  }
  if (res.killedAt) {
    return { status: "killed" };
  }
  return { status: "running" };
}
