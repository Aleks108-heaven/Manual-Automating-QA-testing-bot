import { createHash } from "node:crypto";

/** A hash of text with line endings normalized, so a checkout with CRLF gives the same hash as one with LF. */
export function hashText(text: string): string {
  return createHash("sha256").update(text.replaceAll("\r\n", "\n")).digest("hex");
}

/** JSON with sorted keys, so two values that mean the same thing give the same text. */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
