import { expect, test } from "bun:test";
import { createAllowlistPolicy } from "./permission-policy.ts";

test("listed tools are allowed, everything else denied", () => {
  const p = createAllowlistPolicy(["Read", "Grep"]);
  expect(p.decide("Read")).toBe("allow");
  expect(p.decide("Grep")).toBe("allow");
  expect(p.decide("Bash")).toBe("deny");
  expect(p.decide("")).toBe("deny");
});

test("'all' allows everything", () => {
  const p = createAllowlistPolicy("all");
  expect(p.decide("Bash")).toBe("allow");
  expect(p.decide("anything")).toBe("allow");
});

test("matching is exact and case-sensitive", () => {
  const p = createAllowlistPolicy(["Read"]);
  expect(p.decide("read")).toBe("deny");
});
