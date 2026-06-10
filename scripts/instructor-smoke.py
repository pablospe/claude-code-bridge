# Structured-output smoke: ccb api (real claude) consumed through the
# Instructor library's default TOOLS mode (forced tool_choice).
# Assumes ccb api started WITHOUT --api-key (the "ccb" placeholder is ignored then).
# Run: see docs/SMOKE.md "OpenAI facade" section.
import sys

import instructor
from openai import OpenAI
from pydantic import BaseModel

BASE = "http://127.0.0.1:18485/v1"


class UserInfo(BaseModel):
    name: str
    age: int


def main() -> int:
    client = instructor.from_openai(
        OpenAI(base_url=BASE, api_key="ccb"),
        mode=instructor.Mode.TOOLS,
    )
    user = client.chat.completions.create(
        model="ccb-claude",
        response_model=UserInfo,
        messages=[{"role": "user", "content": "John Doe is 30 years old."}],
    )
    print(f"extracted: name={user.name!r} age={user.age}")
    if user.name != "John Doe" or user.age != 30:
        print("FAIL: expected name='John Doe', age=30")
        return 1
    print("OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
