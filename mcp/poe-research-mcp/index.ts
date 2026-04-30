import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import OpenAI from "openai";
import { z } from "zod";

const client = new OpenAI({
  apiKey: process.env.POE_API_KEY,
  baseURL: "https://api.poe.com/v1",
});

const DEFAULT_MODEL = process.env.POE_MODEL || "GPT-5.4-mini";

const server = new McpServer({ name: "poe-research", version: "1.2.0" });

// --- Model routing ---

const CLAUDE_PATTERN = /^(claude|Claude)/;

function isClaudeModel(model: string): boolean {
  return CLAUDE_PATTERN.test(model);
}

// Claude models that support output_config.effort (newer API).
// Older Claude models (Haiku 4.5, Opus 4.5) fall back to budget_tokens thinking.
const CLAUDE_EFFORT_MODELS = [
  "Claude-Sonnet-4.6",
  "Claude-Opus-4.6",
  "Claude-Opus-4.7",
  "Claude-Mythos-Preview",
];

function claudeSupportsEffort(model: string): boolean {
  return CLAUDE_EFFORT_MODELS.some(
    (m) => model === m || model.toLowerCase().startsWith(m.toLowerCase()),
  );
}

// --- Source extraction ---

/**
 * Extract source URLs from a Responses API result (OpenAI models).
 * Uses annotations + web_search_call action sources.
 */
function extractSourcesResponsesAPI(response: any): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const item of response.output) {
    // URL citations from output text annotations
    if (item.type === "message") {
      for (const content of item.content || []) {
        if (content.type === "output_text" && content.annotations) {
          for (const annotation of content.annotations) {
            if (annotation.type === "url_citation" && annotation.url && !seen.has(annotation.url)) {
              seen.add(annotation.url);
              result.push(annotation.url);
            }
          }
        }
      }
    }
    // web_search_call action sources (if included)
    if (item.type === "web_search_call" && item.action?.sources) {
      for (const source of item.action.sources) {
        if (source.url && !seen.has(source.url)) {
          seen.add(source.url);
          result.push(source.url);
        }
      }
    }
  }

  return result;
}

/**
 * Extract source URLs from a Messages API result (Claude models).
 * Uses web_search_tool_result blocks + citations on text blocks.
 */
function extractSourcesMessagesAPI(body: any): { text: string; sources: string[] } {
  const seen = new Set<string>();
  const sources: string[] = [];
  const textParts: string[] = [];

  for (const block of body.content || []) {
    if (block.type === "web_search_tool_result") {
      for (const result of block.content || []) {
        if (result.type === "web_search_result" && result.url && !seen.has(result.url)) {
          seen.add(result.url);
          sources.push(result.url);
        }
      }
    }
    if (block.type === "text") {
      textParts.push(block.text);
      // Also extract from citations (higher signal — model actually referenced these)
      for (const citation of block.citations || []) {
        if (citation.url && !seen.has(citation.url)) {
          seen.add(citation.url);
          sources.push(citation.url);
        }
      }
    }
  }

  return { text: textParts.join(""), sources };
}

// --- Claude Messages API helper ---

interface MessagesAPIResult {
  text: string;
  sources: string[];
}

