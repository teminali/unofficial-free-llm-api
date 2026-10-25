# API reference

Base URL: `http://localhost:8420/v1` (the port is `--port`). Every route except `/health` needs a key:
`Authorization: Bearer sk-ula-...` (or `x-api-key: sk-ula-...`). Make keys on the **API** page, or with
`unofficial-free-llm-api key create`. Show a key again any time with the **Show** button on the API page or `unofficial-free-llm-api key show <id or name>` (keys made by 0.1.0 were stored as a hash only and cannot be shown: make a new one). (With `--no-key` on loopback, no key is needed, but the body must be
sent as `Content-Type: application/json` and a request from a browser page on another site is refused with `403 forbidden_origin`.)

Every answer carries an `X-Request-Id`. Fields the provider cannot honour are listed in an `X-ULA-Ignored` response header (for example `top_p, seed`),
never dropped silently. `temperature` is used by Bike4Mind and named there for the website providers, which have no such control.

## `GET /v1/models` and `GET /v1/models/{id}`

The models of the accounts that are linked and signed in right now. An expired or unlinked account lists nothing.

```json
{ "object": "list", "data": [
  { "id": "deepseek-chat", "object": "model", "created": 0, "owned_by": "deepseek", "name": "DeepSeek Chat", "context_length": 128000 },
  { "id": "deepseek-reasoner", "object": "model", "created": 0, "owned_by": "deepseek", "name": "DeepSeek Reasoner", "reasoning": true, "context_length": 128000 }
] }
```

`GET /v1/models/{id}` returns one entry of that list (the id, or `provider/id`), or `404 model_not_found`.

**`context_length`** is a working size this program chooses (128000 tokens), not the model's maximum: the chat websites publish no limits, and the figures that exist are for the developer APIs. Plan prompts around it. It is set in one place (`src/model_info.js`). Bike4Mind models are the exception: they list the context size its API reports.

`owned_by` is the provider id: `deepseek`, `gemini`, `qwen` or `bike4mind`.

**Gemini's list follows the account.** The names a client can rely on never go stale: `gemini` and `gemini-auto` are always listed and mean the mode the Gemini page is on (an account whose picker has a row called Auto gets that row under `gemini-auto`, and it is really chosen). After them come the rows the account's picker offers right now, for example `gemini-3-5-flash-lite` or `gemini-3-1-pro`; a row the account does not have is not listed. The picker is read again when the list is older than 15 minutes: on a real request, or in the background when a client lists the models (the answer is the list as it is; it is right the next time). `POST /_/providers/gemini/refresh-models` (admin) forces a read. A locked row is never listed.

**Qwen's list follows the account too.** Qwen has no fixed aliases: the ids are the ones your account offers, for example `qwen3.7-plus` or `qwen3.8-max`. The list is read when you link and refreshed in the background whenever a client lists the models (the answer is the list as it is; it is right the next time), so a model added to the account appears on the next listing. `POST /_/providers/qwen/refresh-models` (admin) or *Read models again* forces a read. A read that finds nothing keeps the old list.

**Bike4Mind's list is the one its API reports.** The ids are the ones `GET /api/v1/models` returns for your key (text models only), with the context size the API gives. The list is read when you link and refreshed in the background whenever a client lists the models; `POST /_/providers/bike4mind/refresh-models` (admin) or *Read models again* forces a read. The Accounts page marks which models take tools, pictures and thinking; a request that offers tools to a model marked as not supporting them is refused with `400 bike4mind_error` before anything is spent.

## `POST /v1/chat/completions`

