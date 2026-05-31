import { spawn, type IPty } from "node-pty";
import { WasmBridge, type CellData, type CursorState } from "@wterm/core";

export interface Snapshot {
  snapshotId: number;
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

    pty.onData((data: string) => {
      bridge.writeString(data);
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

  kill(signal?: string): void {
    this.pty.kill(signal);
  }
}
