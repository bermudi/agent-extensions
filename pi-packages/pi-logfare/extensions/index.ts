import { registerLogfareProvider } from "../src/register.ts";

export default function (pi: Parameters<typeof registerLogfareProvider>[0]): void {
	registerLogfareProvider(pi);
}
