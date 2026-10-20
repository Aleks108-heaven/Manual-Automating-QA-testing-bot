// Exact (Clopper-Pearson) one-sided 95% bounds for a count out of n, computed in code so no report depends on a
// rule of thumb. They reproduce the manual's table: no failures in 20 runs still allows a failure rate of 13.9%.

function lnGamma(x: number): number {
  const c = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = x;
  let tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let series = 1.000000000190015;
  for (const coefficient of c) series += coefficient / (y += 1);
  return -tmp + Math.log((2.5066282746310005 * series) / x);
}

/** Continued fraction for the incomplete beta function (modified Lentz). */
function betaContinuedFraction(a: number, b: number, x: number): number {
  const tiny = 1e-300;
  let c = 1;
  let d = 1 - ((a + b) * x) / (a + 1);
  if (Math.abs(d) < tiny) d = tiny;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 500; m += 1) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((a + m2 - 1) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + aa / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (a + b + m) * x) / ((a + m2) * (a + m2 + 1));
    d = 1 + aa * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + aa / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < 1e-14) break;
  }
  return h;
}

/** The regularised incomplete beta function I_x(a, b). */
function regularisedBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const front = Math.exp(lnGamma(a + b) - lnGamma(a) - lnGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? (front * betaContinuedFraction(a, b, x)) / a : 1 - (front * betaContinuedFraction(b, a, 1 - x)) / b;
}

/** P(X <= k) for X ~ Binomial(n, p). */
export function binomialCdf(k: number, n: number, p: number): number {
  if (k < 0) return 0;
  if (k >= n) return 1;
  return 1 - regularisedBeta(p, k + 1, n - k);
}

function bisect(f: (p: number) => number, target: number): number {
  // f is monotonic in p. Find p with f(p) = target.
  let lo = 0;
  let hi = 1;
  const increasing = f(1 - 1e-12) > f(1e-12);
  for (let i = 0; i < 200; i += 1) {
    const mid = (lo + hi) / 2;
    const above = f(mid) > target;
    if (above === increasing) hi = mid;
    else lo = mid;
  }
  return (lo + hi) / 2;
}

function check(count: number, n: number, confidence: number): void {
  if (!Number.isInteger(count) || !Number.isInteger(n) || count < 0 || n < 0 || count > n) throw new RangeError(`need 0 <= count <= n, got ${count} of ${n}`);
  if (!(confidence > 0 && confidence < 1)) throw new RangeError("confidence must be between 0 and 1");
}

/** The highest rate that the data still allows, with the given confidence (one-sided). With n = 0 nothing is known: 1. */
export function upperBound(count: number, n: number, confidence = 0.95): number {
  check(count, n, confidence);
  if (n === 0 || count === n) return 1;
  return bisect((p) => binomialCdf(count, n, p), 1 - confidence);
}

/** The lowest rate that the data still allows, with the given confidence (one-sided). With n = 0 nothing is known: 0. */
export function lowerBound(count: number, n: number, confidence = 0.95): number {
  check(count, n, confidence);
  if (n === 0 || count === 0) return 0;
  return bisect((p) => 1 - binomialCdf(count - 1, n, p), 1 - confidence);
}

export interface Rate {
  count: number;
  n: number;
  /** count / n, or null when n is 0. */
  rate: number | null;
  /** One-sided 95% bounds. */
  lower95: number;
  upper95: number;
}

export function rate(count: number, n: number): Rate {
  return { count, n, rate: n === 0 ? null : count / n, lower95: lowerBound(count, n), upper95: upperBound(count, n) };
}

export const percent = (value: number | null, digits = 1): string => (value === null ? "n/a" : `${(value * 100).toFixed(digits)}%`);
