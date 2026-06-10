// packages/http/src/renderer.test.ts
import { describe, expect, test } from "bun:test";
import {
  renderTranscript,
  TOOL_CALL_INSTRUCTION,
  TOOL_CALL_REQUIRED_INSTRUCTION,
  toolCallForcedInstruction,
} from "./renderer.ts";

const WEATHER_TOOLS = [
  { type: "function" as const, function: { name: "get_weather", parameters: { type: "object" } } },
];

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

  test("content-parts array renders as joined text", () => {
    const out = renderTranscript(
      [
        {
          role: "user",
          content: [
            { type: "text", text: "hello " },
            { type: "text", text: "world" },
          ],
        },
      ],
      [],
    );
    expect(out).toContain("[user]\nhello world");
  });

  test("content-parts array renders only the text parts", () => {
    const out = renderTranscript(
      [
        {
          role: "user",
          content: [
            { type: "text", text: "describe this" },
            { type: "image_url", image_url: { url: "https://example.com/x.png" } } as never,
          ],
        },
      ],
      [],
    );
    expect(out).toContain("[user]\ndescribe this");
    expect(out).not.toContain("example.com");
  });

  test("system-only transcript has no empty conversation gap", () => {
    const out = renderTranscript([{ role: "system", content: "be nice" }], []);
    expect(out).not.toContain("\n\n\n");
  });

  test("assistant with both content and tool_calls renders both", () => {
    const out = renderTranscript(
      [
        {
          role: "assistant",
          content: "let me check",
          tool_calls: [
            {
              id: "call_9",
              type: "function",
              function: { name: "get_weather", arguments: "{}" },
            },
          ],
        },
      ],
      [],
    );
    expect(out).toContain("[assistant]\nlet me check");
    expect(out).toContain("[assistant tool_call call_9]");
  });

  test("tool message without tool_call_id renders for unknown", () => {
    const out = renderTranscript([{ role: "tool", content: "result" }], []);
    expect(out).toContain("[tool result for unknown]");
  });

  test("forced-function tool_choice renders a name-specific instruction", () => {
    const out = renderTranscript([{ role: "user", content: "weather?" }], WEATHER_TOOLS, {
      type: "function",
      function: { name: "get_weather" },
    });
    expect(out).toContain('"name": "get_weather"');
    expect(out).toContain("You MUST respond");
    expect(out).toContain("get_weather");
    expect(out).not.toContain(TOOL_CALL_INSTRUCTION);
  });

  test("required tool_choice renders the forced-call instruction", () => {
    const out = renderTranscript(
      [{ role: "user", content: "weather?" }],
      WEATHER_TOOLS,
      "required",
    );
    expect(out).toContain('"name": "get_weather"');
    expect(out).toContain(TOOL_CALL_REQUIRED_INSTRUCTION);
    expect(out).not.toContain(TOOL_CALL_INSTRUCTION);
  });

  test("none tool_choice suppresses schemas and every instruction", () => {
    const out = renderTranscript([{ role: "user", content: "weather?" }], WEATHER_TOOLS, "none");
    expect(out).not.toContain('"name": "get_weather"');
    expect(out).not.toContain(TOOL_CALL_INSTRUCTION);
    expect(out).not.toContain(TOOL_CALL_REQUIRED_INSTRUCTION);
    expect(out).not.toContain("You MUST respond");
  });

  test("toolCallForcedInstruction embeds the given name JSON-quoted", () => {
    const out = toolCallForcedInstruction("extract");
    // The name appears quoted both in the prose mention and the JSON example.
    expect(out.split('"extract"').length - 1).toBeGreaterThanOrEqual(2);
    expect(out).toContain("You MUST respond");
  });
});
