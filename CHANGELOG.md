# Changelog

## 0.8.0 (2026-10-27)

### Added

- **Pictures on Qoder.** A picture sent inline goes to the model as an image block of the CLI's stream-json input, right after its `[attached image N]` marker, in a
  kept chat and in a one-off run alike; a follow-up sends only the pictures of its new messages. The newest four of a message go (10 MB each), and one left out is
  named in the prompt. Every model the CLI listed on 2026-10-27 (DeepSeek, Qwen, Kimi, GLM, MiniMax, Auto, Efficient) read the heading of a test screenshot this way;
  `--attachment` was tried and is not used, because it hands the model a file path that all but one model try to open with a tool. Qoder models now say
  `supportsVision: true`. A CLI that refuses `--input-format` is sent the words and a note that the pictures did not go.
- **Files.** A text file sent inline (a chat `file` part, a Responses `input_file`, an Anthropic `document`) is written into the prompt under its name, for every
  provider, up to 200,000 characters. Any other file (a PDF, an archive, one named by id or address) is named in the prompt as left out. Before, a file part vanished
  without a word.

### Fixed

- The Anthropic Messages and OpenAI Responses APIs passed pictures on as "[image omitted by the bridge]" even to a provider that takes them; they now pass the
  picture (also inside a tool result), so DeepSeek and Qoder see it whichever API the client speaks.

## 0.7.0 (2026-10-26)

### Changed

- **Qoder keeps one chat per conversation.** The first request of a conversation starts one `qoder --print` process with its input held open; each follow-up goes in as
  one new message, so the CLI's startup is paid once instead of on every call. Follow-ups are also given only the new messages, not the whole transcript. At most three
  chats are kept, each closed after ten idle minutes, twenty-four requests or 150,000 characters; a request that changes the model, the effort, the tools or an earlier
  message starts a new process. The chat lives in that process only: `--no-session-persistence` is still passed, so no transcript is written to disk, and stopping the
  program, unlinking or linking a different token closes the chats. A CLI that refuses the stream-json input falls back to one process per request for that run.
  `--no-sessions`, `ULA_SESSIONS=0` or the Accounts page switch keeps the old behaviour. The kept-chat path is covered by `test/qoder_warm.test.js` against the stand-in CLI.

## 0.6.0 (2026-10-26)

### Added

- **Qoder, through its official CLI.** A second provider beside DeepSeek, linked with a personal access token made at `qoder.com/account/integrations`; nothing opens a
  browser, so it works on a machine with no desktop. Qoder's model server cannot be called with a personal token from outside its own client (the catalog and
  the model calls are signed by the CLI's handshake), so every request drives the installed official CLI (`npm install -g @qoder-ai/qodercli`) as one
  `qoder --print` process. The token is kept on this computer, in `qoder_key.json` (0600), and handed only to that process, in its environment; it is never
  on a command line and never logged. A token the CLI refuses is marked refused until it is replaced.
- **Models from the account, with stable ids.** Every model the CLI lists becomes an offered id prefixed `qoder-` (`qoder-qwen3-7-max`), so a Qwen or Kimi
  model Qoder offers cannot be mistaken for another provider's; the request sends the key the CLI printed. The list is read when you link, reused for ten
  minutes, and can be forced with *Read models again* or `POST /_/providers/qoder/refresh-models`. A list in a shape the bridge does not read is an error,
  never a guessed list.
- **Thinking and effort through the CLI's own flags.** `low`/`medium`/`high`/`xhigh`/`max` become `--reasoning-effort`, `none` becomes `--thinking disabled`,
  and a model whose thinking cannot be switched off is asked with `--thinking enabled` when no effort was given. The stream-json output with partial messages
  is read when the CLI knows it, so text and thinking stream as they arrive; a CLI that refuses those flags is asked again for the plain JSON envelope.
- **An honest tool bridge.** The CLI has no native tool handoff, so tools go in the prompt as the text protocol the account-backed providers use and the calls
  are read back into `tool_calls`. The CLI run is text only: a picture is replaced by a note, and `temperature` has no flag, so it is named in `X-ULA-Ignored`.
