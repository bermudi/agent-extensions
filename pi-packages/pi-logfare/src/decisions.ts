import type {
	ClassifierContext,
	ClassifierModel,
	ClassifierOptions,
	ClassifierResult,
} from "@earendil-works/pi-ai";

const LABEL = "Logfare";

/**
 * Logfare's decisions dialect, verified live 2026-10-25 against
 * https://logfare.ai/v1/decisions (after the operator opted into the
 * decisions premium tier):
 *
 * - request: TypeSafe System One shape `{model, state, questions}`, bool
 *   questions as `noul`. Image input uses Clef's own `images` data-URL list
 *   (an attachedness probe answered noul 0.91); TypeSafe's `assets` form is
 *   rejected ("Extra inputs are not permitted", code 3030), so at most four
 *   PNG/JPEG/WebP images ride along as `images`.
 * - success response: Cloudflare-style envelope
 *   `{success: true, result: {model, answers, usage}, errors: []}` with
 *   System One answers (map keyed by question id, `noul` bools, probability
 *   maps) and flat usage `{input_tokens, output_tokens}`.
 * - failure bodies (HTTP 4xx) nest the same envelope inside an OpenAI-style
 *   `{"error": {...}}` wrapper.
 *
 * pi's shared System One core (`classifySystemOne`) speaks this dialect but
 * is only exported through `@earendil-works/pi-ai/api/*`, which the
 * extension loader does not map (root aliases rewrite such imports onto
 * `dist/compat.js`, mangling the path — observed 2026-10-25). So this file
 * implements the wire directly; all type imports are erased at runtime.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function requiredNumber(value: unknown, field: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new Error(`${LABEL} returned an invalid ${field}`);
	}
	return value;
}

/** Maps pi `bool` questions to System One's wire-level `noul` type. */
function wireRequest(context: ClassifierContext): Record<string, unknown> {
	return {
		state: context.state,
		questions: Object.fromEntries(
			Object.entries(context.questions).map(([id, question]) => [
				id,
				question.type === "bool" ? { ...question, type: "noul" } : question,
			]),
		),
	};
}

const DATA_URL_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
/** Clef accepts at most four images per request. */
const MAX_IMAGES = 4;

function addImages(images: { data: string; mimeType: string }[], body: Record<string, unknown>): void {
	if (images.length > MAX_IMAGES) {
		throw new Error(`${LABEL} accepts at most ${MAX_IMAGES} images, got ${images.length}`);
	}
	body.images = images.map((image) => {
		if (!DATA_URL_TYPES.has(image.mimeType)) {
			throw new Error(`${LABEL} accepts PNG, JPEG, and WebP images, got ${image.mimeType}`);
		}
		return `data:${image.mimeType};base64,${image.data}`;
	});
}

function envelopeErrorMessage(errors: unknown): string {
	if (Array.isArray(errors)) {
		const messages = errors
			.map((error) =>
				isRecord(error) && typeof error.message === "string" ? error.message : undefined,
			)
			.filter((message): message is string => message !== undefined);
		if (messages.length > 0) return `${LABEL} error: ${messages.join("; ")}`;
	}
	return `${LABEL} request failed`;
}

function probabilities(value: unknown, id: string): Record<string, number> {
	if (!isRecord(value)) throw new Error(`${LABEL} returned invalid probabilities for ${id}`);
	return Object.fromEntries(
		Object.entries(value).map(([key, probability]) => [
			key,
			requiredNumber(probability, `probability for ${id}.${key}`),
		]),
	);
}

function parseAnswer(id: string, question: ClassifierContext["questions"][string], answer: unknown) {
	if (!isRecord(answer)) throw new Error(`${LABEL} did not return an answer for ${id}`);
	if (question.type === "choice") {
		if (answer.type !== "choice" || typeof answer.choice !== "string") {
			throw new Error(`${LABEL} did not return a choice answer for ${id}`);
		}
		return {
			type: "choice" as const,
			choice: answer.choice,
			probabilities: probabilities(answer.probabilities, id),
			confidence: requiredNumber(answer.confidence, `confidence for ${id}`),
		};
	}
	if (question.type === "score") {
		if (answer.type !== "score") throw new Error(`${LABEL} did not return a score answer for ${id}`);
		return {
			type: "score" as const,
			score: requiredNumber(answer.score, `score for ${id}`),
			confidence: requiredNumber(answer.confidence, `confidence for ${id}`),
		};
	}
	if (answer.type !== "noul") throw new Error(`${LABEL} did not return a bool answer for ${id}`);
	return { type: "bool" as const, probability: requiredNumber(answer.noul, `noul for ${id}`) };
}