| Field | Supported |
|---|---|
| `model` | an id from `/v1/models`, with or without its provider (`deepseek/deepseek-chat`). Left out: the first model there is |
| `messages` | `system`, `user`, `assistant` (with `tool_calls`) and `tool` messages. Pictures: on DeepSeek an image part with a `data:` URL is attached to the message as a file (the newest four, up to 10 MB each, `png`/`jpeg`/`gif`/`webp`); on Bike4Mind, when the model supports vision, it goes as a native image part (up to 8, 10 MB each, 20 MB of base64 in one request); on Gemini and Qwen, in the Anthropic and Responses APIs and for a picture given as an address, the part is replaced by a note |
| `stream` | `true` for server-sent chunks ending in `data: [DONE]` |
| `stream_options.include_usage` | adds a last chunk with `usage` |
| `tools`, `tool_choice` | yes, see below. `tool_choice: "none"` sends the request as plain chat |
| `response_format` | `json_object` and `json_schema` are asked for in words; the chat is not forced into them |
| `reasoning_effort` | `low` / `medium` / `high` (`minimal` counts as low). Used by Gemini and Bike4Mind; ignored by DeepSeek and Qwen |
| `user`, header `X-ULA-Session` | names the conversation, so two conversations that begin alike keep their own provider chats (see Sessions) |
| `n` | must be 1 (anything else is `400 unsupported_parameter`) |
| `max_tokens` / `max_completion_tokens`, `stop` (a string or up to four) | done here, for a request **with no tools**: the answer is cut at the size (a token is estimated as four characters) or at the first stop string, `finish_reason` says `length` or `stop`, and while streaming the provider is told to stop sending. With `tools` they are ignored (a cut through a tool call is a broken call) and named in `X-ULA-Ignored` |
| `temperature` | used by Bike4Mind, between 0 and 2; accepted and ignored by the website providers, and named in `X-ULA-Ignored` for them |
| `top_p`, `seed`, `frequency_penalty`, `presence_penalty`, `logit_bias`, `logprobs` | accepted and ignored: the providers have no such controls here; the ones you sent are named in `X-ULA-Ignored` |

A message whose `role` is not `system` (or `developer`), `user`, `assistant` or `tool` is `400 invalid_messages`.

### Answers

Not streaming:

```json
{ "id": "chatcmpl-ds-...", "object": "chat.completion", "model": "deepseek-reasoner",
  "choices": [{ "index": 0, "finish_reason": "stop",
    "message": { "role": "assistant", "content": "Forty-two.", "reasoning_content": "Let me work it out." } }],
  "usage": { "prompt_tokens": 12, "completion_tokens": 20, "total_tokens": 32, "completion_tokens_details": { "reasoning_tokens": 6 } } }
```

`usage` is an **estimate** (characters divided by four), the same for every provider: the website chats report no token counts, and the answer keeps one shape.

Streaming sends `chat.completion.chunk` events. The first has `delta.role`, thinking arrives as `delta.reasoning_content`, the answer as
`delta.content`, calls as `delta.tool_calls`, and the last has `finish_reason` (`stop` or `tool_calls`).

### Tool calls

Send `tools` as you would to OpenAI. On DeepSeek, Gemini and Qwen the bridge shows the model your tool schemas and asks for a call in a plain format, then
returns it as `tool_calls` with `finish_reason: "tool_calls"`. On Bike4Mind the tools go natively, in the shape its API documents, and a native `tool_use` event
becomes the same `tool_calls`. Run the tool and send the result back as a `tool` message with the `tool_call_id`, exactly as usual.

- Only tools you offered can be called; anything else the model writes stays text.
- On the website providers, the call is read out of the model's text, so a model that quotes a call, or repeats one it found in a tool result, can produce a real `tool_calls` entry. Keep your own approval step for tools that can do harm.
- A request with no tools is plain chat: nothing in its answer is read as a call.
- On the website providers it is a prompt, not a native feature: a model can call the wrong tool or write arguments that do not match the schema. Bike4Mind is native, but the model can still choose the wrong tool or arguments. Validate them either way.
- On DeepSeek, a reply that holds about 20,000 characters is cut off; a call cut inside its content is asked for again once with a note to keep it shorter, then reported as `deepseek_unreadable_tool_call`.

### Sessions

A web chat remembers its conversation; an API request repeats it. The bridge puts the two together: a request whose first messages are exactly the ones an open
chat already holds (compared by hash; nothing of the text is kept) goes into that chat and carries only its new messages. Anything that does not fit starts a new
chat. What makes a request a different conversation: another model, other `tools`, another system prompt, an earlier message that was changed or dropped, or a
different `user` / `X-ULA-Session` name. The usage numbers still count the whole conversation, as any API would.

Chats are closed after 20 minutes without a request, when more than 6 are open, when one grows past about 150,000 characters or 80 requests, and when the program
stops. DeepSeek and the Qwen chats this program created are deleted; a Gemini chat stays in your Gemini history, and Qwen chats this program did not create are
never touched. Turn this off with `--no-sessions`, `ULA_SESSIONS=0` or the switch on the Accounts page. Bike4Mind has no chat on its side: its API takes the
whole conversation on every call, so sessions do not apply there.

