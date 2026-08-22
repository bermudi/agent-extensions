import {
  Agent,
  type AgentMessage,
  type AgentTool,
  type ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import { type Api, type Model } from "@earendil-works/pi-ai/compat";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import {
  convertToLlm,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  type ModelRegistry,
} from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import type { ZodType } from "zod";
import type { Evidence } from "./types.ts";

export interface AgentUpdate {
  actor: string;
  phase: string;
  delta?: string;
  tool?: string;
}

interface WorkerOptions {
  actor: string;
  cwd: string;
  model: Model<Api>;
  thinking: ThinkingLevel;
  registry: ModelRegistry;
  evidence: EvidenceStore;
  onUpdate: (update: AgentUpdate) => void;
}

function textFromMessage(message: AgentMessage | undefined): string {
  if (!message || message.role !== "assistant") return "";
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1] ?? text;
  const first = candidate.indexOf("{");
  const last = candidate.lastIndexOf("}");
  if (first === -1 || last < first) {
    throw new Error("Model response did not contain a JSON object");
  }
  return JSON.parse(candidate.slice(first, last + 1)) as unknown;
}

function resultText(result: {
  content: Array<{ type: string; text?: string }>;
}): string {
  return result.content
    .filter(
      (part): part is { type: string; text: string } =>
        typeof part.text === "string",
    )
    .map((part) => part.text)
    .join("\n");
}

export class EvidenceStore {
  private nextId = 1;
  readonly records: Evidence[] = [];

  constructor(
    private readonly cwd: string,
    private readonly onEvidence: (evidence: Evidence) => Promise<void>,
  ) {}

  wrap<TParameters extends TSchema, TDetails>(
    actor: string,
    operation: Evidence["operation"],
    tool: AgentTool<TParameters, TDetails>,
  ): AgentTool<TParameters, TDetails> {
    return {
      ...tool,
      execute: async (toolCallId, params, signal, onUpdate) => {
        const id = `E${this.nextId++}`;
        try {
          await assertInsideRepository(this.cwd, params);
          const result = await tool.execute(
            toolCallId,
            params,
            signal,
            onUpdate,
          );
          const evidence: Evidence = {
            id,
            actor,
            operation,
            input: params,
            output: resultText(result).slice(0, 50_000),
            createdAt: new Date().toISOString(),
          };
          this.records.push(evidence);
          await this.onEvidence(evidence);
          return {
            ...result,
            content: [
              { type: "text" as const, text: `Evidence ID: ${id}` },
              ...result.content,
            ],
          };
        } catch (error) {
          const evidence: Evidence = {
            id,
            actor,
            operation,
            input: params,
            error: error instanceof Error ? error.message : String(error),
            createdAt: new Date().toISOString(),
          };
          this.records.push(evidence);
          await this.onEvidence(evidence);
          throw error;
        }
      },
    };
  }

  assertValidReferences(value: unknown): void {
    const known = new Set(
      this.records.filter((record) => !record.error).map((record) => record.id),
    );
    const serialized = JSON.stringify(value);
    const references = serialized.match(/\bE\d+\b/g) ?? [];
    const invalid = references.filter((reference) => !known.has(reference));
    if (invalid.length > 0) {
      throw new Error(
        `Output cites nonexistent or failed evidence: ${[...new Set(invalid)].join(", ")}`,
      );
    }
  }
}

async function assertInsideRepository(
  cwd: string,
  params: unknown,
): Promise<void> {
  if (typeof params !== "object" || params === null) return;
  const values = params as Record<string, unknown>;
  const requested =
    typeof values.path === "string"
      ? values.path
      : typeof values.file_path === "string"
        ? values.file_path
        : ".";
  const root = await realpath(cwd);
  const target = await realpath(
    isAbsolute(requested) ? requested : resolve(cwd, requested),
  );
  const fromRoot = relative(root, target);
  if (
    fromRoot === ".." ||
    fromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
    isAbsolute(fromRoot)
  ) {
    throw new Error(
      `Council tools cannot read outside repository: ${requested}`,
    );
  }
}

