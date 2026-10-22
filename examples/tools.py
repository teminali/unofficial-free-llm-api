"""Tool calling through the bridge. pip install openai

The model is asked, in words, for a call in a plain format, and it comes back as ordinary tool_calls. Validate the arguments: this is a prompt, not a native feature.
"""
import json
import os

from openai import OpenAI

client = OpenAI(base_url=os.environ.get("ULA_BASE", "http://localhost:8420/v1"), api_key=os.environ["ULA_KEY"])
model = os.environ.get("MODEL", "deepseek-chat")

tools = [{
    "type": "function",
    "function": {
        "name": "get_weather",
        "description": "Current weather for a city",
        "parameters": {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]},
    },
}]


def get_weather(city: str) -> str:
    return f"31C and clear in {city}"  # a real tool would look it up


messages = [{"role": "user", "content": "What is the weather in Dar es Salaam?"}]
first = client.chat.completions.create(model=model, messages=messages, tools=tools)
message = first.choices[0].message

if message.tool_calls:
    messages.append(message)
    for call in message.tool_calls:
        args = json.loads(call.function.arguments)
        messages.append({"role": "tool", "tool_call_id": call.id, "content": get_weather(**args)})
    final = client.chat.completions.create(model=model, messages=messages, tools=tools)
    print(final.choices[0].message.content)
else:
    print(message.content)