async function researchViaMessagesAPI(
  model: string,
  prompt: string,
  reasoning?: "low" | "medium" | "high",
): Promise<MessagesAPIResult> {
  const reqBody: Record<string, unknown> = {
    model,
    max_tokens: 16384,
    tools: [{ type: "web_search_20250305", name: "web_search" }],
    messages: [{ role: "user", content: prompt }],
  };

  if (reasoning) {
    if (claudeSupportsEffort(model)) {
      // Modern: output_config.effort controls thinking depth, token spend, everything
      reqBody.output_config = { effort: reasoning };
    } else {
      // Legacy: budget_tokens thinking (deprecated on newer models but only option on Haiku etc)
      const thinkingBudgets = { low: 2048, medium: 8192, high: 32768 };
      reqBody.thinking = { type: "enabled", budget_tokens: thinkingBudgets[reasoning] };
      reqBody.max_tokens = 16384 + thinkingBudgets[reasoning];
    }
  }

  const response = await fetch("https://api.poe.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": process.env.POE_API_KEY!,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(reqBody),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Messages API returned ${response.status}: ${errorBody}`);
  }

  const responseBody = await response.json();
  const { text, sources } = extractSourcesMessagesAPI(responseBody);
  return { text: text || "No response received.", sources };
}

// --- Tools ---

server.tool(
  "research",
  `Research a topic using Poe with built-in web search. Returns a comprehensive, sourced answer.`,
  {
    query: z.string().describe("The research question or topic to investigate"),
    model: z
      .string()
      .optional()
      .describe(
        `Poe model to use (default: ${DEFAULT_MODEL}). Examples: GPT-5.4, Claude-Sonnet-4.6`,
      ),
    reasoning: z
      .enum(["low", "medium", "high"])
      .optional()
      .describe(
        "Reasoning effort level (only works with reasoning-capable models)",
      ),
  },
  async ({ query, model, reasoning }) => {
    const modelId = model || DEFAULT_MODEL;

    try {
      // Route Claude models through Messages API for proper web search support
      if (isClaudeModel(modelId)) {
        const { text, sources } = await researchViaMessagesAPI(modelId, query, reasoning);

        let result = text;
        if (sources.length > 0) {
          result += "\n\n## Sources\n" + sources.map((s) => `- ${s}`).join("\n");
        }
        return { content: [{ type: "text", text: result }] };
      }

      // OpenAI models: Responses API with web_search_preview
      const params: Record<string, unknown> = {
        model: modelId,
        input: query,
        tools: [{ type: "web_search_preview" }],
        include: ["web_search_call.action.sources"],
      };

      if (reasoning) {
        params.reasoning = { effort: reasoning, summary: "auto" };
      }

      const response = await client.responses.create(params);

      let result = response.output_text || "No response received.";
      const sources = extractSourcesResponsesAPI(response);
      if (sources.length > 0) {
        result += "\n\n## Sources\n" + sources.map((s) => `- ${s}`).join("\n");
      }

      return { content: [{ type: "text", text: result }] };
    } catch (err: any) {
      const msg = err?.message || String(err);
      return {
        content: [{ type: "text", text: `Error calling Poe API: ${msg}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  "deep_research",
  `Perform multi-step deep research on a topic. Runs an initial search, then a follow-up to synthesize and fill gaps.`,
  {
    topic: z.string().describe("The topic to deeply research"),
    model: z
      .string()
      .optional()
      .describe(`Poe model (default: ${DEFAULT_MODEL})`),
  },
  async ({ topic, model }) => {
    const modelId = model || DEFAULT_MODEL;

    try {
      if (isClaudeModel(modelId)) {
        // Step 1
        const step1 = await researchViaMessagesAPI(
          modelId,
          `Research the following topic thoroughly. Provide key facts, recent developments, different perspectives, and cite sources.\n\nTopic: ${topic}`,
        );

        // Step 2
        const step2 = await researchViaMessagesAPI(
          modelId,
          `Based on these initial research findings, identify any gaps, contradictions, or areas needing more detail. Then search for additional information to fill those gaps and produce a final comprehensive report.\n\nInitial findings:\n${step1.text}\n\nOriginal topic: ${topic}`,
        );

        const allSources = [...new Set([...step1.sources, ...step2.sources])];
        let result = step2.text;
        if (allSources.length > 0) {
          result += "\n\n## Sources\n" + allSources.map((s) => `- ${s}`).join("\n");
        }
        return { content: [{ type: "text", text: result }] };
      }

      // OpenAI models: Responses API
      // Step 1
      const step1 = await client.responses.create({
        model: modelId,
        input: `Research the following topic thoroughly. Provide key facts, recent developments, different perspectives, and cite sources.\n\nTopic: ${topic}`,
        tools: [{ type: "web_search_preview" }],
        include: ["web_search_call.action.sources"],
      });

      const initialFindings = step1.output_text || "";
      const step1Sources = extractSourcesResponsesAPI(step1);

      // Step 2
      const step2 = await client.responses.create({
        model: modelId,
        input: `Based on these initial research findings, identify any gaps, contradictions, or areas needing more detail. Then search for additional information to fill those gaps and produce a final comprehensive report.\n\nInitial findings:\n${initialFindings}\n\nOriginal topic: ${topic}`,
        tools: [{ type: "web_search_preview" }],
        include: ["web_search_call.action.sources"],
      });

      const finalReport = step2.output_text || "No response received.";
      const step2Sources = extractSourcesResponsesAPI(step2);

      const allSources = [...new Set([...step1Sources, ...step2Sources])];
      let result = finalReport;
      if (allSources.length > 0) {
        result += "\n\n## Sources\n" + allSources.map((s) => `- ${s}`).join("\n");
      }
      return { content: [{ type: "text", text: result }] };
    } catch (err: any) {
      const msg = err?.message || String(err);
      return {
        content: [{ type: "text", text: `Error: ${msg}` }],
        isError: true,
      };
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