- **An isolated, scrubbed child.** The CLI runs in its own `qoder-cli/` folder (0700) inside the data folder, so a Qoder login that already exists on the computer
  is neither read nor changed; `QODER_*`, `QODERCN_*`, `CLAUDE_CODE_*` and `GEMINI_*` variables are removed from its environment first, so a Qoder Desktop
  session cannot break it. The token is scrubbed from anything the CLI says before it is logged.
- `reasoning_effort` now accepts and passes through `none`, `xhigh` and `max` where a provider understands them; Anthropic's `thinking: {"type": "disabled"}`
  becomes `reasoning_effort: "none"`. `/v1/models` advertises `reasoning: true` for reasoning models, including those whose thinking can be switched off, and the Accounts page takes the
  key field's hint and example from the provider instead of naming one provider's key format.

### Removed

- **Qwen, Gemini and Bike4Mind are gone.** The owner retired them as unstable: the two site lanes broke whenever Alibaba or Google changed their pages,
  and all three took upkeep that the DeepSeek and Qoder lanes do not. Their modules, tests, stand-ins, settings, default load order and documentation are removed,
  and `--providers` now loads DeepSeek and Qoder by default. A `config.json` that names a removed provider still starts: the unknown name is ignored. The
  DeepSeek lane is unchanged. This is a breaking change for anyone who used one of the three.

### Not covered

- The Qoder lane has been run live with a real token on 2026-10-26: its model list was read and chat completions came back with thinking on and off. The lane is
  also tested against `test/fixtures/fake_qoder_cli.js`, a script shaped from how the installed CLI answers: its model list, its JSON envelope and its
  stream-json events, and each way it refuses. If the live CLI starts answering differently, the stand-in needs the difference.
- Qoder has no chat on its side: every call is a new CLI process, the conversation travels as one prompt, and tools are read from text.

## 0.5.0 (2026-10-25)

### Added

- **Bike4Mind, through its own official API.** A fourth provider, and the one place this program accepts a developer API key: make one in your Bike4Mind account
  and paste it on the Accounts page. Nothing opens a browser, so it works on a machine with no desktop. The consent box says what it means before the key is sent:
  the key stays on this computer, requests go only to `app.bike4mind.com`, and every request spends that account's credits. A refused key, or one without the
  `ai:chat` scope, is not saved.
- **Models, limits and credits from the API.** The model list is read when you link (cursor pages, text models only) and carries each model's real context size,
  output limit, and whether it takes tools, pictures and thinking. The credit balance is shown on the Accounts card: read at linking, with *Read models again*,
  after each request's own credit event, and again after ten quiet minutes. *Read models again* and the background refresh work as they do for Gemini and Qwen.
- **Native tools, pictures and thinking.** Tools go to the API in its own `tools: [{ toolSchema }]` shape, and a native `tool_use` event becomes the same
  `tool_calls` a client already receives. A model that says it does not call tools refuses a request that offers them before anything is spent. Inline pictures go
  as native image parts when the model supports vision (up to 8, 10 MB each, 20 MB of base64 in one request); a model without vision, or a picture over the limits,
  is told in the prompt. `reasoning_effort` and a thinking request are sent in the API's own `options`.
- **The stream is read as the API sends it.** Bike4Mind answers with server-sent events whether or not the caller asked to stream. `content` events may carry a
  delta or the whole answer so far, and thinking arrives as blocks; all are reduced to the new text. An in-band error ends the request in words. A model's own
  output limit becomes `finish_reason: "length"` instead of a silently short answer.
- `temperature` now reaches a provider that uses it (Bike4Mind); `X-ULA-Ignored` no longer names it for that provider. The other providers still ignore it, and
  the header still says so.

### Not covered

- **Not yet run against the real API.** No key has been spent on the live service. The lane is tested against `test/fixtures/fake_bike4mind.js`, a local server
  shaped from Bike4Mind's published OpenAPI document (cursor model pages, credits, the event stream and its errors). If the live API answers differently, the
  stand-in needs the difference.
