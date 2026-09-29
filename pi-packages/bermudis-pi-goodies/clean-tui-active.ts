// Load-time contract shared by index.ts, vision.ts and @bermudi/pi-codex.
// The flag reflects how the extension STARTED (goodies.json config) and is
// read at registration time only — toggling the feature requires /reload.
// Keep the symbol stable: pi-codex reads this exact global key.
const CLEAN_TUI_ACTIVE = Symbol.for("bermudis-pi-goodies.clean-tui.active.v1");

export function setCleanTuiActive(active: boolean): void {
  const globals = globalThis as Record<symbol, unknown>;
  if (active) globals[CLEAN_TUI_ACTIVE] = true;
  else delete globals[CLEAN_TUI_ACTIVE];
}

export function isCleanTuiActive(): boolean {
  return (globalThis as Record<symbol, unknown>)[CLEAN_TUI_ACTIVE] === true;
}
