/**
 * Command Center — Session dashboard with project-level token/cost tracking.
 *
 * /cc — Open the command center overlay
 *
 * Tabs:
 *   Dashboard  — total stats, top projects by token/cost
 *   Projects   — sortable table of all projects
 *   Sessions   — browse, read, resume, delete sessions
 */

import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { matchesKey, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import * as cp from "node:child_process";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

// ── Constants ─────────────────────────────────────────────────────────

const SESSIONS_DIR = path.join(os.homedir(), ".pi/agent/sessions");
const BOX_WIDTH = 84;

// ── Types ─────────────────────────────────────────────────────────────

interface UsageData {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: number;
}

interface SessionMeta {
  file: string;
  id: string;
  timestamp: string;
  cwd: string;
  firstUserMessage: string;
  name: string | null;
  messageCount: number;
  usage: UsageData;
}

interface ProjectStats {
  cwd: string;
  shortName: string;
  sessionCount: number;
  usage: UsageData;
  sessions: SessionMeta[];
}

interface DashboardData {
  sessions: SessionMeta[];
  projects: ProjectStats[];
  totalSessions: number;
  totalUsage: UsageData;
  scannedAt: number;
}

type Tab = "dashboard" | "projects" | "sessions";
type SortKey = "tokens" | "cost" | "sessions";
type SortDir = "asc" | "desc";

// ── Helpers ───────────────────────────────────────────────────────────

function zeroUsage(): UsageData {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 };
}

function addUsage(a: UsageData, b: UsageData): UsageData {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    totalTokens: a.totalTokens + b.totalTokens,
    cost: a.cost + b.cost,
  };
}

function fmtNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toFixed(0);
}

function fmtCost(n: number): string {
  return `$${n.toFixed(2)}`;
}

function fmtDate(ts: string): string {
  try {
    const d = new Date(ts);
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    const diffDays = Math.floor(diffMs / 86400000);
    const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
    if (diffDays === 0) return `Today ${time}`;
    if (diffDays === 1) return `Yesterday ${time}`;
    if (diffDays < 7) return `${diffDays}d ago ${time}`;
    return d.toLocaleDateString("en-GB", { month: "short", day: "numeric" }) + ` ${time}`;
  } catch {
    return ts.slice(0, 10);
  }
}

function shortProject(cwd: string, maxLen: number): string {
  const parts = cwd.replace(/\/+$/, "").split("/");
  const last = parts[parts.length - 1] ?? cwd;
  if (last.length <= maxLen) return last;
  if (parts.length >= 2) {
    const two = parts.slice(-2).join("/");
    if (two.length <= maxLen) return two;
  }
  return last.slice(0, maxLen);
}

function makeBox(innerW: number, theme: Theme) {
  function row(content = ""): string {
    const clipped = truncateToWidth(content, innerW - 1, "");
    const vis = visibleWidth(clipped);
    const padLen = Math.max(0, innerW - vis - 1);
    return theme.fg("borderAccent", "│") + " " + clipped + " ".repeat(padLen) + theme.fg("borderAccent", "│");
  }
  function emptyRow(): string {
    return theme.fg("borderAccent", "│") + " ".repeat(innerW) + theme.fg("borderAccent", "│");
  }
  function divider(): string {
    return theme.fg("borderAccent", `├${"─".repeat(innerW)}┤`);
  }
  function topBorder(title: string): string {
    const titleText = ` ${title} `;
    const borderLen = Math.max(0, innerW - titleText.length);
    const left = Math.floor(borderLen / 2);
    const right = borderLen - left;
    return (
      theme.fg("borderAccent", `╭${"─".repeat(left)}`) +
      theme.fg("accent", titleText) +
      theme.fg("borderAccent", `${"─".repeat(right)}╮`)
    );
  }
  function bottomBorder(): string {
    return theme.fg("borderAccent", `╰${"─".repeat(innerW)}╯`);
  }
  return { row, emptyRow, divider, topBorder, bottomBorder };
}

type Theme = Parameters<
  Parameters<ExtensionContext["ui"]["custom"]>[0]
>[1];

