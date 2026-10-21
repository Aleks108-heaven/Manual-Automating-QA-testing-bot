// A case's `url` check may use a regular expression (`matches`). JavaScript regular expressions can take exponential time on
// some patterns and inputs, and there is no way to stop one that is running, so a badly written pattern would freeze the runner
// at the oracle step. The page can steer the input (the URL), so the pattern is checked when the case is validated, before any
// run, and the URL is cut to a fixed length before it is tested (see MAX_URL_LENGTH_TESTED).
//
// The rule is deliberately narrow, because a URL check needs very little:
//   - at most 200 characters, and it has to compile;
//   - no back-references;
//   - a group that is repeated with `+`, `*` or `{n,}`/`{n,m}` may not contain a repeat or an alternation (this rules out the
//     patterns that backtrack exponentially, such as (a+)+ and (a|aa)*), and `?` after a group is fine;
//   - at most two unbounded repeats in all, which keeps the worst case quadratic in the length of the URL.

export const MAX_PATTERN_LENGTH = 200;
export const MAX_UNBOUNDED_REPEATS = 2;
/** The longest URL a pattern is tested against. Anything after that is not looked at. */
export const MAX_URL_LENGTH_TESTED = 2048;

/** The length of a `{n}`, `{n,}` or `{n,m}` quantifier starting at `i`, or 0 if there is none. Reports whether it is unbounded or large. */
function braceQuantifier(pattern: string, i: number): { length: number; repeats: boolean; unbounded: boolean } {
  const m = /^\{(\d+)(?:(,)(\d*))?\}/.exec(pattern.slice(i));
  if (!m) return { length: 0, repeats: false, unbounded: false };
  const min = Number(m[1]);
  const hasComma = m[2] !== undefined;
  const max = hasComma ? (m[3] === "" ? Infinity : Number(m[3])) : min;
  // {0}, {1} and {n} repeat nothing; anything that can match more than once is a repeat.
  return { length: m[0].length, repeats: max > 1, unbounded: max === Infinity };
}

/** Returns what is wrong with a pattern, or null when it is acceptable. */
export function patternProblem(pattern: string): string | null {
  if (pattern.length > MAX_PATTERN_LENGTH) return `the pattern is ${pattern.length} characters long, and the limit is ${MAX_PATTERN_LENGTH}`;
  try {
    new RegExp(pattern);
  } catch {
    return "the pattern is not a valid regular expression";
  }
  if (/\\[1-9]|\\k</.test(pattern)) return "the pattern uses a back-reference, which can take exponential time";

  // One entry per open group: whether it contains a repeat or an alternation.
  const stack: Array<{ risky: boolean }> = [];
  let unbounded = 0;
  let inClass = false;
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i]!;
    if (ch === "\\") {
      i += 1;
      continue;
    }
    if (inClass) {
      if (ch === "]") inClass = false;
      continue;
    }
    if (ch === "[") {
      inClass = true;
      continue;
    }
    if (ch === "(") {
      stack.push({ risky: false });
      continue;
    }
    if (ch === "|") {
      const top = stack[stack.length - 1];
      if (top) top.risky = true;
      continue;
    }
    // A quantifier directly after an atom. `?` is bounded, so it is never a risk by itself.
    let repeats = false;
    if (ch === "*" || ch === "+") {
      repeats = true;
      unbounded += 1;
    } else if (ch === "{") {
      const q = braceQuantifier(pattern, i);
      if (q.length > 0) {
        repeats = q.repeats;
        if (q.unbounded) unbounded += 1;
        i += q.length - 1;
      }
    }
    if (repeats) {
      const top = stack[stack.length - 1];
      if (top) top.risky = true;
    }
    if (ch === ")") {
      const group = stack.pop();
      if (!group) return "the pattern has an unmatched closing parenthesis";
      // Is this group repeated?
      const next = pattern[i + 1];
      const brace = next === "{" ? braceQuantifier(pattern, i + 1) : { length: 0, repeats: false, unbounded: false };
      const groupRepeats = next === "*" || next === "+" || brace.repeats;
      if (groupRepeats && group.risky) return "a repeated group contains a repeat or an alternation, which can take exponential time (for example (a+)+)";
      // A group that is itself repeated, or that holds something risky, makes the group around it risky.
      const outer = stack[stack.length - 1];
      if (outer && (group.risky || groupRepeats)) outer.risky = true;
    }
  }
  if (unbounded > MAX_UNBOUNDED_REPEATS) return `the pattern has ${unbounded} unbounded repeats, and the limit is ${MAX_UNBOUNDED_REPEATS}`;
  return null;
}
