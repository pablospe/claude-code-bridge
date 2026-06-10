# Acceptance smoke: ccb api (real claude) consumed through litellm.
# Run: see docs/SMOKE.md "OpenAI facade" section.
import sys

import litellm

# Assumes ccb api started WITHOUT --api-key (the "ccb" placeholder is ignored then).
BASE = "http://127.0.0.1:18485/v1"


def main() -> int:
    resp = litellm.completion(
        model="openai/ccb-claude",
        api_base=BASE,
        api_key="ccb",
        messages=[{"role": "user", "content": "Reply with exactly the word: pong"}],
    )
    content = resp.choices[0].message.content or ""
    print(f"non-streaming reply: {content!r}")
    if "pong" not in content.lower():
        print("FAIL: expected 'pong' in reply")
        return 1

    chunks = []
    for chunk in litellm.completion(
        model="openai/ccb-claude",
        api_base=BASE,
        api_key="ccb",
        messages=[{"role": "user", "content": "Reply with exactly the word: pong"}],
        stream=True,
    ):
        delta = chunk.choices[0].delta.content
        if delta:
            chunks.append(delta)
    streamed = "".join(chunks)
    print(f"streamed reply: {streamed!r}")
    if "pong" not in streamed.lower():
        print("FAIL: expected 'pong' in streamed reply")
        return 1

    print("OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
