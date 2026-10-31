import type { AssistantMessage } from "@earendil-works/pi-ai";

// The identifier in the reported message may vary between requests.
// Do not classify all code 4006 errors (or other capacity messages) as transient.
const CAPACITY_MESSAGE = /^AiError: AiError: Service temporarily at capacity \([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\)$/i;

function isReportedCapacityError(text: string): boolean {
	// Pi's OpenAI adapter may prefix the JSON body with an HTTP status, e.g.
	// `400: {...}` or `400 {...}`. Parse the body, not a substring of its fields.
	const body = text.replace(/^\s*\d{3}(?::|\s)\s*/, "");
	try {
		const value: unknown = JSON.parse(body);
		if (!value || typeof value !== "object" || Array.isArray(value)) return false;
		const envelope = value as Record<string, unknown>;
		if (envelope.success !== false || !Array.isArray(envelope.errors) || envelope.errors.length !== 1) return false;
		const error: unknown = envelope.errors[0];
		return !!error && typeof error === "object" && !Array.isArray(error)
			&& (error as Record<string, unknown>).code === 4006
			&& typeof (error as Record<string, unknown>).message === "string"
			&& CAPACITY_MESSAGE.test((error as Record<string, unknown>).message as string);
	} catch {
		return false;
	}
}

/** Give Pi's normal retry classifier a recognized marker while retaining the entire original error. */
export function normalizeLogfareError(message: AssistantMessage): AssistantMessage | undefined {
	if (message.provider !== "logfare" || message.stopReason !== "error" || !message.errorMessage
		|| !isReportedCapacityError(message.errorMessage)) return undefined;
	return { ...message, errorMessage: `overloaded: ${message.errorMessage}` };
}

export function registerLogfareRetry(pi: {
	on(event: "message_end", handler: (event: { message: { role: string } }) => { message: AssistantMessage } | undefined): unknown;
}): void {
	pi.on("message_end", (event) => {
		if (event.message.role !== "assistant") return undefined;
		const message = normalizeLogfareError(event.message as AssistantMessage);
		return message ? { message } : undefined;
	});
}
