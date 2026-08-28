/**
 * Test harness for pi TUI extensions.
 *
 * Renders extensions through a faithful stand-in for pi's ToolExecutionComponent
 * instead of calling renderCall/renderResult directly. Getting these semantics
 * wrong hides real bugs (see the render-churn incident in bermudis-pi-goodies
 * 0.9.0: an invalidate loop that only reproduced when invalidate synchronously
 * re-entered the renderers).
 *
 * Semantics mirrored from @earendil-works/pi-coding-agent
 * dist/modes/interactive/components/tool-execution.js:
 *
 * - `updateDisplay()` ALWAYS re-runs `renderCall`, and additionally runs
 *   `renderResult` whenever a result is present. Both fire on every repaint:
 *   expand toggles, terminal resizes, neighbor invalidations.
 * - `ctx.invalidate()` maps to `component.invalidate()`, which synchronously
 *   calls `updateDisplay()`. Invalidation is a reentrant call back into your
 *   renderer, not a deferred repaint.
 * - Each render slot is wrapped in its own try/catch; a thrown error is
 *   swallowed and pi falls back to its built-in rendering for that slot.
 *   Errors surface here via `row.errors` / `row.fallbacks`, not exceptions.
 * - pi passes a FRESH wrapper object `{ content, details }` to renderResult on
 *   every call; only the inner `content` array reference is stable across
 *   repaints. Extensions that detect "is this a new result?" must compare the
 *   content ref, not the wrapper.
 */
export interface Theme {
  fg(color: string, text: string): string;
  bg(color: string, text: string): string;
  bold(text: string): string;
}

/** Theme where every modifier is the identity function. */
export function identityTheme(): Theme {
  return {
    fg: (_color, text) => text,
    bg: (_color, text) => text,
    bold: (text) => text,
  };
}

/** Context pi hands to renderCall/renderResult (subset extensions rely on). */
export interface RenderContext {
  toolCallId: string;
  expanded: boolean;
  isPartial: boolean;
  /** False while the call's JSON args are still streaming in. */
  argsComplete: boolean;
  isError: boolean;
  cwd: string;
  showImages: boolean;
  /** Synchronously re-renders this row (mirrors pi's invalidate). */
  invalidate(): void;
}

export interface ToolRenderOptions {
  expanded: boolean;
  isPartial: boolean;
}

export interface ToolDefinition {
  name: string;
  renderCall?: (args: unknown, theme: Theme, ctx: RenderContext) => unknown;
  renderResult?: (
    result: unknown,
    options: ToolRenderOptions,
    theme: Theme,
    ctx: RenderContext,
  ) => unknown;
  [key: string]: unknown;
}

/** Minimal slice of pi's ExtensionAPI that loader functions consume. */
export interface ExtensionAPIStub {
  on(event: string, handler: (event: unknown, ctx?: unknown) => void): void;
  registerTool(definition: ToolDefinition): void;
}

/** Minimal ExtensionContext stand-in: only what extensions under test touch. */
export interface HarnessContext {
  hasUI: boolean;
  ui: { setHiddenThinkingLabel(label?: string): void };
  /** pi's ctx exposes sessionManager; seed `branch` to simulate restored history. */
  sessionManager: { branch: unknown[]; getBranch(): readonly unknown[] };
}

export function createHarnessContext(): HarnessContext & {
  hiddenThinkingLabel: string | undefined;
} {
  const sessionManager = {
    branch: [] as unknown[],
    getBranch() {
      return sessionManager.branch;
    },
  };
  const ctx = {
    hasUI: true,
    hiddenThinkingLabel: undefined as string | undefined,
    sessionManager,
    ui: {
      setHiddenThinkingLabel(label?: string) {
        ctx.hiddenThinkingLabel = label;
      },
    },
  };
  return ctx;
}

export interface ToolRowOptions {
  theme?: Theme;
  /**
   * Upper bound on updateDisplay invocations for this row. Exceeding it means
   * render churn (an invalidate loop); the harness throws instead of hanging.
   */
  maxUpdates?: number;
  cwd?: string;
}

const DEFAULT_MAX_UPDATES = 1000;

/**
 * Stand-in for one ToolExecutionComponent instance. Drive it the way pi does:
 * setArgs() while arguments stream in, setResult() when execution finishes,
 * and let internal invalidations re-render on their own.
 */
export class ToolRow {
  updates = 0;
  fallbacks = 0;
  readonly errors: unknown[] = [];
  lastCallComponent: unknown;
  lastResultComponent: unknown;

  /**
   * Set when the churn guard fired. The guard's error is swallowed by the
   * slot try/catch (just as pi swallows stack overflows), so public entry
   * points rethrow after unwinding to make churn visible to tests.
   */
  private aborted = false;

  private argsValue: unknown;
  private argsComplete = true;
  private resultContent?: unknown[];
  private resultIsError = false;
  private hasResult = false;
  private expandedValue = false;
  private readonly theme: Theme;
  private readonly maxUpdates: number;

  constructor(
    private readonly definition: ToolDefinition,
    readonly toolCallId: string,
    options: ToolRowOptions = {},
  ) {
    this.theme = options.theme ?? identityTheme();
    this.maxUpdates = options.maxUpdates ?? DEFAULT_MAX_UPDATES;
  }

