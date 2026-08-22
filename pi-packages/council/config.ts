import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  CONFIG_DIR_NAME,
  getAgentDir,
  type ModelRegistry,
} from "@earendil-works/pi-coding-agent";
import { thinkingLevelSchema } from "./types.ts";

const modelSpecSchema = z.object({
  model: z.string().min(3),
  thinking: thinkingLevelSchema.optional(),
});

const configSchema = z
  .object({
    version: z.literal(1).default(1),
    members: z.array(modelSpecSchema).min(2),
    chair: z.discriminatedUnion("mode", [
      z.object({
        mode: z.literal("model"),
        model: z.string().min(3),
        thinking: thinkingLevelSchema.optional(),
      }),
      z.object({
        mode: z.literal("user"),
        secretary: modelSpecSchema,
      }),
    ]),
  })
  .strict();

export type CouncilConfig = z.infer<typeof configSchema>;
export type ModelSpec = z.infer<typeof modelSpecSchema>;

async function readJson(path: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw new Error(`Cannot read council config ${path}`, { cause: error });
  }
}

export async function loadConfig(
  cwd: string,
  allowProjectConfig: boolean,
): Promise<CouncilConfig> {
  const globalPath = join(getAgentDir(), "council.json");
  const projectPath = join(cwd, CONFIG_DIR_NAME, "council.json");
  const globalValue = await readJson(globalPath);
  const projectValue = allowProjectConfig
    ? await readJson(projectPath)
    : undefined;

  if (globalValue === undefined && projectValue === undefined) {
    throw new Error(
      `Council is not configured. Create ${globalPath} or ${projectPath}; see the council README.`,
    );
  }
  const merged =
    typeof globalValue === "object" &&
    globalValue !== null &&
    typeof projectValue === "object" &&
    projectValue !== null
      ? { ...globalValue, ...projectValue }
      : (projectValue ?? globalValue);
  return configSchema.parse(merged);
}

export function splitModelId(value: string): {
  provider: string;
  id: string;
} {
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) {
    throw new Error(
      `Invalid model "${value}". Use an exact provider/model identifier.`,
    );
  }
  return { provider: value.slice(0, slash), id: value.slice(slash + 1) };
}

export function assertModelsAvailable(
  config: CouncilConfig,
  registry: ModelRegistry,
): void {
  const specs = [
    ...config.members,
    ...(config.chair.mode === "model"
      ? [{ model: config.chair.model }]
      : [config.chair.secretary]),
  ];
  const unavailable = specs
    .map((spec) => spec.model)
    .filter((value) => {
      const { provider, id } = splitModelId(value);
      const model = registry.find(provider, id);
      return !model || !registry.hasConfiguredAuth(model);
    });
  if (unavailable.length > 0) {
    throw new Error(
      `Unavailable council model(s): ${[...new Set(unavailable)].join(", ")}`,
    );
  }
}