- Bike4Mind has no `tool` role and ignores plain system prompts, so the conversation, including tool results, still travels as one transcript in a `user` message;
  only the tools are native. A conversation is not kept on Bike4Mind's side between calls.

## 0.4.0 (2026-10-24)

### Added

- **Pictures on DeepSeek.** A picture sent inline in a chat completion (`image_url` with a `data:` URL, in a user message or a tool result) is attached to the
  message the way the web app attaches a file: a proof-of-work for the upload path, a multipart upload, a wait until DeepSeek has read the file, and its id in
  `ref_file_ids` of the completion. Before, every picture became the words "[image omitted by the bridge]" and the model answered without it.
  The newest four pictures of a message go (10 MB each); the same picture is uploaded once and kept for 15 minutes; a chat that continues is sent only the
  pictures of its new messages, and a picture keeps its number (`[attached image N]`) through the whole conversation.
- A picture that cannot go (refused, empty, failed, too large, over the four) is said in the prompt ("Note from the bridge: image 2: ...; those pictures are NOT
  visible to you"), so the model tells the person instead of guessing. A refused sign-in, a rate limit or a mute during an upload ends the request like they do anywhere else.
- Two messages that differ only in their picture are no longer taken for the same message when a conversation is matched to its open chat.

### Not covered

- Gemini and Qwen, the Anthropic and Responses APIs, and a picture given as an address (the bridge never fetches an address a client names) still become a note.
- **Not yet run against the real site.** The upload follows the file endpoints of DeepSeek's web app (`/api/v0/file/upload_file`, `/api/v0/file/fetch_files`) as the stand-in
  in `test/fixtures/fake_deepseek.js` answers them; if the site answers differently, the picture is reported in the prompt as not sent and the question is still answered.
  What DeepSeek's chat does with an attached picture (read the text in it, or look at it) is decided by DeepSeek.

## 0.3.0 (2026-10-23)

### Added

- **Qwen.** A third provider, through chat.qwen.ai in a Chrome window that has its own profile (`qwen-chrome`). Requests are typed into the page's real
  message box and sent with one Send click; the request and its stream are read from the page, not rebuilt. Qwen's model list follows the account (there is no
  fixed alias), is read when you link, and is refreshed in the background when a client lists the models or with *Read models again*. The lane is built to fail
  closed: the outgoing request is checked for the exact message, model, account and conversation before an answer is accepted, a cancelled request is not retried,
  and the draft is put back when a send did not go out.
- **Qwen sessions.** One chat per conversation, created through the normal composer. Only chats this program created are tracked (`chats-qwen.json`, ids only) and
  removed when their conversation ends; your other Qwen chats are never touched. `--no-sessions` still means a new chat for every request.
- **Qwen governor.** 100 requests a day by default, at least 10 seconds apart, 6 a minute, with a 20-minute pause after a refusal or a browser verification.
  Qwen's browser check is never passed for you: the request stops, the lane pauses, and you complete the check yourself.
- **`403 <provider>_verification_required`** is now a named error, so a client can tell a human check from a rate limit.
- Docs, the landing page and the issue template now cover the third provider, its limits and what has actually been run.

### Changed and fixed

- The default providers are `deepseek,gemini,qwen`. Existing links and settings are unchanged.
- `GET /v1/models` asks any provider that can refresh its model list to do so in the background, so a newly added or removed Qwen model appears on the next
  listing instead of waiting for a TTL. Gemini keeps its 15-minute window.
- The Accounts page and the playground footer name Qwen, and *Read models again* works for both Gemini and Qwen.

### Known

- **Qwen has no automated stand-in test.** Its lane was verified live on 2026-10-23 with Qwen3.7-Plus: a new chat (about 24 s for the first answer), a follow-up
  that stayed in the same chat (about 5 s), a cancellation that left no retry and restored the draft, and a recovery that opened a replacement chat. Agents,
  long conversations and the no-desktop setup are not tested on Qwen.
- Qwen can return a model's daily limit as ordinary answer text (Qwen3.8-Max did). It is not detected, not retried and not switched to another model.
- Qwen's Chrome window stays open while the program runs, because requests go through that page.

