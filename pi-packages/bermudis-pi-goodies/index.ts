/**
 * bermudis-pi-goodies — a bundle of small, frequently-used Pi extensions.
 *
 * Composes independent modules, each registering its own commands/hooks
 * against the shared ExtensionAPI:
 *   - copy-with-model  /copy-with-model  copy last reply tagged with the model
 *   - name-with-ai     /name-with-ai     generate a session name via the model
 *   - zed              /z                open Zed on cwd
 *   - prefer-tools     hook              block legacy tools (use trash/rg/fd/uv)
 *   - model-thinking   hook + command    remember thinking levels by provider/model
 *   - fixed-defaults   hook              keep startup defaults stable
 *   - kilo             provider          access Kilo Gateway models
 *   - provider-balance footer            show Kilo credits or Codex quota in the footer
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import copyWithModel from "./copy-with-model.ts";
import fixedDefaults from "./fixed-defaults.ts";
import kilo from "./kilo.ts";
import modelThinking from "./model-thinking.ts";
import providerBalance from "./provider-balance.ts";
import nameWithAi from "./name-with-ai.ts";
import zed from "./zed.ts";
import preferTools from "./prefer-tools.ts";

export default function bermudisPiGoodies(pi: ExtensionAPI): void {
  copyWithModel(pi);
  nameWithAi(pi);
  zed(pi);
  preferTools(pi);
  modelThinking(pi);
  fixedDefaults(pi);
  providerBalance(pi);
  kilo(pi);
}