// ── Session Scanner ───────────────────────────────────────────────────

let cachedData: DashboardData | null = null;

async function scanAllSessions(): Promise<DashboardData> {
  const sessions: SessionMeta[] = [];
  const dirs = await fsp.readdir(SESSIONS_DIR).catch(() => [] as string[]);

  for (const dir of dirs) {
    const dirPath = path.join(SESSIONS_DIR, dir);
    let entries: string[];
    try {
      entries = await fsp.readdir(dirPath);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith(".jsonl")) continue;
      const filePath = path.join(dirPath, entry);
      try {
        const data = await fsp.readFile(filePath, "utf8");
        const lines = data.split("\n").filter((l) => l.trim());
        if (lines.length === 0) continue;

        // Parse header
        let header: { id: string; timestamp: string; cwd: string } | null = null;
        try {
          const h = JSON.parse(lines[0]);
          if (h?.type === "session" && h.id && h.timestamp) {
            header = { id: h.id, timestamp: h.timestamp, cwd: h.cwd || "" };
          }
        } catch { continue; }
        if (!header) continue;

        // Parse messages for usage and content
        let firstUserMsg = "";
        let name: string | null = null;
        let msgCount = 0;
        let usage = zeroUsage();

        for (const line of lines.slice(1)) {
          let entry: any;
          try { entry = JSON.parse(line); } catch { continue; }

          if (entry.type === "session_info" && entry.name) {
            name = entry.name;
          }

          if (entry.type !== "message") continue;
          const msg = entry.message;
          if (!msg) continue;

          msgCount++;

          if (msg.role === "user" && !firstUserMsg) {
            const text = typeof msg.content === "string"
              ? msg.content
              : Array.isArray(msg.content)
                ? msg.content.filter((b: any) => b?.type === "text").map((b: any) => b.text).join(" ")
                : "";
            firstUserMsg = text.slice(0, 200);
          }

          if (msg.role === "assistant" && msg.usage) {
            usage = addUsage(usage, {
              input: msg.usage.input || 0,
              output: msg.usage.output || 0,
              cacheRead: msg.usage.cacheRead || 0,
              cacheWrite: msg.usage.cacheWrite || 0,
              totalTokens: msg.usage.totalTokens || 0,
              cost: msg.usage.cost?.total || 0,
            });
          }
        }

        sessions.push({
          file: filePath,
          id: header.id,
          timestamp: header.timestamp,
          cwd: header.cwd,
          firstUserMessage: firstUserMsg,
          name,
          messageCount: msgCount,
          usage,
        });
      } catch {
        continue;
      }
    }
  }

  // Group by project (cwd)
  const projectMap = new Map<string, ProjectStats>();
  for (const s of sessions) {
    const key = s.cwd || "(unknown)";
    let proj = projectMap.get(key);
    if (!proj) {
      proj = {
        cwd: key,
        shortName: shortProject(key, 30),
        sessionCount: 0,
        usage: zeroUsage(),
        sessions: [],
      };
      projectMap.set(key, proj);
    }
    proj.sessionCount++;
    proj.usage = addUsage(proj.usage, s.usage);
    proj.sessions.push(s);
  }

  const projects = [...projectMap.values()];
  const totalUsage = sessions.reduce((acc, s) => addUsage(acc, s.usage), zeroUsage());

  return {
    sessions,
    projects,
    totalSessions: sessions.length,
    totalUsage,
    scannedAt: Date.now(),
  };
}

async function getDashboardData(force = false): Promise<DashboardData> {
  if (!cachedData || force) {
    cachedData = await scanAllSessions();
  }
  return cachedData;
}

// ── Delete Session ────────────────────────────────────────────────────

async function deleteSession(filePath: string): Promise<boolean> {
  try {
    // Try trash CLI first (safer), fall back to unlink
    try {
      cp.execSync(`trash ${JSON.stringify(filePath)}`, { stdio: "pipe" });
      cachedData = null;
      return true;
    } catch {
      // trash failed, fall through to unlink
    }
    // Fallback: direct delete
    await fsp.unlink(filePath);
    cachedData = null;
    return true;
  } catch {
    return false;
  }
}

