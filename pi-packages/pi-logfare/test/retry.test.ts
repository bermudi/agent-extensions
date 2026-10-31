import assert from "node:assert/strict";
import test from "node:test";
import { isRetryableAssistantError, retryAssistantCall } from "@earendil-works/pi-ai";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { normalizeLogfareError, registerLogfareRetry } from "../src/retry.ts";

const body = '{"errors":[{"message":"AiError: AiError: Service temporarily at capacity (85f15b27-9f23-4fd9-9089-f7a09ff2133a)","code":4006}],"success":false,"result":{},"messages":[]}';
const failure = { role: "assistant", provider: "logfare", stopReason: "error", errorMessage: body, content: [], api: "openai-completions", model: "test", timestamp: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } as AssistantMessage;

test("message_end returns a replacement recognized by Pi retry and preserves the error", async () => {
	let handler: ((event: { message: { role: string } }) => { message: AssistantMessage } | undefined) | undefined;
	registerLogfareRetry({ on(name, fn) { assert.equal(name, "message_end"); handler = fn; } });
	assert.equal(isRetryableAssistantError(failure), false);
	const normalized = handler!({ message: failure })!.message;
	assert.equal(normalized.errorMessage, `overloaded: ${body}`);
	assert.equal(failure.errorMessage, body);
	assert.equal(isRetryableAssistantError(normalized), true);
	assert.equal(handler!({ message: { role: "user" } }), undefined);
	let calls = 0;
	const success = { ...failure, stopReason: "stop" } as AssistantMessage;
	const result = await retryAssistantCall(async () => ++calls === 1 ? normalized : success,
		{ enabled: true, maxRetries: 1, baseDelayMs: 0 }, undefined);
	assert.equal(calls, 2);
	assert.equal(result, success);
});

test("matches status prefixes and only the specified provider, error and code", () => {
	for (const prefix of ["400: ", "400 ", ""]) {
		assert.ok(normalizeLogfareError({ ...failure, errorMessage: prefix + body }));
	}
	assert.ok(normalizeLogfareError({ ...failure, errorMessage: body.replace("85f15b27", "85f15b28") }));
	for (const message of [
		{ ...failure, provider: "other" }, { ...failure, stopReason: "aborted" as const },
		{ ...failure, errorMessage: body.replace("4006", "4007") },
		{ ...failure, errorMessage: body.replace("85f15b27", "not-a-uuid") },
		{ ...failure, errorMessage: body.replace('"success":false', '"success":true') },
		{ ...failure, errorMessage: body.replace('"code":4006}', '"code":4006},{"message":"other","code":4006}') },
		{ ...failure, errorMessage: `prefix ${body}` }, { ...failure, errorMessage: body.slice(0, -1) },
	]) assert.equal(normalizeLogfareError(message), undefined);
});