## 0.2.0 (2026-10-22)

**Renamed.** The package is now `unofficial-free-llm-api` (it was `unofficial-llm-api`), the command is `unofficial-free-llm-api` (the short `ula` stays), and the
data folder is `~/.unofficial-free-llm-api`. A `~/.unofficial-llm-api` made by 0.1.x keeps being used while the new folder does not exist, so nothing needs moving.
The old npm package is deprecated and points here.

### Added

- **One chat per conversation (sessions).** A request that continues a conversation goes into the same provider chat and carries only what is new; anything that is
  not a clean continuation starts a new chat. Chats are removed when the conversation has been quiet for 20 minutes, when more than 6 are open, when one grows long,
  and when the program stops. Their ids are written down (never their words), so a chat left by a program that was killed is removed at the next start. If continuing
  fails twice in a row it switches itself off and says so. `--no-sessions` (or `ULA_SESSIONS=0`) goes back to a new chat for every request.
- **Two more APIs:** Anthropic's Messages API (`POST /v1/messages`, `POST /v1/messages/count_tokens`) and OpenAI's Responses API (`POST /v1/responses`, with
  `previous_response_id`).
- **`max_tokens` and `stop`** are honoured for a plain chat; settings a web chat cannot take are named in an `X-ULA-Ignored` header.
- **`doctor`** (checks Node, Chrome, the data folder, the port and the accounts), **`selftest`** (sends a short conversation through a running server and says
  whether it stayed in one provider chat) and **`log`** (the last lines the providers logged, with no prompts and no answers).
- **Models:** every model lists a `context_length` (128000, a working size, not the model's maximum). Gemini always lists `gemini` and `gemini-auto`, follows the
  account's own picker, and re-reads it when it is 15 minutes old or when asked (*Read models again* on the Accounts page, or `POST /_/providers/gemini/refresh-models`).
- **Web interface:** a box on the API page that copies the name, address, models and context size for clients with a form to fill in, a Context column, accessible
  names and live regions, light and dark themes that follow the system, and a layout checked at 320, 390, 820 and 1280 px.
- **A landing page** (`site/`, published with GitHub Pages) and this changelog.

### Changed and fixed

- **DeepSeek.** The sign-in check opens an ordinary Chrome window (DeepSeek answers a hidden one with a "request blocked" page) and says in words when Chrome is
  refusing to keep site data. A connection that fails before a message is sent is tried once more; one that fails later is an error in words, never half an answer.
  A chat that could not be removed because of the network stays on the list and is removed when it can be. A proof-of-work of another kind is named and not worked on.
  A call that never left is no longer counted against the daily cap. The log says once, by event names only, how a real stream ends.
- **Gemini.** A conversation keeps its tab open between messages (a typical call went from 40 to 190 seconds down to 10 to 25), Gemini's own error messages are
  reported as failed requests instead of answers, a quick-reply control the page draws inside an answer is no longer read as part of it, a Chrome that another
  program is using on the profile is named as that, and `log` prints the request timeline of each call.
- The Playground's footer names every chat that holds the conversation when a model change has spread it over several.
- On a phone-width window the brand name wraps onto a second line when this computer's font is wider than the room, instead of being cut with an ellipsis.
- A Chrome that cannot open a window because the computer has no display (a server) says so and points to the token and copy-the-session routes, not "code 1".

### Known

- Gemini is slow and uneven through this lane (4 seconds to over a minute). The request is sent within a tenth of a second; the wait is Gemini's own answer. The
  README has the measurements and what was ruled out. This program does not hide that it is driven.
- An answer that DeepSeek's connection cuts off cleanly in the middle cannot yet be told from a finished one.
- Not yet run against a real account: an agent sending tools, long conversations, `selftest --yes`, the Anthropic and Responses APIs with their own clients.

## 0.1.0 (2026-10-22)

First release: a local OpenAI-compatible API and web playground for personal DeepSeek and Gemini chat accounts, with a pace and daily cap per account.