// ── TUI Component ─────────────────────────────────────────────────────

type Action =
  | { type: "close" }
  | { type: "read"; session: SessionMeta }
  | { type: "resume"; session: SessionMeta }
  | { type: "delete"; session: SessionMeta }
  | { type: "switchTab"; tab: Tab }
  | { type: "sort"; key: SortKey };

class CommandCenterComponent {
  private tab: Tab = "dashboard";
  private data: DashboardData | null = null;
  private loading = true;

  // Projects tab state
  private projectSortKey: SortKey = "tokens";
  private projectSortDir: SortDir = "desc";
  private projectSelected = 0;

  // Sessions tab state
  private sessionFilter = "";
  private sessionFilterCursor = 0;
  private sessionSelected = 0;
  private deleting = false;

  constructor(
    private done: (action: Action) => void,
    private tui: { requestRender(): void },
    private theme: Theme,
  ) {
    void this.load();
  }

  private async load() {
    this.loading = true;
    this.tui.requestRender();
    this.data = await getDashboardData();
    this.loading = false;
    this.tui.requestRender();
  }

  render(_width: number): string[] {
    if (this.loading) {
      return this.renderLoading();
    }
    if (!this.data) {
      return this.renderError();
    }

    switch (this.tab) {
      case "dashboard": return this.renderDashboard();
      case "projects": return this.renderProjects();
      case "sessions": return this.renderSessions();
    }
  }

  invalidate() {
    // Force re-scan on theme change (unlikely but correct)
  }

  handleInput(data: string): void {
    // Global: tab switching with Tab / Shift+Tab
    if (matchesKey(data, "tab")) {
      const tabs: Tab[] = ["dashboard", "projects", "sessions"];
      const idx = tabs.indexOf(this.tab);
      this.tab = tabs[(idx + 1) % tabs.length];
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, "shift+tab")) {
      const tabs: Tab[] = ["dashboard", "projects", "sessions"];
      const idx = tabs.indexOf(this.tab);
      this.tab = tabs[(idx - 1 + tabs.length) % tabs.length];
      this.tui.requestRender();
      return;
    }

    // Escape: if in sessions with an active filter, clear filter first
    if (matchesKey(data, "escape")) {
      if (this.tab === "sessions" && this.sessionFilter) {
        this.sessionFilter = "";
        this.sessionFilterCursor = 0;
        this.sessionSelected = 0;
        this.tui.requestRender();
        return;
      }
      this.done({ type: "close" });
      return;
    }

