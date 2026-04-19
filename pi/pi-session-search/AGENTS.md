# Pi Session Search

**When you add features, fix bugs, or change behavior:**
1. Update `README.md` to reflect the change
2. Bump version in `package.json` (`npm version patch|minor|major --no-git-tag-version`)

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
