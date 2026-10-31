import { registerLogfareProvider } from "../src/register.ts";
import { registerLogfareRetry } from "../src/retry.ts";

export default function (pi: Parameters<typeof registerLogfareProvider>[0] & Parameters<typeof registerLogfareRetry>[0]): void {
	registerLogfareProvider(pi);
	registerLogfareRetry(pi);
}
