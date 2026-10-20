// The exact bounds must reproduce the numbers printed in the manual (Pilot page), or a report built on them is wrong.
import { describe, expect, it } from "vitest";
import { binomialCdf, lowerBound, percent, rate, upperBound } from "../../src/eval/stats.ts";

describe("exact binomial bounds", () => {
  it("reproduce the manual's table for no failures", () => {
    expect(percent(upperBound(0, 20))).toBe("13.9%");
    expect(percent(upperBound(0, 50))).toBe("5.8%");
    expect(percent(upperBound(0, 100))).toBe("3.0%");
  });

  it("reproduce the manual's miss bounds", () => {
    expect(percent(upperBound(0, 10))).toBe("25.9%");
    expect(percent(upperBound(0, 30))).toBe("9.5%");
  });

  it("match known values with failures", () => {
    expect(upperBound(1, 10)).toBeCloseTo(0.3942, 3);
    expect(upperBound(2, 20)).toBeCloseTo(0.2826, 3);
    expect(lowerBound(10, 10)).toBeCloseTo(0.05 ** 0.1, 6);
    expect(lowerBound(9, 10)).toBeCloseTo(1 - 0.3942, 3); // one-sided: 9 of 10 is at least 60.6%
  });

  it("are consistent with each other and with the distribution", () => {
    for (const [k, n] of [[0, 5], [1, 5], [3, 7], [7, 7], [12, 40], [39, 40]] as const) {
      expect(lowerBound(k, n)).toBeCloseTo(1 - upperBound(n - k, n), 8);
      if (k < n) expect(binomialCdf(k, n, upperBound(k, n))).toBeCloseTo(0.05, 8);
    }
  });

  it("say nothing when there is no data", () => {
    expect(upperBound(0, 0)).toBe(1);
    expect(lowerBound(0, 0)).toBe(0);
    expect(rate(0, 0).rate).toBeNull();
    expect(percent(null)).toBe("n/a");
  });

  it("get tighter as n grows", () => {
    expect(upperBound(0, 200)).toBeLessThan(upperBound(0, 100));
    expect(upperBound(0, 100)).toBeLessThan(upperBound(0, 50));
  });

  it("reject nonsense", () => {
    expect(() => upperBound(3, 2)).toThrow(RangeError);
    expect(() => upperBound(-1, 2)).toThrow(RangeError);
    expect(() => upperBound(1.5, 3)).toThrow(RangeError);
    expect(() => upperBound(1, 3, 1)).toThrow(RangeError);
  });
});
