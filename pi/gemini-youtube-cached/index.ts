/**
 * Gemini YouTube with Context Caching — detects YouTube URLs in user input,
 * creates a Gemini explicit context cache for the video, and injects the
 * cached content reference into subsequent provider requests.
 *
 * Why this exists:
 * The simple gemini-youtube extension injects fileData parts directly. Those
 * parts are ephemeral — Pi's session layer only round-trips text. Re-injecting
 * every turn means Gemini re-processes the entire video at full token cost.
 *
 * This extension solves it with Gemini's explicit context caching:
 * 1. `input` event: detects YouTube URLs, fetches metadata, creates a cache
 * 2. `before_provider_request`: injects `cachedContent` into the payload,
 *    referencing the cached video instead of re-sending fileData
 *
 * Cache lifecycle:
 * - Created on first YouTube URL detection (TTL: 2 hours)
 * - TTL refreshed on each request via the input hook
 * - Cleaned up on session shutdown
 * - Per-session: each Pi session gets its own cache(s)
 *
 * Requires: GEMINI_API_KEY in env or Pi's auth.json
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

// ── YouTube URL detection ──────────────────────────────────────────────────

const YOUTUBE_PATTERNS = [
	/(?:https?:\/\/)?(?:www\.)?youtube\.com\/watch\?(?:.*&)?v=([a-zA-Z0-9_-]{11})(?:&[^\s]*)?/,
	/(?:https?:\/\/)?youtu\.be\/([a-zA-Z0-9_-]{11})(?:[?&][^\s]*)?/,
	/(?:https?:\/\/)?(?:www\.)?youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})(?:[?&][^\s]*)?/,
	/(?:https?:\/\/)?(?:www\.)?youtube\.com\/embed\/([a-zA-Z0-9_-]{11})(?:[?&][^\s]*)?/,
	/(?:https?:\/\/)?(?:www\.)?youtube\.com\/live\/([a-zA-Z0-9_-]{11})(?:[?&][^\s]*)?/,
];

interface PendingVideo {
	originalUrl: string;
	videoUrl: string;
	videoId: string;
	title?: string;
	description?: string;
}

interface VideoCache {
	cacheName: string;
	videoId: string;
	title: string;
	videoUrl: string;
	createdAt: number;
}

function detectYouTubeUrls(text: string): PendingVideo[] {
	const videos: PendingVideo[] = [];
	const seen = new Set<string>();

	for (const pattern of YOUTUBE_PATTERNS) {
		const globalPattern = new RegExp(pattern.source, "g");
		let match;
		while ((match = globalPattern.exec(text)) !== null) {
			const videoId = match[1];
			if (seen.has(videoId)) continue;
			seen.add(videoId);
			videos.push({
				originalUrl: match[0],
				videoUrl: `https://www.youtube.com/watch?v=${videoId}`,
				videoId,
			});
		}
	}

	return videos;
}

// ── Metadata scraping ──────────────────────────────────────────────────────

async function fetchVideoMetadata(
	videoUrl: string,
): Promise<{ title: string; description: string } | null> {
	try {
		const resp = await fetch(videoUrl, {
			headers: { "User-Agent": "Mozilla/5.0 (compatible; bot)" },
			signal: AbortSignal.timeout(8000),
		});
		if (!resp.ok) return null;

		const html = await resp.text();
		const unescape = (s?: string) =>
			s
				?.replace(/&amp;/g, "&")
				.replace(/&lt;/g, "<")
				.replace(/&gt;/g, ">")
				.replace(/&quot;/g, '"')
				.replace(/&#39;/g, "'");

		const title = unescape(
			html.match(/<meta\s+property="og:title"\s+content="([^"]*)"/)?.[1],
		);
		const description = unescape(
			html.match(/<meta\s+property="og:description"\s+content="([^"]*)"/)?.[1],
		);

		if (!title && !description) return null;
		return { title: title ?? "", description: description ?? "" };
	} catch {
		return null;
	}
}

// ── Gemini Context Caching REST API ───────────────────────────────────────

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";

function getApiKey(): string {
	const key = process.env.GEMINI_API_KEY;
	if (key) return key;
	throw new Error(
		"GEMINI_API_KEY not set. gemini-youtube-cached requires it for context caching.",
	);
}

/** Extract the model ID from Pi's provider payload, defaulting to gemini-2.5-flash. */
function extractModel(payload: any): string {
	// Pi sends model as e.g. "models/gemini-2.5-flash-preview-05-20" or just the ID
	const raw =
		payload?.model ??
		payload?.config?.model ??
		"gemini-2.5-flash-preview-05-20";
	// Strip "models/" prefix if present — the caching API accepts both forms
	return raw.replace(/^models\//, "");
}

/** Create an explicit context cache for a YouTube video. */
async function createContextCache(
	videoUrl: string,
	videoId: string,
	title: string,
	description: string,
	model: string,
): Promise<string> {
	const apiKey = getApiKey();

	// Build the metadata text block for grounding
	const metaLines: string[] = [
		`YouTube Video: ${videoUrl}`,
		`Video ID: ${videoId}`,
	];
	if (title) metaLines.push(`Title: ${title}`);
	if (description) metaLines.push(`Description: ${description}`);

	const systemInstruction = [
		"You have access to a cached YouTube video. Answer questions about its content.",
		"When referencing the video, use timestamps in MM:SS format when possible.",
	].join("\n");

	const body = {
		model: `models/${model}`,
		contents: [
			{
				role: "user",
				parts: [
					{ text: metaLines.join("\n") },
					{
						fileData: {
							fileUri: videoUrl,
						},
					},
				],
			},
		],
		systemInstruction: {
			parts: [{ text: systemInstruction }],
			role: "system",
		},
		ttl: "7200s", // 2 hours
	};

	const resp = await fetch(`${GEMINI_BASE}/cachedContents?key=${apiKey}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(60000), // caching can take a while for long videos
	});

	if (!resp.ok) {
		const errText = await resp.text().catch(() => "unknown error");
		throw new Error(
			`Context cache creation failed (${resp.status}): ${errText}`,
		);
	}

	const data = (await resp.json()) as { name: string };
	if (!data.name) {
		throw new Error(`Context cache response missing 'name' field`);
	}

	return data.name;
}

/** Update the TTL on an existing cache to keep it alive. */
async function refreshCacheTTL(cacheName: string): Promise<void> {
	const apiKey = getApiKey();
	try {
		await fetch(`${GEMINI_BASE}/${cacheName}?key=${apiKey}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ ttl: "7200s" }),
			signal: AbortSignal.timeout(10000),
		});
	} catch {
		// Non-critical — the cache just expires sooner
	}
}

