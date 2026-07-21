/**
 * bermudis-pi-goodies — a bundle of small, frequently-used Pi extensions.
 *
 * Composes four independent modules, each registering its own commands/hooks
 * against the shared ExtensionAPI:
 *   - copy-with-model  /copy-with-model  copy last reply tagged with the model
 *   - name-with-ai     /name-with-ai     generate a session name via the model
 *   - zed              /z                open Zed on cwd
 *   - prefer-tools    hook               block `rm` (use trash) + nudge rg/fd/uv
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import copyWithModel from "./copy-with-model.ts";
import nameWithAi from "./name-with-ai.ts";
import zed from "./zed.ts";
import preferTools from "./prefer-tools.ts";

export default function bermudisPiGoodies(pi: ExtensionAPI) {
  copyWithModel(pi);
  nameWithAi(pi);
  zed(pi);
  preferTools(pi);
}
