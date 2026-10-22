# Unofficial LLM API

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Donate: Crypto](https://img.shields.io/badge/Donate-Crypto-yellow.svg)](DONATE.md)
[![Node: 22+](https://img.shields.io/badge/Node-22%2B-brightgreen.svg)](https://nodejs.org/)
[![Status: Alpha](https://img.shields.io/badge/Status-Alpha-orange.svg)](#status-and-limits)

> **A local, OpenAI-compatible API and web playground for the personal chat accounts you already have.**
> Link your own DeepSeek or Gemini account once. Get a web interface to talk to it and `http://localhost:8420/v1`
> for your own code. No dependencies, no cloud, nothing leaves your computer except the requests to the provider.

> **Unofficial, and it carries real risk.** This is not made or endorsed by DeepSeek or Google, it may break their
> terms, and an account used this way can be slowed down, muted or signed out. It paces and caps itself to lower that
> risk, not to remove it. Read the [DISCLAIMER](DISCLAIMER.md) before you link anything, and use an account you can afford to lose.

## Quick start

You need Node.js 22 or newer, and Google Chrome (only for linking an account).

```bash
npx unofficial-llm-api        # or: npx github:teminali/unofficial-llm-api, or git clone then npm start
```

The terminal prints a link and opens it: that is the web interface. It also prints your first API key, once.

1. **Accounts** → *Link account* → tick the box → sign in to the provider in the Chrome window that opens → *I have signed in*.
2. **Playground** → pick a model and talk to it.
3. **API** → copy the base URL and a key into your own code.

No account yet? `npx unofficial-llm-api --demo --providers demo` starts with a demo provider that
answers by describing what it was sent, so you can try the interface and your client first.

## What you get

<p align="center">
  <img src="docs/screenshots/playground-light.png" alt="The playground: a streamed answer with its thinking in a fold" width="49%">
  <img src="docs/screenshots/accounts.png" alt="The Accounts page: two providers, their pace and caps" width="49%">
</p>

**A web interface** (served by the same process, no build step): a *Playground* with streaming, a thinking fold and
markdown; *Accounts* to link and unlink, with usage, limits and cooldowns; *API* for keys and copy-ready snippets;
*Activity* for the last requests (metadata only, never a prompt or an answer).

**API endpoints**, OpenAI-compatible:

| Route | What |
|---|---|
| `GET /v1/models` | the models of the accounts that are linked right now |
| `POST /v1/chat/completions` | chat, streaming (`stream: true`), tool calls, JSON mode, `reasoning_content` |
| `GET /health` | `{ "ok": true }`, no key, for a container health check |

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
| Gemini | `gemini-<name>` | one per model your account's picker offers (for example `gemini-3-1-pro`), read when you link; `gemini` is whatever mode the page is on |
| Demo | `demo-echo`, `demo-thinker` | only with `--demo` |

Ids can also be written `deepseek/deepseek-chat`. `reasoning_effort` (`low`, `medium`, `high`) sets Gemini's thinking level.

## How it works

A web chat takes one text message and answers with text. For every request the bridge:

1. **Checks the governor**: a cooldown, the daily cap or a full queue is answered at once with `429` and `Retry-After`, and nothing is sent upstream.
2. **Builds one prompt** from the whole conversation (the system text, the transcript, tool results) and, when you send `tools`, a
   short bridge that asks the model for a call in a plain format. A request with no tools is sent as it is.
3. **Asks the account** on a fresh chat (DeepSeek: its web endpoints with your saved session and its proof-of-work; Gemini: the
   chat page in a Chrome that has your profile), one request at a time, paced.
4. **Reads the answer** back into OpenAI shape: text, `reasoning_content`, `tool_calls`. A tool call is read from every shape these chats were seen
   to use, and only for tools you offered. A call cut off mid-way is asked for again once, then reported as an error.

Linking never sees your password: you sign in yourself, in a Chrome window, and the bridge keeps the session that results.

## Safety built in

| What | How |
|---|---|
| Pace | DeepSeek: one request at a time, at least 4 s apart, at most 10 a minute (it waits, it does not fail). Gemini: 1 s apart, 20 a minute |
| Daily cap | 300 calls a day per account by default; change it on the Accounts page |
| First refusal stops everything | A rate limit, a mute or a human check sets a cooldown (20 min for DeepSeek, 5 for Gemini); a mute lasts as long as DeepSeek says |
| No retry storms | Retrying a muted account only makes it worse, so there is none; a cut-off call is retried once, an empty answer once |
| Loop guard | An agent that repeats the same step three times in a row is stopped before another call is spent |
| Local only | Listens on `127.0.0.1`; other hosts are refused; a key is required for `/v1`; the web interface needs an admin token, which it trades for a session cookie (HttpOnly, SameSite=Strict, checked against the origin) |
| Secrets | Sessions and config are mode 0600 in a 0700 folder; API keys are stored as hashes; only metadata is ever logged |

Details in [docs/security.md](docs/security.md).

## Configuration

```
unofficial-llm-api [start] [--port 8420] [--host 127.0.0.1] [--data-dir DIR] [--no-open]
                           [--cors ORIGINS] [--no-key] [--demo] [--providers deepseek,gemini]
unofficial-llm-api key create [name] | key list | key revoke <id>
unofficial-llm-api status | login-url
```

Environment: `ULA_HOME` (data folder, default `~/.unofficial-llm-api`), `ULA_PORT`, `ULA_HOST`, `ULA_DEBUG=1` (log lines to stderr),
`ULA_GEMINI_VISIBLE=1` (show Gemini's Chrome instead of running it in the background), `ULA_CHROME_PATH`.

Running on a server with no desktop? Link on your computer, then see [docs/providers.md](docs/providers.md) for pasting a DeepSeek token and for what Gemini needs.

## Status and limits

Alpha. What has been run, honestly:

- The bridge, the server, the governor and the web interface have automated tests (`npm test`) that run against stand-ins: a scripted
  provider, a local copy of DeepSeek's endpoints, and a local page shaped like Gemini's.
- The DeepSeek and Gemini lanes are ported from code the author used with real accounts in another project.
  **This standalone port has not yet been run against a real account by its author.** If you do, an issue with what you saw (the
  `ULA_DEBUG=1` lines, no prompts) is the most useful contribution there is.
- Not supported: images in, `temperature`/`max_tokens`/`stop`, `n > 1`, embeddings, function-call strictness. Token counts are estimates (characters / 4).
- Gemini's Chrome runs in the background by default; if Google shows a human check there, the page opens for you to pass it.
- Providers change their sites without notice. When one breaks, [open an issue](../../issues).

## Development

```bash
git clone https://github.com/teminali/unofficial-llm-api && cd unofficial-llm-api
npm install          # only for the UI tests (jsdom); the program has no dependencies
npm test
npm run demo         # the interface with the demo provider, no account needed
```

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Support

If this saved you time, [a coffee's worth of crypto](DONATE.md) is a good way to say so. It stays free either way.

## License

MIT. See [LICENSE](LICENSE).
