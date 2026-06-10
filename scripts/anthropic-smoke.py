# Anthropic-dialect smoke: ccb api consumed through the official anthropic SDK.
# Assumes ccb api started WITHOUT --api-key (the "ccb" placeholder is ignored then).
# Run: see docs/SMOKE.md "OpenAI facade" section.
import sys

from anthropic import Anthropic

BASE = "http://127.0.0.1:18485"


def main() -> int:
    client = Anthropic(api_key="ccb", base_url=BASE)

    # 1. Non-streaming
    msg = client.messages.create(
        model="ccb-claude",
        max_tokens=1024,
        messages=[{"role": "user", "content": "Reply with exactly the word: pong"}],
    )
    text = msg.content[0].text if msg.content and msg.content[0].type == "text" else ""
    print(f"non-streaming reply: {text!r} stop_reason={msg.stop_reason}")
    if "pong" not in text.lower():
        print("FAIL: expected 'pong' in reply")
        return 1

    # 2. Streaming
    chunks = []
    with client.messages.stream(
        model="ccb-claude",
        max_tokens=1024,
        messages=[{"role": "user", "content": "Reply with exactly the word: pong"}],
    ) as stream:
        for delta in stream.text_stream:
            chunks.append(delta)
        final = stream.get_final_message()
    streamed = "".join(chunks)
    print(f"streamed reply: {streamed!r} stop_reason={final.stop_reason}")
    if "pong" not in streamed.lower():
        print("FAIL: expected 'pong' in streamed reply")
        return 1

    # 3. Tool use round trip
    tools = [{
        "name": "get_weather",
        "description": "Get current weather for a city.",
        "input_schema": {"type": "object", "properties": {"city": {"type": "string"}}},
    }]
    first = client.messages.create(
        model="ccb-claude",
        max_tokens=1024,
        messages=[{"role": "user", "content": "What is the weather in Paris? Use the tool."}],
        tools=tools,
        tool_choice={"type": "tool", "name": "get_weather"},
    )
    tool_use = next((b for b in first.content if b.type == "tool_use"), None)
    if tool_use is None or first.stop_reason != "tool_use":
        print(f"FAIL: expected tool_use, got {first.stop_reason} / {first.content}")
        return 1
    print(f"tool call: {tool_use.name}({tool_use.input})")
    if tool_use.input.get("city") != "Paris":
        print("FAIL: expected city=Paris")
        return 1
    second = client.messages.create(
        model="ccb-claude",
        max_tokens=1024,
        messages=[
            {"role": "user", "content": "What is the weather in Paris? Use the tool."},
            {"role": "assistant", "content": [b.model_dump() for b in first.content]},
            {"role": "user", "content": [{
                "type": "tool_result",
                "tool_use_id": tool_use.id,
                "content": '{"temp_c": 18, "sky": "sunny"}',
            }]},
        ],
        tools=tools,
    )
    answer = second.content[0].text if second.content and second.content[0].type == "text" else ""
    print(f"final answer: {answer!r}")
    if "18" not in answer:
        print("FAIL: expected the tool result (18) reflected in the answer")
        return 1

    print("OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
