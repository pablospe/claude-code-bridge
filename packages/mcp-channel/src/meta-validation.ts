/**
 * Shared wire-meta validation for control and channel-server frames.
 *
 * Meta keys must be plain identifier-ish strings, all values must be strings,
 * and the reserved keys `session_id` and `message_id` are populated by the
 * channel server itself and cannot be set by callers.
 */
export const META_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const RESERVED_META_KEYS: ReadonlySet<string> = new Set(["session_id", "message_id"]);

export function validateWireMeta(meta: Readonly<Record<string, unknown>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(meta)) {
    if (!META_KEY_PATTERN.test(key)) {
      throw new Error(`invalid meta key: ${key}`);
    }
    if (RESERVED_META_KEYS.has(key)) {
      throw new Error(`meta key is reserved: ${key}`);
    }
    if (typeof value !== "string") {
      throw new Error(`meta value must be string: ${key}`);
    }
    out[key] = value;
  }
  return out;
}
