import { describe, expect, test } from "bun:test";
import { formatCredits, parseKiloBalance } from "./provider-balance.ts";

describe("formatCredits", () => {
  test("uses compact notation for large balances", () => {
    expect(formatCredits(1500)).toBe("$1.5k");
    expect(formatCredits(25000)).toBe("$25.0k");
  });

  test("uses cents for ordinary balances", () => {
    expect(formatCredits(0)).toBe("$0.00");
    expect(formatCredits(12.5)).toBe("$12.50");
    expect(formatCredits(999.999)).toBe("$1000.00");
  });
});

describe("parseKiloBalance", () => {
  test("accepts a finite numeric balance", () => {
    expect(parseKiloBalance({ balance: 10.02 })).toBe(10.02);
  });

  test("rejects malformed external responses", () => {
    expect(parseKiloBalance(null)).toBeNull();
    expect(parseKiloBalance({ balance: "10.02" })).toBeNull();
    expect(parseKiloBalance({ balance: Number.NaN })).toBeNull();
    expect(parseKiloBalance({})).toBeNull();
  });
});