  private context(): RenderContext {
    const row = this;
    return {
      toolCallId: row.toolCallId,
      expanded: row.expandedValue,
      isPartial: false,
      argsComplete: row.argsComplete,
      isError: row.resultIsError,
      cwd: process.cwd(),
      showImages: true,
      invalidate: () => row.update(),
    };
  }

  /**
   * Simulate streaming/partial args (pi calls updateArgs -> updateDisplay).
   * Pass `{ argsComplete: false }` for intermediate streaming renders — pi's
   * ToolExecutionComponent reports argsComplete=false until the JSON args
   * finish streaming, then re-renders once more with argsComplete=true.
   */
  setArgs(args: unknown, opts?: { argsComplete?: boolean }): void {
    this.argsValue = args;
    this.argsComplete = opts?.argsComplete ?? true;
    this.update();
  }

  /** Simulate execution finishing (pi calls updateResult -> updateDisplay). */
  setResult(result: { content: unknown[]; isError?: boolean }): void {
    this.resultContent = result.content;
    this.resultIsError = result.isError ?? false;
    this.hasResult = true;
    this.update();
  }

  setExpanded(expanded: boolean): void {
    this.expandedValue = expanded;
    this.update();
  }

  /** One updateDisplay() pass; rethrows after unwinding if churn was detected. */
  private runUpdate(): void {
    if (this.aborted) return; // stop feeding a detected loop
    if (++this.updates > this.maxUpdates) {
      this.aborted = true;
      throw new Error(
        `pi-harness: row ${this.toolCallId} exceeded ${this.maxUpdates} renders — render churn (invalidate loop?), aborting instead of hanging`,
      );
    }
    try {
      this.lastCallComponent = this.definition.renderCall?.(
        this.argsValue,
        this.theme,
        this.context(),
      );
    } catch (error) {
      this.fallbacks++;
      this.errors.push(error);
      this.lastCallComponent = undefined;
    }
    if (!this.hasResult) return;
    // Fresh wrapper object every pass, stable content ref — like pi.
    const wrapper = { content: this.resultContent, details: undefined };
    const options: ToolRenderOptions = {
      expanded: this.expandedValue,
      isPartial: false,
    };
    try {
      this.lastResultComponent = this.definition.renderResult?.(
        wrapper,
        options,
        this.theme,
        this.context(),
      );
    } catch (error) {
      this.fallbacks++;
      this.errors.push(error);
      this.lastResultComponent = undefined;
    }
  }

  update(): void {
    this.runUpdate();
    if (this.aborted) {
      throw new Error(
        `pi-harness: render churn detected in row ${this.toolCallId} (${this.updates} renders, ${this.fallbacks} fallbacks)`,
      );
    }
  }
}

/**
 * Captures event handlers and registered tools from an extension loader, and
 * creates rows that render through faithful ToolExecutionComponent semantics.
 */
export class PiHarness {
  readonly handlers = new Map<
    string,
    Array<(event: unknown, ctx?: unknown) => void>
  >();
  readonly tools = new Map<string, ToolDefinition>();
  readonly rows: ToolRow[] = [];
  readonly ctx = createHarnessContext();
  private readonly theme: Theme;
  private readonly maxUpdates: number | undefined;

  constructor(options: { theme?: Theme; maxUpdates?: number } = {}) {
    this.theme = options.theme ?? identityTheme();
    this.maxUpdates = options.maxUpdates;
  }

  /** Pass this to an extension's default export. */
  readonly api: ExtensionAPIStub = {
    on: (event, handler) => {
      const list = this.handlers.get(event) ?? [];
      list.push(handler);
      this.handlers.set(event, list);
    },
    registerTool: (definition) => {
      this.tools.set(definition.name, definition);
    },
  };

  emit(event: string, payload: unknown = {}): void {
    for (const handler of this.handlers.get(event) ?? [])
      handler(payload, this.ctx);
  }

  tool(name: string): ToolDefinition {
    const definition = this.tools.get(name);
    if (!definition) {
      throw new Error(
        `pi-harness: no tool "${name}" registered (have: ${[...this.tools.keys()].join(", ") || "none"})`,
      );
    }
    return definition;
  }

  /** Create a rendered row for a registered tool. */
  row(toolName: string, toolCallId: string): ToolRow {
    const row = new ToolRow(this.tool(toolName), toolCallId, {
      theme: this.theme,
      maxUpdates: this.maxUpdates,
    });
    this.rows.push(row);
    return row;
  }

  /** Total display updates across all rows — churn detector for assertions. */
  get totalUpdates(): number {
    return this.rows.reduce((sum, row) => sum + row.updates, 0);
  }

  /** Total swallowed renderer errors across all rows. */
  get totalFallbacks(): number {
    return this.rows.reduce((sum, row) => sum + row.fallbacks, 0);
  }
}

/**
 * Load an extension into a harness. Accepts the module's default export.
 *
 * ```ts
 * const h = new PiHarness();
 * loadExtension(h, cleanTui);
 * ```
 */
export function loadExtension(
  harness: PiHarness,
  load: (api: ExtensionAPIStub) => unknown,
): PiHarness {
  load(harness.api);
  return harness;
}
