// packages/http/src/renderer.test.ts
import { describe, expect, test } from "bun:test";
import { renderTranscript, TOOL_CALL_INSTRUCTION } from "./renderer.ts";

describe("renderTranscript", () => {
  test("single user message renders with label and reply instruction", () => {
    const out = renderTranscript([{ role: "user", content: "hi there" }], []);
    expect(out).toContain("[user]\nhi there");
    expect(out).toContain("Respond to the conversation above.");
  });

  test("system messages become a preamble before the conversation", () => {
    const out = renderTranscript(
      [
        { role: "system", content: "You are terse." },
        { role: "user", content: "hi" },
      ],
      [],
    );
    expect(out.indexOf("You are terse.")).toBeLessThan(out.indexOf("[user]"));
  });

  test("assistant tool_calls and tool results are labeled turns", () => {
    const out = renderTranscript(
      [
        { role: "user", content: "weather?" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "get_weather", arguments: '{"city":"Paris"}' },
            },
          ],
        },
        { role: "tool", tool_call_id: "call_1", content: '{"temp":18}' },
      ],
      [],
    );
    expect(out).toContain('[assistant tool_call call_1]\nget_weather({"city":"Paris"})');
    expect(out).toContain('[tool result for call_1]\n{"temp":18}');
  });

  test("tools render schemas plus the tool-call instruction", () => {
    const out = renderTranscript(
      [{ role: "user", content: "weather?" }],
      [{ type: "function", function: { name: "get_weather", parameters: { type: "object" } } }],
    );
    expect(out).toContain('"name": "get_weather"');
    expect(out).toContain(TOOL_CALL_INSTRUCTION);
  });

  test("no tools means no tool instruction", () => {
    const out = renderTranscript([{ role: "user", content: "hi" }], []);
    expect(out).not.toContain(TOOL_CALL_INSTRUCTION);
  });
});
