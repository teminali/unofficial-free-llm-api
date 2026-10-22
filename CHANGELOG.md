# Changelog

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

### Known

- Gemini is slow and uneven through this lane (4 seconds to over a minute). The request is sent within a tenth of a second; the wait is Gemini's own answer. The
  README has the measurements and what was ruled out. This program does not hide that it is driven.
- An answer that DeepSeek's connection cuts off cleanly in the middle cannot yet be told from a finished one.
- Not yet run against a real account: an agent sending tools, long conversations, `selftest --yes`, the Anthropic and Responses APIs with their own clients.

## 0.1.0 (2026-10-22)

First release: a local OpenAI-compatible API and web playground for personal DeepSeek and Gemini chat accounts, with a pace and daily cap per account.
