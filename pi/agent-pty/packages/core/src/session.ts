import { spawn, type IPty } from "node-pty";
import { WasmBridge, type CellData, type CursorState } from "@wterm/core";

export interface Snapshot {
  snapshotId: number;
  at: string;
  size: { cols: number; rows: number };
  cursor: CursorState;
  text: string;
  contentHash: string;
}

function hashString(str: string): string {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(31, h) + str.charCodeAt(i) | 0;
  }
  return (h >>> 0).toString(16);
}

export class Session {
  pty: IPty;
  bridge: WasmBridge;
  name: string;
  command: string;
  cwd: string;
  createdAt: Date;
  killedAt: Date | null;
  exitInfo: { exitCode: number; signal?: number } | null;
  private snapshotCount = 0;

  private constructor(
    name: string,
    command: string,
    cwd: string,
    pty: IPty,
    bridge: WasmBridge,
  ) {
    this.name = name;
    this.command = command;
    this.cwd = cwd;
    this.pty = pty;
    this.bridge = bridge;
    this.createdAt = new Date();
    this.killedAt = null;
    this.exitInfo = null;

    pty.onData((data: string) => {
      bridge.writeString(data);
    });

    pty.onExit((e) => {
      this.exitInfo = e;
    });
  }

  static async create(
    name: string,
    command: string,
    args: string[],
    cwd: string,
    cols: number,
    rows: number,
    env: Record<string, string | undefined>,
  ): Promise<Session> {
    const bridge = await WasmBridge.load();
    bridge.init(cols, rows);
    const pty = spawn(command, args, {
      cols,
      rows,
      cwd,
      env,
    });
    return new Session(name, command, cwd, pty, bridge);
  }

  resize(cols: number, rows: number): void {
    this.pty.resize(cols, rows);
    this.bridge.resize(cols, rows);
  }

  snapshot(format: "full" | "text" = "text"): Snapshot & { grid?: string[][] } {
    this.snapshotCount++;
    const cols = this.bridge.getCols();
    const rows = this.bridge.getRows();
    const cursor = this.bridge.getCursor();

    const grid: string[][] = [];
    const lines: string[] = [];
    for (let r = 0; r < rows; r++) {
      const lineChars: string[] = [];
      for (let c = 0; c < cols; c++) {
        const cell = this.bridge.getCell(r, c);
        lineChars.push(String.fromCharCode(cell.char));
      }
      const line = lineChars.join("").replace(/\s+$/, "");
      lines.push(line);
      grid.push(lineChars);
    }

    const text = lines.join("\n").replace(/\s+$/, "");
    const contentHash = hashString(text);

    const result: Snapshot & { grid?: string[][] } = {
      snapshotId: this.snapshotCount,
      at: new Date().toISOString(),
      size: { cols, rows },
      cursor,
      text,
      contentHash,
    };

    if (format === "full") {
      result.grid = grid;
    }

    return result;
  }

  getScreenText(): string {
    return this.snapshot("text").text;
  }

  scrollback(maxLines: number = 0): { lines: string[]; text: string } {
    const count = this.bridge.getScrollbackCount();
    // 0 means "all", negative means "none"
    const take = maxLines <= 0 ? (maxLines === 0 ? count : 0) : Math.min(maxLines, count);
    const lines: string[] = [];
    // offset 0 is the oldest scrollback line; count-1 is the newest
    for (let i = count - take; i < count; i++) {
      const lineLen = this.bridge.getScrollbackLineLen(i);
      const chars: string[] = [];
      for (let c = 0; c < lineLen; c++) {
        const cell = this.bridge.getScrollbackCell(i, c);
        chars.push(String.fromCharCode(cell.char));
      }
      lines.push(chars.join("").replace(/\s+$/, ""));
    }
    return { lines, text: lines.join("\n") };
  }

  kill(signal?: string): void {
    this.pty.kill(signal);
    this.killedAt = new Date();
  }
}