function parseAnswers(result: Record<string, unknown>, context: ClassifierContext) {
	const answers = result.answers;
	if (!isRecord(answers)) throw new Error(`${LABEL} returned an unexpected response`);
	return Object.fromEntries(
		Object.entries(context.questions).map(([id, question]) => [
			id,
			parseAnswer(id, question, answers[id]),
		]),
	);
}

/** Usage from the flat `{input_tokens, output_tokens}` object, priced from model cost. */
function parseUsage(value: unknown, model: ClassifierModel<string>) {
	if (!isRecord(value)) return undefined;
	const inputTokens = requiredNumber(value.input_tokens, "input_tokens");
	const outputTokens = requiredNumber(value.output_tokens, "output_tokens");
	const cost = model.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	return {
		input: inputTokens,
		output: outputTokens,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: inputTokens + outputTokens,
		cost: {
			input: (inputTokens / 1_000_000) * cost.input,
			output: (outputTokens / 1_000_000) * cost.output,
			cacheRead: 0,
			cacheWrite: 0,
			total:
				(inputTokens / 1_000_000) * cost.input + (outputTokens / 1_000_000) * cost.output,
		},
	};
}

async function postDecisions(
	url: URL,
	apiKey: string | undefined,
	body: unknown,
	options: ClassifierOptions | undefined,
): Promise<unknown> {
	const response = await fetch(url, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
		},
		body: JSON.stringify(body),
		signal: options?.signal ?? null,
	});
	const text = await response.text();
	let parsed: unknown;
	try {
		parsed = text ? JSON.parse(text) : undefined;
	} catch {
		parsed = undefined;
	}
	if (!response.ok) {
		const message =
			isRecord(parsed) && isRecord(parsed.error)
				? envelopeErrorMessage(parsed.error.errors)
				: `${LABEL} request failed (HTTP ${response.status})`;
		throw new Error(message);
	}
	return parsed;
}

async function classifyLogfare(
	model: ClassifierModel<string>,
	context: ClassifierContext,
	options?: ClassifierOptions,
): Promise<ClassifierResult> {
	const output: ClassifierResult = {
		api: model.api,
		provider: model.provider,
		model: model.id,
		answers: {},
		stopReason: "stop",
		timestamp: Date.now(),
	};
	try {
		const body = wireRequest(context);
		// wireRequest covers {state, questions}; the model id joins at the top level.
		const request = { model: model.id, ...body };
		if (context.images?.length) {
			if (!model.input.includes("image")) {
				throw new Error(`${LABEL} does not support image input for ${model.id}`);
			}
			addImages(context.images, request);
		}
		const url = new URL("decisions", `${model.baseUrl.replace(/\/+$/u, "")}/`);
		const parsed = await postDecisions(url, options?.apiKey, request, options);
		if (!isRecord(parsed)) throw new Error(`${LABEL} returned an unexpected response`);
		if (parsed.success === false) throw new Error(envelopeErrorMessage(parsed.errors));
		const result = parsed.result;
		if (!isRecord(result)) throw new Error(`${LABEL} returned an unexpected response`);
		const usage = parseUsage(result.usage, model);
		// Set before parsing answers: a request with malformed answers was still billed.
		if (usage) output.usage = usage;
		output.answers = parseAnswers(result, context);
		return output;
	} catch (error) {
		output.answers = {};
		output.stopReason = options?.signal?.aborted ? "aborted" : "error";
		output.errorMessage = error instanceof Error ? error.message : String(error);
		return output;
	}
}

/** pi provider `classifiers` entry: binds the "logfare-decisions" model api to its transport. */
export const logfareClassifiers = {
	"logfare-decisions": { classify: classifyLogfare },
} as const;
