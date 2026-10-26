# Security model

This process holds logins to personal accounts, so it is built around one question: who can make it spend them?

## What is protected, and how

| Threat | Defence |
|---|---|
| Another website calls the API from your browser | `/v1` needs a key; a browser page has none, and a request that carries one needs a CORS preflight, which is refused. Cross-origin calls are off (`--cors` is opt-in, and only for keys, never for the web interface's cookie) |
| The same, with `--no-key` (nothing to prove who is calling) | A request that carries browser headers from another site (`Origin`, or `Sec-Fetch-Site` of `cross-site` or `same-site`) is refused, and the body must be sent as `application/json`, so the "simple" cross-site POST that needs no preflight cannot spend the account. `--no-key` together with `--cors "*"` is refused outright |
| A website makes the web interface act for you (CSRF) | Opening the login link trades the admin token for a random session: an HttpOnly, `SameSite=Strict` cookie that holds only the session's id (kept in memory, 30 days at most, ended by logout, so a restart signs the browser out). Any request that carries it and changes something must come from the server's own origin (`Origin` and `Sec-Fetch-Site` are checked). The cookie's name includes the port, so two copies on one machine do not sign each other out |
| DNS rebinding (a hostile name that points at 127.0.0.1) | On loopback the `Host` header must be `127.0.0.1`, `localhost` or `[::1]` with the server's port |
| Someone on your network | Listens on loopback by default. `--host 0.0.0.0` is allowed, warns, and still needs a key for `/v1` and the admin token for the interface; `--no-key` is refused off loopback |
| A leaked key | A call is checked against the key's SHA-256 hash in constant time. Keys made after 0.1.0 are also kept in `config.json` (mode 0600, in a 0700 folder) so the API page and `key show` can show them again: the file already holds the admin token, which can make keys, so whoever can read it could mint one anyway. Keys are revocable. A key reaches `/v1` only; the admin routes need the admin token, and the key list and the state never carry a key (only the admin-signed `POST /_/keys/:id/reveal` and `key show` do). Keys made by 0.1.0 are hash-only and cannot be shown: make a new one |
| Script injection through a model's answer | The interface builds every element with DOM calls; there is no `innerHTML`. Only `http(s)` links are made. A strict CSP (`script-src 'self'`, no inline script) is sent with the page |
| Secrets at rest | `config.json`, session files (DeepSeek's session; for Qoder, `qoder_key.json`, which holds the personal access token and the model list; the Qoder CLI's own state in `qoder-cli/`, mode 0700), settings and usage files are mode 0600 in a 0700 folder, written through a temporary file and renamed. A `config.json` that is not valid JSON stops the server with a message; it is never replaced by an empty one |
| A client that leaves | A request whose client goes away while it waits for its turn is dropped before anything is sent upstream. One that leaves after the message went out still counts toward the daily and per-minute limits, because the account was spent |
| A redirect from the provider's address | Requests to DeepSeek never follow redirects, so the prompt or the login is not sent on to another address. This program makes no HTTP request for Qoder at all: the token is handed only to the official CLI, in its environment |
| Secrets in logs | Only metadata is logged or kept: model, status, time, sizes, the key's name. Never a prompt, an answer, a token or a cookie. `unofficial-free-llm-api log` (and `GET /_/log`, which needs the sign-in or the admin token) shows the last 300 lines the providers logged, held in memory and never written to disk, with keys and token-like strings scrubbed once more. The DeepSeek lane logs the names of a stream's events, never the words. The Qoder lane logs only statuses and timings, and scrubs the token from anything the CLI said |
| What sessions remember | To continue a provider chat the program keeps, in memory, one short hash for each message and the provider's chat id: never the words. The DeepSeek chat ids that are open are also written to `sessions-deepseek.json` in mode 0600, so a chat left by a killed program is removed the next time; that file holds ids, nothing else. A Qoder chat has no id to remember: it is a live CLI process, in memory only, holding the conversation |
| What `previous_response_id` remembers | `/v1/responses` keeps the messages of the last 64 responses **in memory** for 30 minutes (so a caller can send only the new input). They are never written anywhere, and `store: false` keeps nothing |
| A huge request | Bodies over 16 MB are answered `413` after the upload is drained |
| Traffic that would hurt the account | The governor (see the README) paces, caps, queues and pauses; the first provider refusal stops all calls until the pause ends |

## What it does not protect

- Anyone who can read your data folder or run code as you has your sessions. It is as secret as your browser profile.
- Another user on the same computer can reach `127.0.0.1:8420`, and can use the API if they have a key. Do not run it on a shared machine.
- Browsers send a cookie to every port of the same host. Any other web server you run on `127.0.0.1` or `localhost` receives the interface's session cookie in its requests while you are signed in. It holds only a revocable session id (not the token), but a hostile local service could replay it: sign out (or restart the program) when you run untrusted servers next to it.
- **A model's text becomes tool calls.** DeepSeek and Qoder have no native tool calling here, so a call is read out of the model's reply. If the model quotes an example call, or repeats text it found in a tool result (a web page, a file), that text can become a real `tool_calls` entry in your client. Only tools your request offered are accepted, and your client decides whether to run them: keep approval on for tools that can do harm, and treat tool results from the web as untrusted.
- The provider sees what you send, as it would from a browser. Do not send it what you would not type there.
- Linking DeepSeek through Chrome uses a Chrome profile folder in the data folder. It holds DeepSeek's cookies. Unlinking deletes it.

## The Qoder CLI

Qoder links with a personal access token, and every request runs the official Qoder CLI as a child process. The token is put in that process's environment only,
never on its command line, and it is scrubbed from the CLI's output before anything is logged. The CLI keeps its own state in `qoder-cli/` (mode 0700) inside the
data folder; that state is as secret as the token. The program passes none of your other logins to it: `QODER_*`, `QODERCN_*`, `CLAUDE_CODE_*` and `GEMINI_*`
variables from this shell are removed first, so a Qoder Desktop or other agent session is neither read nor changed. The CLI makes the requests to Qoder; this
program never calls Qoder's servers itself.

A conversation keeps one CLI process open between turns, so the token stays in that process's environment for as long as the chat is. The process is closed after
ten idle minutes, twenty-four turns or a grown transcript, and when the chat, the link or the program ends; at most three are kept, at about 450 to 500 MB each.
The CLI is told not to persist a session, so the conversation is in the process's memory and not on disk.

## The admin token

`config.json` holds a random admin token, which signs in to the web interface (not the API). `unofficial-free-llm-api` prints a link that signs the browser in (it
sets the session cookie, then redirects without the token in the address). `unofficial-free-llm-api login-url` prints the link again.

The link is a long-lived credential for the interface, and it lands in places a password would not: your browser's history (and the paste box on the
sign-in card), and the command line of the program that opens the browser. Treat it like a password and do not share a screenshot of the terminal. To rotate it,
delete `adminToken` from `config.json`; a new one is made at the next start and every signed-in browser is signed out.

## Reporting a problem

Please use GitHub's private vulnerability reporting for this repository (Security tab), not a public issue.
