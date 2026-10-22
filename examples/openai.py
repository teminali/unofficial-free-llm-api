"""The official OpenAI Python SDK, pointed at the local server. pip install openai"""
import os

from openai import OpenAI, RateLimitError

client = OpenAI(base_url=os.environ.get("ULA_BASE", "http://localhost:8420/v1"), api_key=os.environ["ULA_KEY"])
model = os.environ.get("MODEL", "deepseek-chat")

# one answer
reply = client.chat.completions.create(model=model, messages=[{"role": "user", "content": "Say hello in five words."}])
print(reply.choices[0].message.content)

# streaming, with the thinking shown apart when the model has any (try MODEL=deepseek-reasoner)
try:
    for chunk in client.chat.completions.create(
        model=model,
        messages=[{"role": "user", "content": "Why is the sky blue? Two sentences."}],
        stream=True,
    ):
        delta = chunk.choices[0].delta
        thinking = getattr(delta, "reasoning_content", None)
        if thinking:
            print(f"\033[2m{thinking}\033[0m", end="", flush=True)
        if delta.content:
            print(delta.content, end="", flush=True)
    print()
except RateLimitError as err:
    # The account is paused to protect it (a cap, a cooldown, or the provider pushed back). Retry-After says when.
    print("paused:", err.message)