### Errors

OpenAI-shaped: `{ "error": { "message", "type", "param", "code" } }`.

| Status | `code` | Meaning |
|---|---|---|
| 400 | `invalid_messages`, `bad_body`, `unsupported_parameter` | the request is not valid (the body must be a JSON object; `n` must be 1; a message role is unknown) |
| 400 | `<provider>_error` | a permanent refusal: a model that does not call tools was sent some, a key has no credits left, or the provider said the request is invalid. It is not retried |
| 403 | `forbidden_origin` | without keys: the request came from a page on another site |
| 403 | `<provider>_verification_required` | the provider asked for a human check (Qwen's browser verification). Nothing was retried; the lane is paused and the check is yours to complete |
| 415 | `unsupported_media_type` | without keys: the body was not sent as `application/json` |
| 401 | `invalid_api_key` | missing or wrong key |
| 401 | `<provider>_session_expired` | the account's sign-in expired, or Bike4Mind refused the key: sign in again, or paste a new key, on the Accounts page |
| 404 | `model_not_found` | no linked model of that name; the message lists the ones there are |
| 404 | `previous_response_not_found` | `/v1/responses`: the response is not remembered (memory only, 30 minutes) |
| 409 | `<provider>_not_linked` | the provider is not linked |
| 413 | `bad_body` | the body is over 16 MB |
| 429 | `<provider>_cooldown`, `_daily_cap`, `_minute_cap`, `_queue_full` | the governor refused; nothing was sent upstream. `Retry-After` says when |
| 429 | `<provider>_rate_limited`, `<provider>_muted` | the provider itself refused. The pause is set; `Retry-After` is the pause |
| 502 | `<provider>_error`, `_empty_answer`, `_unreadable_tool_call` | the provider answered badly |
| 504 | `<provider>_timeout` | nothing arrived in time |

When the answer was already streaming, an error is sent as an `error` event before `[DONE]`.

A `429` is safe to retry after `Retry-After`: it is answered locally. Do not retry faster than that; a refused or muted account
only gets worse.

## `POST /v1/responses` (OpenAI Responses API)

`model`, `input` (a string, or items: `message`, `function_call`, `function_call_output`), `instructions`, `tools` (type `function`), `tool_choice: "none"`,
`reasoning.effort`, `max_output_tokens` (honoured as above), `text.format` (`json_object`, `json_schema`), `stream`, `previous_response_id` and `store`. The answer has the
`output` items `reasoning`, `message` and `function_call`; a stream sends OpenAI's events (`response.created`, `response.output_text.delta`,
`response.function_call_arguments.done`, `response.completed`, ...). `previous_response_id` works for responses this server made and still remembers: they are
kept **in memory only**, for 30 minutes, at most 64, and not at all with `store: false`; an unknown id is `404 previous_response_not_found`.

## `POST /v1/messages` and `POST /v1/messages/count_tokens` (Anthropic Messages API)

`model`, `max_tokens` (honoured as above), `system` (a string or text blocks), `messages` (text, `tool_use` and `tool_result` blocks; thinking blocks are dropped), `tools`
(`name`, `description`, `input_schema`), `tool_choice: {"type": "none"}`, `thinking` (its `budget_tokens` picks Gemini's thinking level), `stop_sequences` (honoured as above),
`stream` and `metadata.user_id` (names the conversation). The key can go in `x-api-key`. The answer is a `message` with `thinking`, `text` and `tool_use` blocks and a
`stop_reason` (`end_turn`, `tool_use`); a stream sends `message_start`, `content_block_start`, `content_block_delta`, `content_block_stop`, `message_delta` and
`message_stop`. Errors are `{ "type": "error", "error": { "type", "message" } }`. `count_tokens` returns `{ "input_tokens" }` (an estimate) and sends nothing to the provider.

Both are translations of the same engine: the same governor, the same pace and caps, the same sessions and the same tool bridge as `/v1/chat/completions`.

## Cross-origin calls

Off by default. `--cors https://app.example` (or `--cors "*"`) lets browser pages on those origins call `/v1` with a key.

## Health

`GET /health` answers `{ "ok": true, "version": "..." }` with no key.
