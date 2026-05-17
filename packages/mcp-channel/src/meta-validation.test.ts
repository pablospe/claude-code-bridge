import { expect, test } from "bun:test";
import { META_KEY_PATTERN, RESERVED_META_KEYS, validateWireMeta } from "./meta-validation.ts";

test("validateWireMeta accepts identifier-shaped keys with string values", () => {
  expect(validateWireMeta({ request_id: "x", trace_id: "y" })).toEqual({
    request_id: "x",
    trace_id: "y",
  });
});

test("validateWireMeta rejects keys not matching META_KEY_PATTERN", () => {
  expect(() => validateWireMeta({ "request-id": "x" })).toThrow(/invalid meta key/);
  expect(() => validateWireMeta({ "1bad": "x" })).toThrow(/invalid meta key/);
});

test("validateWireMeta rejects reserved keys session_id and message_id", () => {
  expect(() => validateWireMeta({ session_id: "x" })).toThrow(/reserved/);
  expect(() => validateWireMeta({ message_id: "x" })).toThrow(/reserved/);
});

test("validateWireMeta rejects non-string values", () => {
  expect(() => validateWireMeta({ key: 123 })).toThrow(/meta value must be string/);
});

test("META_KEY_PATTERN and RESERVED_META_KEYS are exported and stable", () => {
  expect(META_KEY_PATTERN.test("hello_id")).toBe(true);
  expect(META_KEY_PATTERN.test("bad-key")).toBe(false);
  expect(RESERVED_META_KEYS.has("session_id")).toBe(true);
  expect(RESERVED_META_KEYS.has("message_id")).toBe(true);
  expect(RESERVED_META_KEYS.has("other")).toBe(false);
});
