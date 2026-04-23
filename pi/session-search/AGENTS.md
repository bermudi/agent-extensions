# Pi Session Search

**When you add features, fix bugs, or change behavior:**
1. Update `README.md` to reflect the change
2. Bump version in `package.json` (`npm version patch|minor|major --no-git-tag-version`)

## Bundling

This extension uses relative imports (`./indexer`, `./component`, etc.) which don't resolve when loaded via symlink (jiti resolves relative to the symlink path, not the real file). The extension is bundled into a single file and symlinked from `~/.pi/agent/extensions/`.

After any source change:

```bash
cd pi/pi-session-search
bun run bundle   # or npm run bundle
```

This runs esbuild and writes `extensions/index.bundle.mjs`. The bundle is gitignored.

**Why `--alias` for better-sqlite3?** Pi's extension loader (jiti) resolves bare module specifiers from the symlink's directory (`~/.pi/agent/extensions/`), not the real file's directory. `better-sqlite3` has a native `.node` binding that can't be bundled, so the alias rewrites it to an absolute path that resolves regardless of where the symlink points.

## Testing

- `npx tsc --noEmit` — must pass before every commit
- `node --import tsx extensions/__tests__/indexer.test.ts` — sanitizeTokens, buildFtsQuery, projectFromDir
- `node --import tsx extensions/__tests__/search.test.ts` — search input handling
- `node --import tsx extensions/__tests__/preview.test.ts` — preview input handling
- `node --import tsx extensions/__tests__/prompt-input.test.ts` — prompt input handling

## Architecture

Screen module pattern (from pi-subagents):
- `screens/search.ts`, `screens/preview.ts`, `screens/prompt-input.ts` — State, handleInput() → Action, render()
- `lib/render-helpers.ts` — theme-aware box drawing
- `component.ts` — SessionSearchComponent with screen routing
- `summarizer.ts` — OpenRouter/Gemini API for session summaries
- `indexer.ts` — SQLite FTS5 index (updateIndex, rebuildIndex, search)
- `index.ts` — thin entry: lifecycle + commands only
- All rendering uses `theme.fg()` — no raw ANSI escapes