    // Tab-specific
    switch (this.tab) {
      case "dashboard":
        this.handleDashboardInput(data);
        break;
      case "projects":
        this.handleProjectsInput(data);
        break;
      case "sessions":
        this.handleSessionsInput(data);
        break;
    }
  }

  private handleDashboardInput(data: string): void {
    // Arrow keys switch tabs visually via render, but enter on stats does nothing special
    if (matchesKey(data, "return") || matchesKey(data, "enter")) {
      this.tab = "projects";
      this.tui.requestRender();
    }
  }

  private handleProjectsInput(data: string): void {
    const projects = this.getSortedProjects();
    if (matchesKey(data, "up")) {
      this.projectSelected = Math.max(0, this.projectSelected - 1);
      this.tui.requestRender();
    } else if (matchesKey(data, "down")) {
      this.projectSelected = Math.min(projects.length - 1, this.projectSelected + 1);
      this.tui.requestRender();
    } else if (data === "t") {
      this.setProjectSort("tokens");
    } else if (data === "c") {
      this.setProjectSort("cost");
    } else if (data === "s") {
      this.setProjectSort("sessions");
    } else if (matchesKey(data, "return") || matchesKey(data, "enter")) {
      // Navigate to sessions filtered by this project
      const proj = projects[this.projectSelected];
      if (proj) {
        this.tab = "sessions";
        this.sessionFilter = proj.cwd;
        this.sessionFilterCursor = proj.cwd.length;
        this.sessionSelected = 0;
        this.tui.requestRender();
      }
    }
  }

  private setProjectSort(key: SortKey) {
    if (this.projectSortKey === key) {
      this.projectSortDir = this.projectSortDir === "desc" ? "asc" : "desc";
    } else {
      this.projectSortKey = key;
      this.projectSortDir = "desc";
    }
    this.projectSelected = 0;
    this.tui.requestRender();
  }

  private handleSessionsInput(data: string): void {
    const sessions = this.getFilteredSessions();
    if (this.deleting) {
      if (data === "y" || data === "Y") {
        const s = sessions[this.sessionSelected];
        if (s) {
          void deleteSession(s.file).then((ok) => {
            this.deleting = false;
            if (ok) {
              void this.load();
            }
            this.tui.requestRender();
          });
        }
        this.deleting = false;
        return;
      }
      this.deleting = false;
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, "up")) {
      this.sessionSelected = Math.max(0, this.sessionSelected - 1);
      this.tui.requestRender();
    } else if (matchesKey(data, "down")) {
      this.sessionSelected = Math.min(sessions.length - 1, this.sessionSelected + 1);
      this.tui.requestRender();
    } else if (matchesKey(data, "return") || matchesKey(data, "enter")) {
      const s = sessions[this.sessionSelected];
      if (s) this.done({ type: "read", session: s });
    } else if (data === "r") {
      const s = sessions[this.sessionSelected];
      if (s) this.done({ type: "resume", session: s });
    } else if (data === "d") {
      if (sessions.length > 0) this.deleting = true;
      this.tui.requestRender();
    } else if (data === "/") {
      this.sessionFilter = "";
      this.sessionFilterCursor = 0;
      this.sessionSelected = 0;
      this.tui.requestRender();
    } else if (matchesKey(data, "backspace")) {
      if (this.sessionFilterCursor > 0) {
        this.sessionFilter =
          this.sessionFilter.slice(0, this.sessionFilterCursor - 1) +
          this.sessionFilter.slice(this.sessionFilterCursor);
        this.sessionFilterCursor--;
        this.sessionSelected = 0;
        this.tui.requestRender();
      }
    } else if (matchesKey(data, "delete")) {
      if (this.sessionFilterCursor < this.sessionFilter.length) {
        this.sessionFilter =
          this.sessionFilter.slice(0, this.sessionFilterCursor) +
          this.sessionFilter.slice(this.sessionFilterCursor + 1);
        this.sessionSelected = 0;
        this.tui.requestRender();
      }
    } else if (matchesKey(data, "left")) {
      if (this.sessionFilterCursor > 0) {
        this.sessionFilterCursor--;
        this.tui.requestRender();
      }
    } else if (matchesKey(data, "right")) {
      if (this.sessionFilterCursor < this.sessionFilter.length) {
        this.sessionFilterCursor++;
        this.tui.requestRender();
      }
    } else if (matchesKey(data, "home") || matchesKey(data, "ctrl+a")) {
      this.sessionFilterCursor = 0;
      this.tui.requestRender();
    } else if (matchesKey(data, "end") || matchesKey(data, "ctrl+e")) {
      this.sessionFilterCursor = this.sessionFilter.length;
      this.tui.requestRender();
    } else if (data.length === 1 && data.charCodeAt(0) >= 32) {
      this.sessionFilter =
        this.sessionFilter.slice(0, this.sessionFilterCursor) +
        data +
        this.sessionFilter.slice(this.sessionFilterCursor);
      this.sessionFilterCursor += data.length;
      this.sessionSelected = 0;
      this.tui.requestRender();
    }
  }

  private getSortedProjects(): ProjectStats[] {
    if (!this.data) return [];
    const sorted = [...this.data.projects];
    const key = this.projectSortKey;
    const dir = this.projectSortDir === "desc" ? -1 : 1;
    sorted.sort((a, b) => {
      let cmp: number;
      if (key === "tokens") cmp = a.usage.totalTokens - b.usage.totalTokens;
      else if (key === "cost") cmp = a.usage.cost - b.usage.cost;
      else cmp = a.sessionCount - b.sessionCount;
      return cmp * dir;
    });
    return sorted;
  }

  private getFilteredSessions(): SessionMeta[] {
    if (!this.data) return [];
    let sessions = this.data.sessions;
    if (this.sessionFilter) {
      const f = this.sessionFilter.toLowerCase();
      sessions = sessions.filter((s) =>
        s.cwd.toLowerCase().includes(f) ||
        s.firstUserMessage.toLowerCase().includes(f) ||
        (s.name && s.name.toLowerCase().includes(f)) ||
        s.id.toLowerCase().includes(f),
      );
    }
    sessions.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
    return sessions;
  }

  // ── Render: Loading ──────────────────────────────────────────────────

  private renderLoading(): string[] {
    const { row, emptyRow, topBorder, bottomBorder, divider } = makeBox(BOX_WIDTH - 2, this.theme);
    const accent = (s: string) => this.theme.fg("accent", s);
    const muted = (s: string) => this.theme.fg("muted", s);
    const bold = (s: string) => this.theme.bold(s);

    const lines: string[] = [];
    lines.push(topBorder("Command Center"));
    lines.push(emptyRow());
    lines.push(emptyRow());
    lines.push(row("  " + accent(bold("Scanning sessions..."))));
    lines.push(row("  " + muted("Reading usage data from ~/.pi/agent/sessions/")));
    lines.push(emptyRow());
    lines.push(emptyRow());
    lines.push(divider());
    lines.push(row("  " + muted("esc close")));
    lines.push(bottomBorder());
    return lines;
  }

  private renderError(): string[] {
    const { row, emptyRow, topBorder, bottomBorder, divider } = makeBox(BOX_WIDTH - 2, this.theme);
    const warning = (s: string) => this.theme.fg("warning", s);
    const muted = (s: string) => this.theme.fg("muted", s);

    const lines: string[] = [];
    lines.push(topBorder("Command Center"));
    lines.push(emptyRow());
    lines.push(row("  " + warning("Failed to scan sessions.")));
    lines.push(row("  " + muted("Check ~/.pi/agent/sessions/")));
    lines.push(emptyRow());
    lines.push(divider());
    lines.push(row("  " + muted("esc close")));
    lines.push(bottomBorder());
    return lines;
  }

  // ── Render: Dashboard ────────────────────────────────────────────────

  private renderDashboard(): string[] {
    const { row, emptyRow, topBorder, bottomBorder, divider } = makeBox(BOX_WIDTH - 2, this.theme);
    const accent = (s: string) => this.theme.fg("accent", s);
    const muted = (s: string) => this.theme.fg("muted", s);
    const dim = (s: string) => this.theme.fg("dim", s);
    const success = (s: string) => this.theme.fg("success", s);
    const bold = (s: string) => this.theme.bold(s);
    const d = this.data!;

    const lines: string[] = [];

    // Tabs
    const tabs = `  ${this.theme.fg("success", bold("[Dashboard]"))}  ${dim("Projects")}  ${dim("Sessions")}`;
    lines.push(topBorder("Command Center"));
    lines.push(emptyRow());
    lines.push(row(tabs));
    lines.push(divider());
    lines.push(emptyRow());

    // Big stats
    lines.push(row(`  ${bold("Sessions:")}  ${accent(String(d.totalSessions))}`));
    lines.push(row(`  ${bold("Tokens:")}    ${accent(fmtNum(d.totalUsage.totalTokens))}  (in ${fmtNum(d.totalUsage.input)} / out ${fmtNum(d.totalUsage.output)})`));
    lines.push(row(`  ${bold("Cost:")}       ${success(fmtCost(d.totalUsage.cost))}`));
    if (d.totalUsage.cacheRead > 0 || d.totalUsage.cacheWrite > 0) {
      lines.push(row(`  ${bold("Cache:")}     read ${fmtNum(d.totalUsage.cacheRead)} / write ${fmtNum(d.totalUsage.cacheWrite)}`));
    }
    lines.push(emptyRow());
    lines.push(divider());
    lines.push(emptyRow());

    // Top projects by tokens
    lines.push(row(`  ${bold("Top projects by tokens:")}`));
    lines.push(emptyRow());

    const top = d.projects
      .filter((p) => p.usage.totalTokens > 0)
      .sort((a, b) => b.usage.totalTokens - a.usage.totalTokens)
      .slice(0, 5);

    const maxProjW = Math.max(...top.map((p) => p.shortName.length), 12);
    for (const p of top) {
      const projPadded = p.shortName.padEnd(maxProjW);
      const tokStr = fmtNum(p.usage.totalTokens).padStart(8);
      const costStr = fmtCost(p.usage.cost).padStart(8);
      const sessStr = `${p.sessionCount}s`.padStart(4);
      lines.push(row(`  ${accent(projPadded)}  ${bold(tokStr)}  ${success(costStr)}  ${dim(sessStr)}`));
    }

    if (top.length === 0) {
      lines.push(row(`  ${muted("No sessions with tokens yet.")}`));
    }

    lines.push(emptyRow());
    lines.push(divider());
    lines.push(row(`  ${accent("enter")} ${dim("projects")}  ${accent("tab")} ${dim("switch tab")}  ${accent("esc")} ${dim("close")}`));
    lines.push(bottomBorder());
    return lines;
  }

  // ── Render: Projects ─────────────────────────────────────────────────

  private renderProjects(): string[] {
    const { row, emptyRow, topBorder, bottomBorder, divider } = makeBox(BOX_WIDTH - 2, this.theme);
    const accent = (s: string) => this.theme.fg("accent", s);
    const muted = (s: string) => this.theme.fg("muted", s);
    const dim = (s: string) => this.theme.fg("dim", s);
    const success = (s: string) => this.theme.fg("success", s);
    const bold = (s: string) => this.theme.bold(s);

    const projects = this.getSortedProjects();
    const sel = Math.min(this.projectSelected, Math.max(0, projects.length - 1));

    const lines: string[] = [];

    // Tabs
    const tabs = `  ${dim("Dashboard")}  ${this.theme.fg("success", bold("[Projects]"))}  ${dim("Sessions")}`;
    lines.push(topBorder("Command Center"));
    lines.push(emptyRow());
    lines.push(row(tabs));
    lines.push(divider());
    lines.push(emptyRow());

    // Header
    const sortLabel = this.projectSortKey === "tokens" ? "tokens"
      : this.projectSortKey === "cost" ? "cost"
      : "sessions";
    const sortArrow = this.projectSortDir === "desc" ? "↓" : "↑";
    lines.push(row(`  ${bold("Project".padEnd(22))} ${bold("Sessions".padStart(10))}  ${bold("Tokens".padStart(10))} ${sortArrow}  ${bold("Cost".padStart(8))}`));
    lines.push(row(`  ${dim("─".repeat(70))}`));
    lines.push(emptyRow());

    if (projects.length === 0) {
      lines.push(row(`  ${muted("No projects found.")}`));
    } else {
      const maxVisible = 12;
      const startIdx = Math.max(0, Math.min(sel - Math.floor(maxVisible / 2), projects.length - maxVisible));
      const endIdx = Math.min(startIdx + maxVisible, projects.length);

      for (let i = startIdx; i < endIdx; i++) {
        const p = projects[i];
        const isSel = i === sel;
        const prefix = isSel ? accent("▸") : " ";
        const proj = truncateToWidth(p.shortName, 22, "…");

        const tokens = isSel ? accent(fmtNum(p.usage.totalTokens).padStart(10))
          : muted(fmtNum(p.usage.totalTokens).padStart(10));
        const cost = isSel ? success(fmtCost(p.usage.cost).padStart(8))
          : muted(fmtCost(p.usage.cost).padStart(8));
        const sessions = String(p.sessionCount).padStart(10);

        lines.push(row(` ${prefix} ${proj.padEnd(22)} ${sessions}  ${tokens}  ${cost}`));
      }

      lines.push(emptyRow());
      lines.push(row(dim(`  ${sel + 1}/${projects.length} projects  sorted by: ${sortLabel} ${sortArrow}`)));
    }

    lines.push(emptyRow());
    lines.push(divider());
    lines.push(row(`  ${accent("t/c/s")} ${dim("sort")}  ${accent("↑↓")} ${dim("nav")}  ${accent("enter")} ${dim("sessions")}  ${accent("tab")} ${dim("switch tab")}  ${accent("esc")} ${dim("close")}`));
    lines.push(bottomBorder());
    return lines;
  }

  // ── Render: Sessions ─────────────────────────────────────────────────

  private renderSessions(): string[] {
    const { row, emptyRow, topBorder, bottomBorder, divider } = makeBox(BOX_WIDTH - 2, this.theme);
    const accent = (s: string) => this.theme.fg("accent", s);
    const muted = (s: string) => this.theme.fg("muted", s);
    const dim = (s: string) => this.theme.fg("dim", s);
    const warning = (s: string) => this.theme.fg("warning", s);
    const bold = (s: string) => this.theme.bold(s);
    const error = (s: string) => this.theme.fg("error", s);

    const sessions = this.getFilteredSessions();
    const sel = Math.min(this.sessionSelected, Math.max(0, sessions.length - 1));

    const lines: string[] = [];

    // Tabs
    const tabs = `  ${dim("Dashboard")}  ${dim("Projects")}  ${this.theme.fg("success", bold("[Sessions]"))}`;
    lines.push(topBorder("Command Center"));
    lines.push(emptyRow());
    lines.push(row(tabs));
    lines.push(divider());
    lines.push(emptyRow());

    // Filter bar
    const cursor = accent("│");
    let filterDisplay: string;
    if (!this.sessionFilter) {
      filterDisplay = `${cursor}${muted("type to filter sessions...")}`;
    } else {
      const before = this.sessionFilter.slice(0, this.sessionFilterCursor);
      const after = this.sessionFilter.slice(this.sessionFilterCursor);
      filterDisplay = `${before}${cursor}${after}`;
    }
    lines.push(row(`  ${dim("◎")} ${filterDisplay}`));
    lines.push(row(`  ${dim(`${sessions.length} sessions`)}`));
    lines.push(emptyRow());

    if (this.deleting) {
      const s = sessions[sel];
      const label = s?.name || s?.firstUserMessage.slice(0, 60) || "(empty)";
      lines.push(emptyRow());
      lines.push(row("  " + warning(bold(`Delete "${label}"?`))));
      lines.push(row("  " + error("This cannot be undone.")));
      lines.push(row(`  ${accent("y")} ${dim("yes")}  ${accent("any other")} ${dim("cancel")}`));
      lines.push(emptyRow());
    } else if (sessions.length === 0) {
      lines.push(row(`  ${muted("No sessions match the filter.")}`));
    } else {
      const maxVisible = 14;
      const startIdx = Math.max(0, Math.min(sel - Math.floor(maxVisible / 2), sessions.length - maxVisible));
      const endIdx = Math.min(startIdx + maxVisible, sessions.length);

      for (let i = startIdx; i < endIdx; i++) {
        const s = sessions[i];
        const isSel = i === sel;
        const prefix = isSel ? accent("▸") : " ";
        const proj = truncateToWidth(shortProject(s.cwd, 18), 18, "…");
        const date = fmtDate(s.timestamp);
        const title = (s.name || s.firstUserMessage || "(empty)").slice(0, 50);
        const tokens = fmtNum(s.usage.totalTokens);

        lines.push(row(` ${prefix} ${accent(proj.padEnd(18))} ${dim(date.padEnd(16))} ${bold(tokens.padStart(6))}`));
        if (title) {
          lines.push(row(`   ${muted(truncateToWidth(title, BOX_WIDTH - 8, "…"))}`));
        }
      }

      lines.push(emptyRow());
      if (sessions.length > maxVisible) {
        lines.push(row(dim(`  ${sel + 1}/${sessions.length} sessions`)));
      }
    }

    lines.push(divider());
    lines.push(row(`  ${accent("enter")} ${dim("read")}  ${accent("r")} ${dim("resume")}  ${accent("d")} ${dim("delete")}  ${accent("tab")} ${dim("switch tab")}  ${accent("esc")} ${dim("close")}`));
    lines.push(bottomBorder());
    return lines;
  }
}

