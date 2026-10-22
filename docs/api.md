# API reference

Base URL: `http://localhost:8420/v1` (the port is `--port`). Every route except `/health` needs a key:
`Authorization: Bearer sk-ula-...` (or `x-api-key: sk-ula-...`). Make keys on the **API** page, or with
`unofficial-llm-api key create`. A key is shown once and stored only as a hash. (With `--no-key` on loopback, no key is needed, but the body must be
sent as `Content-Type: application/json` and a request from a browser page on another site is refused with `403 forbidden_origin`.)

## `GET /v1/models`

The models of the accounts that are linked and signed in right now. An expired or unlinked account lists nothing.

```json
{ "object": "list", "data": [
  { "id": "deepseek-chat", "object": "model", "created": 0, "owned_by": "deepseek", "name": "DeepSeek Chat" },
  { "id": "deepseek-reasoner", "object": "model", "created": 0, "owned_by": "deepseek", "name": "DeepSeek Reasoner", "reasoning": true }
] }
```

## `POST /v1/chat/completions`

| Field | Supported |
|---|---|
| `model` | an id from `/v1/models`, with or without its provider (`deepseek/deepseek-chat`). Left out: the first model there is |
| `messages` | `system`, `user`, `assistant` (with `tool_calls`) and `tool` messages. Text only: image parts are replaced by a note |
| `stream` | `true` for server-sent chunks ending in `data: [DONE]` |
| `stream_options.include_usage` | adds a last chunk with `usage` |
| `tools`, `tool_choice` | yes, see below. `tool_choice: "none"` sends the request as plain chat |
| `response_format` | `json_object` and `json_schema` are asked for in words; the chat is not forced into them |
| `reasoning_effort` | `low` / `medium` / `high` (`minimal` counts as low). Used by Gemini; ignored by DeepSeek |
| `temperature`, `top_p`, `max_tokens`, `stop`, `n`, `seed`, `user` | accepted and ignored: a web chat has no such controls |

### Answers

Not streaming:

```json
{ "id": "chatcmpl-ds-...", "object": "chat.completion", "model": "deepseek-reasoner",
  "choices": [{ "index": 0, "finish_reason": "stop",
    "message": { "role": "assistant", "content": "Forty-two.", "reasoning_content": "Let me work it out." } }],
  "usage": { "prompt_tokens": 12, "completion_tokens": 20, "total_tokens": 32, "completion_tokens_details": { "reasoning_tokens": 6 } } }
```

`usage` is an **estimate** (characters divided by four): the web chats report no token counts.

Streaming sends `chat.completion.chunk` events. The first has `delta.role`, thinking arrives as `delta.reasoning_content`, the answer as
`delta.content`, calls as `delta.tool_calls`, and the last has `finish_reason` (`stop` or `tool_calls`).

### Tool calls

Send `tools` as you would to OpenAI. The bridge shows the model your tool schemas and asks for a call in a plain format, then
returns it as `tool_calls` with `finish_reason: "tool_calls"`. Run the tool and send the result back as a `tool` message with the
`tool_call_id`, exactly as usual.

- Only tools you offered can be called; anything else the model writes stays text.
- The call is read out of the model's text, so a model that quotes a call, or repeats one it found in a tool result, can produce a real `tool_calls` entry. Keep your own approval step for tools that can do harm.
- A request with no tools is plain chat: nothing in its answer is read as a call.
- It is a prompt, not a native feature: a model can call the wrong tool or write arguments that do not match the schema. Validate them.
- A reply that holds about 20,000 characters is cut off by DeepSeek; a call cut inside its content is asked for again once with a note to keep it shorter, then reported as `deepseek_unreadable_tool_call`.

### Errors

OpenAI-shaped: `{ "error": { "message", "type", "param", "code" } }`.

| Status | `code` | Meaning |
|---|---|---|
| 400 | `invalid_messages`, `bad_body` | the request is not valid (the body must be a JSON object) |
| 403 | `forbidden_origin` | without keys: the request came from a page on another site |
| 415 | `unsupported_media_type` | without keys: the body was not sent as `application/json` |
| 401 | `invalid_api_key` | missing or wrong key |
| 401 | `<provider>_session_expired` | the account's sign-in expired: sign in again on the Accounts page |
| 404 | `model_not_found` | no linked model of that name; the message lists the ones there are |
| 409 | `<provider>_not_linked` | the provider is not linked |
| 413 | `bad_body` | the body is over 16 MB |
| 429 | `<provider>_cooldown`, `_daily_cap`, `_minute_cap`, `_queue_full` | the governor refused; nothing was sent upstream. `Retry-After` says when |
| 429 | `<provider>_rate_limited`, `<provider>_muted` | the provider itself refused. The pause is set; `Retry-After` is the pause |
| 502 | `<provider>_error`, `_empty_answer`, `_unreadable_tool_call` | the provider answered badly |
| 504 | `<provider>_timeout` | nothing arrived in time |

When the answer was already streaming, an error is sent as an `error` event before `[DONE]`.

A `429` is safe to retry after `Retry-After`: it is answered locally. Do not retry faster than that; a refused or muted account
only gets worse.

## Cross-origin calls

Off by default. `--cors https://app.example` (or `--cors "*"`) lets browser pages on those origins call `/v1` with a key.

## Health

`GET /health` answers `{ "ok": true, "version": "..." }` with no key.