export class CouncilWorker {
  private readonly agent: Agent;
  private phase = "starting";
  private readonly unsubscribe: () => void;

  constructor(private readonly options: WorkerOptions) {
    const tools = [
      options.evidence.wrap(options.actor, "read", createReadTool(options.cwd)),
      options.evidence.wrap(options.actor, "grep", createGrepTool(options.cwd)),
      options.evidence.wrap(options.actor, "find", createFindTool(options.cwd)),
      options.evidence.wrap(options.actor, "ls", createLsTool(options.cwd)),
    ];
    this.agent = new Agent({
      initialState: {
        systemPrompt: [
          "You are a member of a read-only software design council.",
          "Investigate the repository before making factual claims.",
          "The only admissible direct evidence is an Evidence ID returned by a tool.",
          "Distinguish direct observations, inferences, and preferences.",
          "Never ask to edit files and never claim that tests were run.",
          "When JSON is requested, return exactly one JSON object with no commentary.",
          `Repository root: ${options.cwd}`,
        ].join("\n"),
        model: options.model,
        thinkingLevel: options.thinking,
        tools,
      },
      convertToLlm,
      streamFn: async (model, context, streamOptions) => {
        const auth = await options.registry.getApiKeyAndHeaders(model);
        if (!auth.ok) {
          throw new Error(`Authentication failed: ${auth.error}`);
        }
        const provider = options.registry.getProvider(model.provider);
        if (!provider) {
          throw new Error(`No configured provider for ${model.provider}`);
        }
        const requestModel = auth.baseUrl
          ? { ...model, baseUrl: auth.baseUrl }
          : model;
        return provider.streamSimple(requestModel, context, {
          ...streamOptions,
          apiKey: auth.apiKey,
          headers: auth.headers ?? undefined,
          env: auth.env,
        });
      },
    });
    this.unsubscribe = this.agent.subscribe((event) => {
      if (
        event.type === "message_update" &&
        event.assistantMessageEvent.type === "text_delta"
      ) {
        options.onUpdate({
          actor: options.actor,
          phase: this.phase,
          delta: event.assistantMessageEvent.delta,
        });
      } else if (event.type === "tool_execution_start") {
        options.onUpdate({
          actor: options.actor,
          phase: this.phase,
          tool: event.toolName,
        });
      }
    });
  }

  async runJson<T>(
    phase: string,
    prompt: string,
    schema: ZodType<T>,
    validate?: (value: T) => void,
  ): Promise<{ value: T; raw: string }> {
    this.phase = phase;
    const first = await this.prompt(prompt);
    try {
      const value = schema.parse(extractJson(first));
      this.options.evidence.assertValidReferences(value);
      validate?.(value);
      return { value, raw: first };
    } catch (error) {
      const repair = await this.prompt(
        [
          "Your previous answer was invalid.",
          error instanceof Error ? error.message : String(error),
          "Return a complete corrected JSON object only. Do not discuss the error.",
        ].join("\n"),
      );
      const value = schema.parse(extractJson(repair));
      this.options.evidence.assertValidReferences(value);
      validate?.(value);
      return { value, raw: repair };
    }
  }

  abort(): void {
    this.agent.abort();
  }

  dispose(): void {
    this.unsubscribe();
    this.agent.abort();
  }

  private async prompt(prompt: string): Promise<string> {
    const before = this.agent.state.messages.length;
    await this.agent.prompt(prompt);
    await this.agent.waitForIdle();
    const messages = this.agent.state.messages.slice(before);
    const response = [...messages]
      .reverse()
      .find((message) => message.role === "assistant");
    const text = textFromMessage(response);
    if (!text) {
      throw new Error(
        this.agent.state.errorMessage ?? "Model returned no text response",
      );
    }
    return text;
  }
}