// ── Extension Entry ───────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // Tool: session_stats — the LLM can call it
  pi.registerTool({
    name: "session_stats",
    label: "Session Stats",
    description:
      "Get Pi session statistics: total sessions, tokens, cost, per-project breakdown. Use this to answer questions about token or cost spending across projects.",
    promptSnippet: "Get aggregate session statistics and per-project token/cost breakdown",
    promptGuidelines: [
      "Use session_stats when the user asks about their Pi usage, token spending, costs, or session counts.",
    ],
    parameters: Type.Object({}),
    async execute() {
      // Try the command center server first (richer analysis)
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 3000);
        const res = await fetch("http://localhost:8765/api/analysis.txt", {
          signal: controller.signal,
        });
        clearTimeout(timeout);
        if (res.ok) {
          const text = await res.text();
          return {
            content: [{ type: "text", text }],
            details: undefined,
          };
        }
      } catch {
        // Server not running, fall back to local parsing
      }

      const data = await getDashboardData();

      const projectLines = data.projects
        .filter((p) => p.usage.totalTokens > 0)
        .sort((a, b) => b.usage.totalTokens - a.usage.totalTokens)
        .slice(0, 10)
        .map((p, i) =>
          `${i + 1}. **${p.shortName}** — ${p.sessionCount} sessions, ${fmtNum(p.usage.totalTokens)} tokens, ${fmtCost(p.usage.cost)}`
        );

      const text = [
        `**Session Stats** (${data.totalSessions} sessions across ${data.projects.length} projects)`,
        "",
        `- **Total tokens:** ${fmtNum(data.totalUsage.totalTokens)} (in ${fmtNum(data.totalUsage.input)} / out ${fmtNum(data.totalUsage.output)})`,
        `- **Total cost:** ${fmtCost(data.totalUsage.cost)}`,
        data.totalUsage.cacheRead > 0 ? `- **Cache read:** ${fmtNum(data.totalUsage.cacheRead)}` : null,
        data.totalUsage.cacheWrite > 0 ? `- **Cache write:** ${fmtNum(data.totalUsage.cacheWrite)}` : null,
        "",
        "**Top projects by tokens:**",
        ...projectLines,
      ].filter(Boolean).join("\n");

      return {
        content: [{ type: "text", text }],
        details: undefined,
      };
    },
  });

  // Command: /cc
  pi.registerCommand("cc", {
    description: "Open the Command Center — session dashboard with tokens, projects, and session browser",
    handler: async (_args, ctx) => {
      const action = await ctx.ui.custom<Action>(
        (tui, theme, _kb, done) => new CommandCenterComponent(done, tui, theme),
        {
          overlay: true,
          overlayOptions: {
            anchor: "center" as const,
            width: BOX_WIDTH,
          } as Record<string, unknown>,
        },
      );

      if (!action || action.type === "close") return;

      if (action.type === "read") {
        // Set editor text for the session_read tool
        ctx.ui.setEditorText(`Read this session file with session_read:\nfile: ${action.session.file}`);
        ctx.ui.notify(`Session ${action.session.id.slice(0, 8)} — reading`, "info");
        return;
      }

      if (action.type === "resume") {
        const cmdCtx = ctx as ExtensionContext & Partial<ExtensionCommandContext>;
        if (typeof cmdCtx.switchSession === "function") {
          try {
            const result = await cmdCtx.switchSession(action.session.file);
            if (!result.cancelled) return;
          } catch (err) {
            ctx.ui.notify(`Resume failed: ${err}`, "error");
          }
          return;
        }
        ctx.ui.setEditorText(`/search resume ${action.session.file}`);
        ctx.ui.notify("Press Enter to resume this session", "info");
        return;
      }

      if (action.type === "delete") {
        const ok = await ctx.ui.confirm("Delete Session", `Delete "${action.session.name || action.session.firstUserMessage.slice(0, 50)}"?`);
        if (ok) {
          const success = await deleteSession(action.session.file);
          ctx.ui.notify(success ? "Session deleted" : "Failed to delete session", success ? "info" : "error");
        }
        return;
      }
    },
  });
}
