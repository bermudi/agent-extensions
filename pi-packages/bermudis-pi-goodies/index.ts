/**
 * bermudis-pi-goodies — a bundle of small, frequently-used Pi extensions.
 *
 * Composes independent modules, each registering its own commands/hooks
 * against the shared ExtensionAPI:
 *   - copy-with-model  /copy-with-model  copy last reply tagged with the model
 *   - copy-trajectory  /copy-trajectory  copy the whole conversation (text only) to the clipboard
 *   - name-with-ai     /name-with-ai     generate a session name via the model
 *   - zed              /z                open Zed on cwd
 *   - prefer-tools     hook              block legacy tools (use trash/rg/fd/uv)
 *   - keep-model       hook              preserve the active model across /new
 *   - clean-tui        tool overrides    collapse built-in tool output; keep a one-line call header, hide results/diffs until expanded
 *   - review           /review, /end-review  code review workflow (uncommitted, branch, commit, PR, folder)
 *   - kilo             provider          access Kilo Gateway models
 *   - provider-balance footer            show Kilo credits or Codex quota in the footer
 *   - tps              hook              notify tokens/sec and usage at each agent turn end
 *
 * Per-model thinking levels were previously provided here by a `model-thinking`
 * module with a `/levels` command and an extension-owned sidecar. Pi 0.84.3
 * added native per-model thinking-level overrides (settings.json
 * `modelThinkingLevels`, edited via `/settings` → "Default thinking level per
 * model") and made in-session model/thinking changes ephemeral by default, so
 * that module is retired.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import copyTrajectory from "./copy-trajectory.ts";
import copyWithModel from "./copy-with-model.ts";
import kilo from "./kilo.ts";
import keepModelOnNew from "./keep-model-on-new.ts";
import cleanTui from "./clean-tui.ts";
import review from "./review.ts";
import providerBalance from "./provider-balance.ts";
import tps from "./tps.ts";
import nameWithAi from "./name-with-ai.ts";
import zed from "./zed.ts";
import preferTools from "./prefer-tools.ts";
import goodies, { isEnabled } from "./goodies.ts";
import { setCleanTuiActive } from "./clean-tui.ts";

export default function bermudisPiGoodies(pi: ExtensionAPI): void {
  // Always register the toggle command first so you can recover even if
  // another feature is broken.
  goodies(pi);

  if (isEnabled("copy-with-model")) copyWithModel(pi);
  if (isEnabled("copy-trajectory")) copyTrajectory(pi);
  if (isEnabled("name-with-ai")) nameWithAi(pi);
  if (isEnabled("zed")) zed(pi);
  if (isEnabled("prefer-tools")) preferTools(pi);
  if (isEnabled("keep-model")) keepModelOnNew(pi);
  if (isEnabled("clean-tui")) cleanTui(pi);
  else setCleanTuiActive(false); // clear the pi-codex integration flag on /reload
  if (isEnabled("review")) review(pi);
  if (isEnabled("provider-balance")) providerBalance(pi);
  if (isEnabled("kilo")) kilo(pi);
  if (isEnabled("tps")) tps(pi);
}
