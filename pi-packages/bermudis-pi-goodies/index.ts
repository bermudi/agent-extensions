/**
 * bermudis-pi-goodies — a bundle of small, frequently-used Pi extensions.
 *
 * Composes independent modules, each registering its own commands/hooks
 * against the shared ExtensionAPI:
 *   - copy-with-model  /copy-with-model  copy last reply tagged with the model
 *   - name-with-ai     /name-with-ai     generate a session name via the model
 *   - zed              /z                open Zed on cwd
 *   - prefer-tools     hook              block legacy tools (use trash/rg/fd/uv)
 *   - kilo             provider          access Kilo Gateway models
 *   - provider-balance footer            show remaining Kilo credits in the footer
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import copyWithModel from "./copy-with-model.ts";
import kilo from "./kilo.ts";
import providerBalance from "./provider-balance.ts";
import nameWithAi from "./name-with-ai.ts";
import zed from "./zed.ts";
import preferTools from "./prefer-tools.ts";

export default async function bermudisPiGoodies(
  pi: ExtensionAPI,
): Promise<void> {
  copyWithModel(pi);
  nameWithAi(pi);
  zed(pi);
  preferTools(pi);
  providerBalance(pi);
  await kilo(pi);
}
