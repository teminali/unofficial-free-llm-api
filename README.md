# Unofficial Free LLM API

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Donate: Crypto](https://img.shields.io/badge/Donate-Crypto-yellow.svg)](DONATE.md)
[![Node: 22+](https://img.shields.io/badge/Node-22%2B-brightgreen.svg)](https://nodejs.org/)
[![Status: Alpha](https://img.shields.io/badge/Status-Alpha-orange.svg)](#status-and-limits)

> **A local, OpenAI-compatible API and web playground for the personal chat accounts you already have.**
> Link your own DeepSeek, Gemini or Qwen account once. Get a web interface to talk to it and `http://localhost:8420/v1`
> for your own code. No dependencies, no cloud, nothing leaves your computer except the requests to the provider.
> "Free" in the name means the free personal chat accounts you already have: this adds no capacity, you get what your own account gets.

> **An experiment, for personal chat accounts only.** It works through the DeepSeek, Gemini and Qwen chat websites you sign in to yourself. It does not use, ask for or support developer API keys from any provider. The only API keys in it are the ones this program makes for your own local use. It can be slow or break whenever the websites change, and it is not meant for production.

> **Unofficial, and it carries real risk.** This is not made or endorsed by DeepSeek, Google or Alibaba, it may break their
> terms, and an account used this way can be slowed down, muted or signed out. It paces and caps itself to lower that
> risk, not to remove it. Read the [DISCLAIMER](DISCLAIMER.md) before you link anything, and use an account you can afford to lose.

## Quick start

You need Node.js 22 or newer, and Google Chrome (for linking an account; Qwen also answers through it, so its window stays open while the program runs).

```bash
npx unofficial-free-llm-api@latest        # @latest: npx may otherwise run an older copy it kept; or: npx github:teminali/unofficial-free-llm-api, or git clone then npm start
```

The terminal prints a link and opens it: that is the web interface. It also prints your first API key (show it again any time: `unofficial-free-llm-api key show`, or the *Show* button on the API page).

1. **Accounts** → *Link account* → tick the box → sign in to the provider in the Chrome window that opens → *I have signed in*.
2. **Playground** → pick a model and talk to it.
3. **API** → copy the base URL and a key into your own code.

No account yet? `npx unofficial-free-llm-api --demo --providers demo` starts with a demo provider that
answers by describing what it was sent, so you can try the interface and your client first.

## What you get

<p align="center">
  <img src="docs/screenshots/playground-light.png" alt="The playground: a streamed answer with its thinking in a fold" width="49%">
  <img src="docs/screenshots/accounts.png" alt="The Accounts page: two providers, their pace and caps" width="49%">
</p>
<p align="center"><sub>The screenshots show the demo provider and local stand-ins, not a real account.</sub></p>

**A web interface** (served by the same process, no build step): a *Playground* with streaming, a thinking fold and
markdown; *Accounts* to link and unlink, with usage, limits and cooldowns; *API* for keys and copy-ready snippets;
*Activity* for the last requests (metadata only, never a prompt or an answer).

**API endpoints**: OpenAI-compatible, and the two other APIs most clients speak:

| Route | What |
|---|---|
| `GET /v1/models`, `GET /v1/models/{id}` | the models of the accounts that are linked right now, with a working `context_length`; Gemini's and Qwen's lists follow the account (`gemini` / `gemini-auto` always exist) |
| `POST /v1/chat/completions` | chat, streaming (`stream: true`), tool calls, JSON mode, `reasoning_content` |
| `POST /v1/responses` | OpenAI's Responses API: text, function calls, streaming, `previous_response_id` |
| `POST /v1/messages`, `POST /v1/messages/count_tokens` | Anthropic's Messages API: text, thinking, `tool_use`, streaming |
| `GET /health` | `{ "ok": true, "version": "…" }`, no key, for a container health check |

```python
from openai import OpenAI

client = OpenAI(base_url="http://localhost:8420/v1", api_key="sk-ula-...")
reply = client.chat.completions.create(
    model="deepseek-chat",
    messages=[{"role": "user", "content": "Say hello in five words."}],
)
print(reply.choices[0].message.content)
```

More in [docs/api.md](docs/api.md) and [examples/](examples/): curl, Python, Node, streaming, tool calling.

## Models

| Provider | Model ids | Notes |
|---|---|---|
| DeepSeek | `deepseek-chat` | the plain chat, answers in seconds |
| | `deepseek-reasoner` | DeepThink: thinks first and streams `reasoning_content`; its replies end after about two minutes |
| | `deepseek-auto` | the plain chat that can hand ONE hard question to DeepThink and build from the answer; matters when you send `tools` (agents) |
| Gemini | `gemini`, `gemini-auto` | always listed: the mode the page is on, with no model chosen (`gemini-auto` takes the name of the account's own Auto row when it has one) |
| | `gemini-<name>` | one per other model your account's picker offers (for example `gemini-3-5-flash-lite`), read when you link and again when the list is 15 minutes old (a call or a client listing the models does it), or press *Read models again* on the Accounts page |
| Qwen | the account's own ids, for example `qwen3.7-plus`, `qwen3.8-max` | one per model your Qwen account offers, read when you link and refreshed in the background when a client lists the models, or with *Read models again*; there is no fixed alias, so the ids are the account's |
| Demo | `demo-echo`, `demo-thinker` | only with `--demo` |

Ids can also be written `deepseek/deepseek-chat` or `qwen/qwen3.7-plus`. `reasoning_effort` (`low`, `medium`, `high`) sets Gemini's thinking level; DeepSeek and Qwen ignore it. Every model lists a `context_length` of 128000: a working size this program chooses, not the model's maximum (the chat websites publish no limits). The API page has a box that copies the name, address, models and context size for a client with a form to fill in (the key is left for you to paste).

## How it works

A web chat takes one text message and answers with text. For every request the bridge:

1. **Checks the governor**: a cooldown, the daily cap or a full queue is answered at once with `429` and `Retry-After`, and nothing is sent upstream.
2. **Finds the chat.** An API request carries the whole conversation every time. If its first messages are exactly what an open chat on the account already holds,
   the request is a continuation: it goes into that chat and carries only what is new. Anything else (an edited message, other tools, another model) starts a new chat.
   One conversation is one chat, like a person's.
3. **Builds the message**: for a new chat, the system text, the transcript and, when you send `tools`, a short bridge that asks the model for a call in a plain
   format (a request with no tools is sent as it is); for a continued chat, just the new messages.
4. **Asks the account** (DeepSeek: its web endpoints with your saved session and its proof-of-work; Gemini: the chat page in a Chrome that has your profile;
   Qwen: its own message box and Send button in a Chrome that has your profile), one request at a time, paced.
5. **Reads the answer** back into OpenAI shape: text, `reasoning_content`, `tool_calls`. A tool call is read from every shape these chats were seen
   to use, and only for tools you offered. A call cut off mid-way is asked for again once, then reported as an error.

Chats are removed when their conversation ends (20 minutes without a request, at most 6 open, or a chat grown long), and when the program stops. That covers DeepSeek
and the Qwen chats this program created; other Qwen chats are never touched. A Gemini chat is never deleted: it stays in your Gemini history. Name a conversation
with the `user` field or an `X-ULA-Session` header if you want it kept apart. `--no-sessions` (or `ULA_SESSIONS=0`) goes back to one new chat for every request.

Linking never sees your password: you sign in yourself, in a Chrome window, and the bridge keeps the session that results.

## Safety built in

| What | How |
|---|---|
| Pace | DeepSeek: one request at a time, at least 4 s apart, at most 10 a minute (it waits, it does not fail). Gemini: 1 s apart, 20 a minute. Qwen: at least 10 s apart, 6 a minute |
| One chat per conversation | A conversation stays in one provider chat instead of opening (and deleting) a chat for every message. If continuing a chat fails twice in a row, it switches itself off and says so |
| Daily cap | 300 calls a day per account by default (Qwen: 100); change it on the Accounts page |
| First refusal stops everything | A rate limit, a mute or a human check sets a cooldown (20 min for DeepSeek and Qwen, 5 for Gemini); a mute lasts as long as DeepSeek says. Qwen's browser verification pauses requests for 20 minutes, and the check is yours to complete |
| No retry storms | Retrying a muted account only makes it worse, so there is none; a cut-off call is retried once, an empty answer once, and a connection that failed before the message went out once (nothing was spent). A connection that breaks mid-answer is an error in words, never half an answer |
| Loop guard | An agent that repeats the same step three times in a row is stopped before another call is spent |
| Local only | Listens on `127.0.0.1`; other hosts are refused; a key is required for `/v1`; the web interface needs an admin token, which it trades for a session cookie (HttpOnly, SameSite=Strict, checked against the origin) |
| Secrets | Sessions and config are mode 0600 in a 0700 folder; config.json keeps each API key (so you can copy it again) next to the admin token that can make keys; only metadata is ever logged |

Details in [docs/security.md](docs/security.md).

## Configuration

```
unofficial-free-llm-api [start] [--port 8420] [--host 127.0.0.1] [--data-dir DIR] [--no-open]
                           [--cors ORIGINS] [--no-key] [--no-sessions] [--demo] [--providers deepseek,gemini,qwen]
unofficial-free-llm-api key create [name] | key list | key show <id or name> | key revoke <id>
unofficial-free-llm-api status | login-url | doctor [--online] | selftest [--model id] [--turns 3] [--yes] | log [--lines 100]
```

Environment: `ULA_HOME` (data folder, default `~/.unofficial-free-llm-api`; a `~/.unofficial-llm-api` made by 0.1.x is kept in use while the new one does not exist), `ULA_PORT`, `ULA_HOST`, `ULA_SESSIONS=0` (no session reuse), `ULA_DEBUG=1` (log lines to stderr),
`ULA_GEMINI_VISIBLE=1` (show Gemini's Chrome instead of running it in the background), `ULA_DEEPSEEK_HIDDEN=1` (run DeepSeek's sign-in check hidden; DeepSeek blocks that), `ULA_CHROME_PATH`.

`doctor` checks the computer (Node, Chrome, the data folder's permissions, the port, the accounts) and says what to fix; `--online` also asks npm for the newest
version (the only time this program calls anything but your providers, and only when you ask). `selftest --yes` sends a short conversation through a running
server and tells you whether it stayed in one provider chat; it spends one request per turn and prints sizes and times, never words. Starting a second copy
prints the link of the one already running instead of an error.

Running on a server with no desktop? Link on your computer, then see [docs/providers.md](docs/providers.md) for pasting a DeepSeek token and for what Gemini needs. Qwen needs a desktop, because its Chrome window must stay open.

## Status and limits

Alpha. What has been run, honestly:

- The bridge, the server, the governor and the web interface have automated tests (`npm test`) that run against stand-ins: a scripted provider, a local copy of
  DeepSeek's endpoints (which can drop connections and break streams on request), and a local page shaped like Gemini's. Qwen has no stand-in yet, so its lane has
  been checked live only.
- **Run by the author on their own real accounts:** on 2026-10-22, linking DeepSeek and Gemini, chatting in the playground, a three-message DeepSeek conversation
  that stayed in one DeepSeek chat, a Gemini conversation that stayed in one Gemini chat, switching models (which starts another chat), and the model list read from a real
  Gemini picker. DeepSeek answered in 3 to 8 seconds. Gemini worked but was slow and uneven, and sometimes answered with its own error message (see below). On
  2026-10-23, linking Qwen and using Qwen3.7-Plus: a new chat (about 24 seconds for the first answer), a follow-up that stayed in the same chat (about 5 seconds),
  a cancelled request (no retry, the draft was put back), and a recovery that opened a replacement chat. Qwen3.8-Max answered with its own daily-limit message; it
  was not retried, and the program does not detect that message.
- **Not yet run against a real account:** an agent sending `tools` (including on Qwen), long conversations, a day of steady use, `selftest --yes`, the Anthropic and
  Responses APIs with their own clients, and the no-desktop setup. Reusing one chat per conversation is built to fail safe (a chat that cannot be continued is given
  up and the request is asked again on a new chat; two such failures in a row switch it off), but only short real conversations have shown it work. An issue with what you
  saw (the lines from `unofficial-free-llm-api log`, no prompts) is the most useful contribution there is.
- **Qwen can ask for a browser check.** When it does, the request fails with `403 qwen_verification_required`, requests pause for 20 minutes, and you complete the
  check in Qwen's own window. The program does not try to pass it or retry around it.
- Not supported: images in, `temperature`/`top_p`/`seed` and the like (named in an `X-ULA-Ignored` response header, not silently dropped), `max_tokens`/`stop` when tools are sent (honoured for a plain chat), `n > 1` (refused), embeddings, function-call strictness. Token counts are estimates (characters / 4).
- Gemini's Chrome runs in the background by default; if Google shows a human check there, the page opens for you to pass it.
- Providers change their sites without notice. When one breaks, [open an issue](../../issues).

## If something does not work

**DeepSeek shows a blank page that keeps redirecting, or "I have signed in" says you are not signed in.** Chrome may be refusing to let `chat.deepseek.com` save anything on your computer (Chrome calls it *On-device site data*; the address bar shows a crossed-out eye or "not allowed"). Without saved data a sign-in cannot stay, so the page loops between the app and the sign-in page. This is a Chrome setting, an extension or a Chrome privacy feature, not something DeepSeek or this program does (a fresh Chrome profile that visits DeepSeek keeps the default, which is allowed). To fix it:

1. Do **not** use the address-bar panel on the page that is redirecting: it closes every time the page reloads. Open a **new tab** instead.
2. Go to `chrome://settings/content/siteData` (Settings, Privacy and security, Site settings, On-device site data).
3. Choose *Sites can save data on your device*, or look under *Not allowed to save data* and remove `chat.deepseek.com`.
4. Check that no extension blocks cookies or site data for the site (try a private window with extensions off).
5. Reload `chat.deepseek.com`, sign in again, then press **I have signed in**.

This applies to the Chrome window this program opens as well: when its check cannot read a saved sign-in because storage is blocked, the Accounts card says so and names this setting. If you would rather not touch Chrome's settings, the Accounts page also takes a session token pasted by hand (*Advanced*).

**"I have signed in" opens the sign-in window again, or says DeepSeek refused the check.** The check opens an ordinary Chrome window for a few seconds. DeepSeek answers a hidden Chrome with a "request blocked" page, so the hidden mode is off unless you set `ULA_DEEPSEEK_HIDDEN=1`. If it still fails, run `unofficial-free-llm-api log` and look at the lines that start with `deepseek:` (no prompts, no keys are in them).

**Gemini is slow and uneven: a message can take 4 seconds or over a minute, while the same prompt typed in an ordinary Chrome on the same profile answers in under a second.** Measured on 2026-10-22 with the request timeline that `unofficial-free-llm-api log` prints: the program's Chrome shows your message and its working dots within a quarter of a second and sends the request to Gemini within a tenth of a second, so the wait is Gemini's own answer. Its first bytes came back between 2 and 34 seconds later, then up to a minute of streaming, and on the fastest model (Flash-Lite) a one-line answer took 70 seconds. The same calls sometimes ended in Gemini's own "Sorry, something went wrong", when it never answered the request at all. Several messages in a short time made it worse. This release keeps one tab open per conversation (so a later message skips the 3 to 9 seconds of opening a chat), which brought a typical call from 40 to 190 seconds down to 10 to 25. We tried every difference between the program's Chrome and an ordinary one that is not about hiding automation, and none changed the wait: hidden or visible, a focused page, a Chrome started with only the flags that driving needs, a real mouse click on the message box, and the fastest model instead of Auto. Anonymous test runs from a driven Chrome varied from 1 to 38 seconds. The cause is not established; it may be how Google treats a browser that a program drives, or how it treats an account that sends many messages. This program does not try to hide that it is driven, so it cannot remove the wait. For speed, use DeepSeek (a few seconds). This program is for the chat account you already have, as an experiment: speed is not guaranteed.

**Qwen asks for a slider check, or a request stops with `qwen_verification_required`.** The check is Qwen's, and this program does not try to pass it or retry
around it. Its Chrome window stays open while the program runs: complete the check there, then wait for the 20-minute pause to end. If the window is not on screen,
bring it up with the Qwen card on the Accounts page. Qwen can also answer with its own limit message as ordinary text (Qwen3.8-Max did, for its daily limit); that
text is returned as the answer, not reported as an error, and no model is switched automatically.

**Gemini lists only one model, or the model you pick does nothing.** Run `unofficial-free-llm-api log` after a message and look at the lines that start with `gemini:`: they say where the time went and what the page offered. `ULA_GEMINI_VISIBLE=1` shows Gemini's Chrome window instead of hiding it, which helps to tell a page problem from a program problem.

## Development

```bash
git clone https://github.com/teminali/unofficial-free-llm-api && cd unofficial-free-llm-api
npm install          # only for the UI tests (jsdom); the program has no dependencies
npm test
npm run demo         # the interface with the demo provider, no account needed
```

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Support

If this saved you time, [a coffee's worth of crypto](DONATE.md) is a good way to say so. It stays free either way.

## License

MIT. See [LICENSE](LICENSE).
