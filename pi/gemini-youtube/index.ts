/**
 * Gemini YouTube Support — detects YouTube URLs in user input, fetches video
 * metadata (title + description), and injects both `fileData` parts and a
 * metadata text block into the Google Generative AI payload so Gemini can
 * natively understand video content with textual grounding.
 *
 * How it works:
 * 1. `input` event: detects YouTube URLs, fetches metadata, stores them
 * 2. `before_provider_request`: when provider uses google-generative-ai API,
 *    injects stored URLs as `fileData` parts + metadata as text in the last user message
 *
 * Supports: regular YouTube URLs, shortened youtu.be links, and Shorts.
 *
 * Place in: ~/.pi/agent/extensions/gemini-youtube/index.ts
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

// YouTube URL patterns
const YOUTUBE_PATTERNS = [
	// Standard watch URLs: youtube.com/watch?v=VIDEO_ID
	/(?:https?:\/\/)?(?:www\.)?youtube\.com\/watch\?(?:.*&)?v=([a-zA-Z0-9_-]{11})(?:&[^\s]*)?/,
	// Short URLs: youtu.be/VIDEO_ID
	/(?:https?:\/\/)?youtu\.be\/([a-zA-Z0-9_-]{11})(?:[?&][^\s]*)?/,
	// Shorts: youtube.com/shorts/VIDEO_ID
	/(?:https?:\/\/)?(?:www\.)?youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})(?:[?&][^\s]*)?/,
	// Embed: youtube.com/embed/VIDEO_ID
	/(?:https?:\/\/)?(?:www\.)?youtube\.com\/embed\/([a-zA-Z0-9_-]{11})(?:[?&][^\s]*)?/,
	// Live: youtube.com/live/VIDEO_ID
	/(?:https?:\/\/)?(?:www\.)?youtube\.com\/live\/([a-zA-Z0-9_-]{11})(?:[?&][^\s]*)?/,
];

interface PendingVideo {
	/** The original URL as typed by the user */
	originalUrl: string;
	/** The canonical YouTube watch URL */
	videoUrl: string;
	/** The YouTube video ID */
	videoId: string;
	/** Video title fetched from YouTube */
	title?: string;
	/** Video description fetched from YouTube */
	description?: string;
}

interface VideoMetadata {
	title: string;
	description: string;
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

/**
 * Fetch video metadata by scraping YouTube's OG meta tags from the watch page.
 * Falls back gracefully if the fetch fails or parsing finds nothing.
 */
async function fetchVideoMetadata(videoUrl: string): Promise<VideoMetadata | null> {
	try {
		const resp = await fetch(videoUrl, {
			headers: {
				"User-Agent":
					"Mozilla/5.0 (compatible; bot)",
			},
			signal: AbortSignal.timeout(8000),
		});
		if (!resp.ok) return null;

		const html = await resp.text();

		const titleMatch = html.match(/<meta\s+property="og:title"\s+content="([^"]*)"/);
		const descMatch = html.match(/<meta\s+property="og:description"\s+content="([^"]*)"/);

		const title = titleMatch?.[1]
			?.replace(/&amp;/g, "&")
			?.replace(/&lt;/g, "<")
			?.replace(/&gt;/g, ">")
			?.replace(/&quot;/g, '"')
			?.replace(/&#39;/g, "'");

		const description = descMatch?.[1]
			?.replace(/&amp;/g, "&")
			?.replace(/&lt;/g, "<")
			?.replace(/&gt;/g, ">")
			?.replace(/&quot;/g, '"')
			?.replace(/&#39;/g, "'");

		if (!title && !description) return null;

		return { title: title ?? "", description: description ?? "" };
	} catch {
		return null;
	}
}

// Per-session pending videos (cleared after each provider request)
const pendingVideos = new Map<string, PendingVideo[]>();

function getSessionKey(ctx: any): string {
	return ctx.sessionManager?.getSessionFile() ?? "__default__";
}

export default function (pi: ExtensionAPI) {
	// Step 1: Intercept input to detect YouTube URLs and fetch metadata
	pi.on("input", async (event, ctx) => {
		if (event.source === "extension") return { action: "continue" };

		const videos = detectYouTubeUrls(event.text);

		if (videos.length === 0) return { action: "continue" };

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

		// Store for the provider request hook
		const key = getSessionKey(ctx);
		const existing = pendingVideos.get(key) ?? [];
		existing.push(...videos);
		pendingVideos.set(key, existing);

		const titles = videos.map((v) => v.title ?? v.videoId);
		ctx.ui.notify(
			`🎥 Found ${videos.length} YouTube video${videos.length > 1 ? "s" : ""}: ${titles.join(", ")}`,
			"info",
		);

		// Check if the text is ONLY YouTube URLs (nothing else after stripping them)
		let textWithoutUrls = event.text;
		for (const v of videos) {
			textWithoutUrls = textWithoutUrls.replace(v.originalUrl, " ");
		}
		textWithoutUrls = textWithoutUrls.replace(/\s+/g, " ").trim();

		if (!textWithoutUrls) {
			return {
				action: "transform",
				text: `${event.text}\n\nPlease analyze the attached YouTube video${videos.length > 1 ? "s" : ""}.`,
			};
		}

		// Keep the user's text as-is (URLs remain in the message)
		return { action: "continue" };
	});

	// Step 2: Inject YouTube URLs + metadata into the Google provider payload
	pi.on("before_provider_request", (event, ctx) => {
		const payload = event.payload;

		// Check if this is a Google API request by inspecting the payload shape
		if (!payload?.contents || !Array.isArray(payload.contents)) return;

		const key = getSessionKey(ctx);
		const videos = pendingVideos.get(key);
		if (!videos || videos.length === 0) return;

		// Clear pending videos
		pendingVideos.delete(key);

		// Find the last user message in contents
		let lastUserContent: any = null;
		for (let i = payload.contents.length - 1; i >= 0; i--) {
			if (payload.contents[i]?.role === "user") {
				lastUserContent = payload.contents[i];
				break;
			}
		}

		if (!lastUserContent) return;

		// Ensure parts array exists
		if (!lastUserContent.parts) {
			lastUserContent.parts = [];
		}

		// Build a metadata text block for all videos
		const metaLines: string[] = [];
		for (const video of videos) {
			if (video.title || video.description) {
				metaLines.push(`Video: ${video.videoUrl}`);
				if (video.title) metaLines.push(`Title: ${video.title}`);
				if (video.description) metaLines.push(`Description: ${video.description}`);
				metaLines.push("");
			}
		}

		// Inject metadata as a text part before the fileData parts
		if (metaLines.length > 0) {
			lastUserContent.parts.push({
				text: metaLines.join("\n").trim(),
			});
		}

		// Inject each video as a fileData part
		for (const video of videos) {
			lastUserContent.parts.push({
				fileData: {
					fileUri: video.videoUrl,
					mimeType: "video/youtube",
				},
			});
		}
	});

	// Clean up on session shutdown
	pi.on("session_shutdown", async (_event, ctx) => {
		const key = getSessionKey(ctx);
		pendingVideos.delete(key);
	});
}
