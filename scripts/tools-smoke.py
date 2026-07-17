#!/usr/bin/env python3
"""Acceptance smoke: tool-enabled `ccb api` (--allow-tools) via the openai SDK.

Prereq: start the server from the REPO ROOT so README.md is in its cwd:

    bun apps/ccb/src/cli.ts api --allow-tools Read,Bash

(or the published `ccb api --allow-tools Read,Bash`). The session acts on the
directory where `ccb api` was started, so README.md must be there.

This exercises the M5 permission relay through the facade:
  1. An ALLOWED tool (Read) is pre-approved — claude reads README.md and we
     assert the reply carries repo-identifying content.
  2. A DENIED tool (Write) prompts, the policy auto-denies it, and the turn
     degrades to text instead of erroring — we assert it finishes gracefully.

Assumes the server was started WITHOUT --api-key (the "ccb" placeholder is
ignored then). Prompts are kept robust to phrasing; assertions check
substrings / finish_reason, not exact text.
"""
import os
import sys

try:
    from openai import OpenAI
except ImportError:
    print("FAIL: openai SDK not importable; `pip install openai` first")
    sys.exit(1)

BASE = "http://127.0.0.1:18485/v1"
DENIED_TARGET = "ccb-smoke-should-not-exist.txt"


def main() -> int:
    client = OpenAI(base_url=BASE, api_key="ccb")

    # 1. ALLOWED tool (Read): read README.md and report the first heading.
    print("[1/2] allowed tool (Read README.md)...")
    allowed = client.chat.completions.create(
        model="ccb-claude",
        messages=[{
            "role": "user",
            "content": (
                "Use your Read tool to read README.md in your current working "
                "directory and tell me what the first heading / title says. "
                "Quote it."
            ),
        }],
    )
    content = allowed.choices[0].message.content or ""
    finish = allowed.choices[0].finish_reason
    print(f"  finish_reason={finish} reply={content[:200]!r}")
    # A real Read-tool turn ends with a normal stop; a hallucinated answer that
    # never invoked the tool is less likely to also produce finish_reason=stop.
    if finish != "stop":
        print(f"FAIL: allowed tool turn should finish with stop, got {finish!r}")
        return 1
    low = content.lower()
    if "bridge" not in low and "claude-code-bridge" not in low:
        print("FAIL: expected repo-identifying content (bridge) in the reply")
        return 1

    # 2. DENIED tool (Write/Edit): ask to create a file; expect graceful text
    # AND that the file was never actually written (the policy denied it).
    print("[2/2] denied tool (Write a file)...")
    if os.path.exists(DENIED_TARGET):
        os.remove(DENIED_TARGET)
    denied = client.chat.completions.create(
        model="ccb-claude",
        messages=[{
            "role": "user",
            "content": (
                f"Use your Write tool to create a file named {DENIED_TARGET} "
                "with the text 'hello'. If you are not permitted to write "
                "files, just reply with the single word DENIED instead."
            ),
        }],
    )
    dcontent = denied.choices[0].message.content or ""
    dfinish = denied.choices[0].finish_reason
    print(f"  finish_reason={dfinish} reply={dcontent[:200]!r}")
    if dfinish not in ("stop", "length"):
        print(f"FAIL: denied tool should degrade to text, got finish_reason={dfinish!r}")
        return 1
    # The hard signal: the denied Write must NOT have created the file.
    if os.path.exists(DENIED_TARGET):
        print(f"FAIL: denied Write tool actually created {DENIED_TARGET}")
        os.remove(DENIED_TARGET)
        return 1
    # Best-effort: phrasing varies, so a denial word is a soft signal only.
    if "deni" not in dcontent.lower() and "not permitted" not in dcontent.lower():
        print("  note: reply carried no explicit denial word (phrasing varies)")

    print("SMOKE OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
