import assert from "node:assert/strict";
import test from "node:test";
import { logfareClassifiers } from "../src/decisions.ts";
import type { ClassifierContext, ClassifierModel } from "@earendil-works/pi-ai";

const classify = logfareClassifiers["logfare-decisions"].classify;

function makeModel(overrides: Partial<ClassifierModel<string>> = {}): ClassifierModel<string> {
	return {
		type: "classifier",
		api: "logfare-decisions",
		provider: "logfare",
		id: "clef-flash",
		name: "Clef Flash",
		baseUrl: "https://logfare.ai/v1",
		input: ["text", "image"],
		cost: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 24576,
		...overrides,
	} as ClassifierModel<string>;
}

const CONTEXT: ClassifierContext = {
	state: { task: "unit test", result: "ok" },
	questions: {
		verdict: {
			type: "choice",
			instructions: "Classify the task result.",
			criteria: { pass: "The task succeeded", fail: "The task failed" },
		},
		sure: {
			type: "bool",
			instructions: "Is the result ok?",
			criteria: { true: "Result is ok", false: "Result is not ok" },
		},
	},
};

/** Recorded 2026-10-25 from a live clef-flash request. */
const LIVE_SUCCESS_BODY = {
	result: {
		model: "clef-flash",
		answers: {
			verdict: { type: "choice", choice: "pass", probabilities: { pass: 0.9588, fail: 0.0412 }, confidence: 0.8419 },
			sure: { type: "noul", noul: 0.9358 },
		},
		usage: { input_tokens: 208, output_tokens: 0 },
	},
	success: true,
	errors: [],
	messages: [],
};

/** Recorded 2026-10-25: OpenAI-style wrapper around the Cloudflare-style error envelope. */
const LIVE_ERROR_BODY = {
	error: {
		errors: [{ message: "AiError: Bad input: Error: required properties at '/' are 'model,state,questions'", code: 5006 }],
		success: false,
		result: {},
		messages: [],
	},
};

let lastRequest: { url: string; headers: Record<string, string>; body: any } | undefined;

function stubFetch(status: number, body: unknown) {
	lastRequest = undefined;
	const realFetch = globalThis.fetch;
	globalThis.fetch = (async (url: any, init: any) => {
		lastRequest = {
			url: String(url),
			headers: init.headers as Record<string, string>,
			body: JSON.parse(init.body as string),
		};
		return new Response(JSON.stringify(body), {
			status,
			headers: { "Content-Type": "application/json" },
		});
	}) as typeof fetch;
	return () => {
		globalThis.fetch = realFetch;
	};
}

test("success: answers, probabilities, noul bools, and priced usage map through", async () => {
	const restore = stubFetch(200, LIVE_SUCCESS_BODY);
	try {
		const result = await classify(makeModel(), CONTEXT, { apiKey: "test-key" });
		assert.equal(result.stopReason, "stop");
		assert.deepEqual(result.answers, {
			verdict: { type: "choice", choice: "pass", probabilities: { pass: 0.9588, fail: 0.0412 }, confidence: 0.8419 },
			sure: { type: "bool", probability: 0.9358 },
		});
		// 208 input tokens at $3/M = $0.000624.
		assert.deepEqual(result.usage, {
			input: 208,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 208,
			cost: { input: 0.000624, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.000624 },
		});
	} finally {
		restore();
	}
});

test("request wire: System One shape, bool→noul, bearer auth, /decisions path", async () => {
	const restore = stubFetch(200, LIVE_SUCCESS_BODY);
	try {
		await classify(makeModel(), CONTEXT, { apiKey: "test-key" });
		assert.equal(lastRequest!.url, "https://logfare.ai/v1/decisions");
		assert.equal(lastRequest!.headers.Authorization, "Bearer test-key");
		assert.deepEqual(lastRequest!.body, {
			model: "clef-flash",
			state: CONTEXT.state,
			questions: {
				verdict: CONTEXT.questions.verdict,
				sure: { ...CONTEXT.questions.sure, type: "noul" },
			},
		});
	} finally {
		restore();
	}
});

test("error bodies unwrap the OpenAI wrapper around the Cloudflare envelope", async () => {
	const restore = stubFetch(400, LIVE_ERROR_BODY);
	try {
		const result = await classify(makeModel(), CONTEXT, { apiKey: "test-key" });
		assert.equal(result.stopReason, "error");
		assert.match(result.errorMessage!, /AiError: Bad input/);
		assert.deepEqual(result.answers, {});
	} finally {
		restore();
	}
});

test("score answers map with score and confidence", async () => {
	const restore = stubFetch(200, {
		success: true,
		result: {
			answers: {
				grade: { type: "score", score: 4, confidence: 0.7 },
				sure: { type: "noul", noul: 0.9 },
			},
			usage: { input_tokens: 10, output_tokens: 0 },
		},
	});
	try {
		const context: ClassifierContext = {
			...CONTEXT,
			questions: {
				grade: { type: "score", instructions: "Grade it.", criteria: ["bad", "ok", "good"] },
				sure: CONTEXT.questions.sure!,
			},
		};
		const result = await classify(makeModel(), context);
		assert.deepEqual(result.answers.grade, { type: "score", score: 4, confidence: 0.7 });
	} finally {
		restore();
	}
});

test("images ride along as data URLs; more than four, wrong mime, or non-image models fail", async () => {
	const restore = stubFetch(200, LIVE_SUCCESS_BODY);
	const image = { type: "image" as const, data: "AAAA", mimeType: "image/png" as const };
	const images = [image];
	try {
		await classify(makeModel(), { ...CONTEXT, images });
		assert.deepEqual(lastRequest!.body.images, ["data:image/png;base64,AAAA"]);

		// Image-validation failures return an error result, mirroring pi's System One core.
		const tooMany = await classify(makeModel(), { ...CONTEXT, images: Array.from({ length: 5 }, () => image) });
		assert.equal(tooMany.stopReason, "error");
		assert.match(tooMany.errorMessage!, /at most 4 images/);

		const wrongMime = await classify(makeModel(), {
			...CONTEXT,
			images: [{ type: "image" as const, data: "AAAA", mimeType: "image/gif" as string }],
		});
		assert.match(wrongMime.errorMessage!, /PNG, JPEG, and WebP/);

		const noImageInput = await classify(makeModel({ input: ["text"] }), { ...CONTEXT, images });
		assert.match(noImageInput.errorMessage!, /does not support image input/);
	} finally {
		restore();
	}
});

test("malformed answers still surface usage; missing answers error", async () => {
	const restore = stubFetch(200, {
		success: true,
		result: { answers: { sure: { type: "noul", noul: 0.5 } }, usage: { input_tokens: 5, output_tokens: 0 } },
	});
	try {
		const result = await classify(makeModel(), CONTEXT);
		// verdict missing → error result, but usage was set before parsing failed.
		assert.equal(result.stopReason, "error");
		assert.match(result.errorMessage!, /did not return an answer for verdict/);
		assert.equal(result.usage?.input, 5);
	} finally {
		restore();
	}
});
