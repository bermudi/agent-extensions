/**
 * bermudis-pi-goodies — a bundle of small, frequently-used Pi extensions.
 *
 * Composes three independent modules, each registering its own commands/hooks
 * against the shared ExtensionAPI:
 *   - copy-with-model  /copy-with-model  copy last reply tagged with the model
 *   - name-with-ai     /name-with-ai     generate a session name via the model
 *   - zed              /z                open Zed on cwd
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import copyWithModel from "./copy-with-model.ts";
import nameWithAi from "./name-with-ai.ts";
import zed from "./zed.ts";

export default function bermudisPiGoodies(pi: ExtensionAPI) {
  copyWithModel(pi);
  nameWithAi(pi);
  zed(pi);
}
