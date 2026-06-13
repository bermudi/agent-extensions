/**
 * bermundis-pi-goodies — a bundle of small, frequently-used Pi extensions.
 *
 * Composes four independent modules, each registering its own commands/hooks
 * against the shared ExtensionAPI:
 *   - copy-with-model  /copy-with-model  copy last reply tagged with the model
 *   - name-with-ai     /name-with-ai     generate a session name via the model
 *   - notify           (agent_end hook)  desktop/bell notification when Pi is ready
 *   - zed              /z                open Zed on cwd
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import copyWithModel from "./copy-with-model";
import nameWithAi from "./name-with-ai";
import notify from "./notify";
import zed from "./zed";

export default function bermundisPiGoodies(pi: ExtensionAPI) {
  copyWithModel(pi);
  nameWithAi(pi);
  notify(pi);
  zed(pi);
}