/** Delete a context cache. */
async function deleteCache(cacheName: string): Promise<void> {
	const apiKey = getApiKey();
	try {
		await fetch(`${GEMINI_BASE}/${cacheName}?key=${apiKey}`, {
			method: "DELETE",
			signal: AbortSignal.timeout(10000),
		});
	} catch {
		// Best effort cleanup
	}
}

// ── Session state ──────────────────────────────────────────────────────────

// Per-session caches: session key → array of caches
const sessionCaches = new Map<string, VideoCache[]>();

function getSessionKey(ctx: any): string {
	return ctx.sessionManager?.getSessionFile() ?? "__default__";
}

// ── Extension ──────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	// Step 1: Intercept input to detect YouTube URLs, create context caches
	pi.on("input", async (event, ctx) => {
		if (event.source === "extension") return { action: "continue" };

		const videos = detectYouTubeUrls(event.text);
		if (videos.length === 0) return { action: "continue" };

		const key = getSessionKey(ctx);

		// Fetch metadata for all videos in parallel
		const metadataResults = await Promise.all(
			videos.map((v) => fetchVideoMetadata(v.videoUrl)),
		);

		for (let i = 0; i < videos.length; i++) {
			const meta = metadataResults[i];
			if (meta) {
				videos[i].title = meta.title;
				videos[i].description = meta.description;
			}
		}

		const titles = videos.map((v) => v.title ?? v.videoId);
		ctx.ui.notify(
			`🎥 Creating cache for ${videos.length} video${videos.length > 1 ? "s" : ""}: ${titles.join(", ")}`,
			"info",
		);

		// Extract model from the current session config
		const model = ctx.model?.id?.replace(/^models\//, "") ?? "gemini-2.5-flash-preview-05-20";

		// Create caches (sequential to avoid rate limits)
		const existing = sessionCaches.get(key) ?? [];
		const newCaches: VideoCache[] = [];

		for (let i = 0; i < videos.length; i++) {
			const video = videos[i];
			try {
				const cacheName = await createContextCache(
					video.videoUrl,
					video.videoId,
					video.title ?? "",
					video.description ?? "",
					model,
				);

				const cache: VideoCache = {
					cacheName,
					videoId: video.videoId,
					title: video.title ?? video.videoId,
					videoUrl: video.videoUrl,
					createdAt: Date.now(),
				};
				newCaches.push(cache);

				ctx.ui.notify(
					`✅ Cached: ${video.title ?? video.videoId} (${cacheName})`,
					"info",
				);
			} catch (err: any) {
				ctx.ui.notify(
					`❌ Failed to cache ${video.videoId}: ${err.message}`,
					"error",
				);
			}
		}

		existing.push(...newCaches);
		sessionCaches.set(key, existing);

		// Build metadata block — always inject into text so it persists in
		// conversation history even if cache creation fails
		const metaBlock: string[] = [];
		for (const video of videos) {
			if (video.title || video.description) {
				metaBlock.push(`[YouTube: ${video.videoUrl}]`);
				if (video.title) metaBlock.push(`Title: ${video.title}`);
				if (video.description)
					metaBlock.push(`Description: ${video.description}`);
				metaBlock.push("");
			}
		}

		// Determine if the message is only URLs
		let textWithoutUrls = event.text;
		for (const v of videos) {
			textWithoutUrls = textWithoutUrls.replace(v.originalUrl, " ");
		}
		textWithoutUrls = textWithoutUrls.replace(/\s+/g, " ").trim();

		const suffix = metaBlock.length > 0 ? "\n\n" + metaBlock.join("\n") : "";

		if (!textWithoutUrls) {
			return {
				action: "transform",
				text: `${event.text}${suffix}\n\nPlease analyze the attached YouTube video${videos.length > 1 ? "s" : ""}.`,
			};
		}

		// Message has text beyond just URLs — inject metadata after the URL
		return {
			action: "transform",
			text: `${event.text}${suffix}`,
		};
	});

	// Step 2: Inject cachedContent reference into provider payload
	pi.on("before_provider_request", (event, ctx) => {
		const payload = event.payload;

		// Only intercept Google API requests
		if (!payload?.contents || !Array.isArray(payload.contents)) return;

		const key = getSessionKey(ctx);
		const caches = sessionCaches.get(key);
		if (!caches || caches.length === 0) return;

		// Use the most recently created cache (typically the one for this video)
		// For multi-video: use the last one — Gemini 2.5+ supports up to 10 videos per request
		// but cachedContent is a single reference, so we use the primary video's cache
		const primaryCache = caches[caches.length - 1];

		// Inject cachedContent into the payload
		// This replaces the need for fileData parts — the cache already contains the video
		if (!payload.config) {
			(payload as any).config = {};
		}
		(payload as any).config.cachedContent = primaryCache.cacheName;

		// Remove any fileData parts for videos we've cached — the cache supersedes them
		for (const content of payload.contents) {
			if (content?.parts && Array.isArray(content.parts)) {
				for (let i = content.parts.length - 1; i >= 0; i--) {
					const part = content.parts[i];
					if (
						part?.fileData?.fileUri &&
						caches.some((c) =>
							part.fileData.fileUri.includes(c.videoId),
						)
					) {
						content.parts.splice(i, 1);
					}
				}
			}
		}

		// Refresh TTL in background (fire and forget)
		for (const cache of caches) {
			refreshCacheTTL(cache.cacheName).catch(() => {});
		}

		// Return undefined to keep the (modified) payload
		return undefined;
	});

	// Step 3: Clean up caches on session shutdown
	pi.on("session_shutdown", async (_event, ctx) => {
		const key = getSessionKey(ctx);
		const caches = sessionCaches.get(key);
		if (!caches) return;

		// Delete caches in parallel
		await Promise.allSettled(
			caches.map((cache) => deleteCache(cache.cacheName)),
		);
		sessionCaches.delete(key);
	});
}
