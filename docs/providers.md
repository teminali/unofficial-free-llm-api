# Providers

DeepSeek is driven the way a person uses the site: linking never sees a password, because you sign in yourself, in a Chrome window.
Qoder is different: it goes through its official CLI, which makes the signed requests to Qoder's model server. You link it by pasting a
personal access token from your own account. No browser is involved.

## How linking works (DeepSeek)

1. **Link account** opens an ordinary Chrome window on a private profile folder inside the data folder
   (`<data>/deepseek-chrome`), never your everyday profile. It is started without a debugging port, so the
   sign-in is an ordinary one.
2. You sign in there, then press **I have signed in** in the web interface.
3. The bridge quits that Chrome, starts another on the same profile, checks you are signed in and reads what it needs:
   DeepSeek's session token and cookies. This check is an ordinary Chrome window that opens for a few seconds, because DeepSeek answers a hidden Chrome with a "request blocked" page and
   gives it none of the cookies its API needs (`ULA_DEEPSEEK_HIDDEN=1` brings the hidden one back). If DeepSeek refuses the check
   anyway, the Accounts card says so, and **Advanced: paste a session token** still works. DeepSeek then works without a window.

Unlinking deletes the saved session and the profile folder.

Set `ULA_CHROME_PATH` if Chrome is somewhere unusual. Chromium and Edge are tried when Chrome is missing.

## DeepSeek

- Talks to chat.deepseek.com's own endpoints with your saved token and cookies, answering the site's proof-of-work for every message.
- One chat for a whole conversation: a request that continues one goes into the same chat (`chat_session_id` and the `parent_message_id` of the last answer, the way
  the web app continues a chat) and carries only what is new. A new conversation opens a chat. Chats are deleted when their conversation has been quiet for 20
  minutes, when more than 6 are open, when one grows long, and when the program stops; their ids are written down (never their words) so a chat left by a program
  that was killed is removed the next time. With `--no-sessions` every request is a fresh chat, deleted as soon as the answer is in.
- `deepseek-chat` is the plain chat; `deepseek-reasoner` turns DeepThink on (its replies end after about two minutes, whatever it is doing);
  `deepseek-auto` lets the plain chat ask DeepThink one hard question when you send `tools`, then carry on from the answer.
- **Limits it will hit.** DeepSeek refuses an account that sends about 13 messages a minute ("Messages too frequent"), and has muted accounts
  for days and signed them out afterwards. So: one request at a time, at least 4 s apart, at most 10 a minute, and a 20-minute rest after any refusal.
  A mute is detected, the date is shown, and nothing is sent until it ends.
- **When the connection fails.** It says nothing about the account, so it sets no pause and does not sign you out. If it fails *before* the message went out (the
  first request after a laptop wakes up often does), the request is tried once more after under a second; nothing was spent, so nothing is spent twice. If it breaks
  *while* DeepSeek is answering, you get an error in words, not half an answer, and the message counts, because it was sent. A chat that could not be removed
  because of the network stays on the list and is removed as soon as it can be (and after a restart, since its id is written down).
- **If DeepSeek changes its proof-of-work**, the request says so by name and stops at once, instead of searching for an answer the program cannot compute.
- `unofficial-free-llm-api log` shows, once per run, how a real DeepSeek stream ended, by the names of its events and never their words. That is the one fact about
  the stream that is not recorded anywhere yet; it is logged so that a cut-off answer can one day be told from a finished one.
- **Pasting a token** (for a machine with no Chrome): on the Accounts page, *Advanced*. In a browser signed in to chat.deepseek.com, open developer
  tools, Application, Local storage, and copy the `value` inside `userToken`. The token alone may not be enough if the site asks for its cookies.
  Linking through Chrome is the supported path.

## Qoder

- **The official Qoder CLI, with your personal access token.** Qoder's model server cannot be called directly with a personal token: the catalog and the model
  calls are signed by the CLI's own handshake. So this program drives the official Qoder CLI, one process per conversation while chats are kept. Install it with
  `npm install -g @qoder-ai/qodercli`; make a token at [qoder.com/account/integrations](https://qoder.com/account/integrations), then paste it on the Accounts
  page. The token stays on this computer and is handed only to that CLI, in its environment, never on a command line or in a log. Nothing opens a browser.
- **What linking checks.** The CLI is asked for the models this token can call (`qoder --list-models`) in a private config folder inside the data folder
  (`qoder-cli/`, mode 0700), so a Qoder login that already exists on this computer is neither read nor changed. A token the CLI refuses is not saved. The token
  and the models are kept in `qoder_key.json`, mode 0600. Unlinking deletes that file and the CLI folder; the token itself still exists in your Qoder account
  until you revoke it there.
- **Models.** Every model the CLI lists becomes an offered id, prefixed `qoder-` so a Qwen or Kimi model Qoder offers cannot be mistaken for another provider's
  model (for example `qoder-qwen3-7-max`). The key the CLI prints is what a request is sent with; a row the CLI shortened with an ellipsis falls back to its
  display name. The list is read when you link; a list younger than ten minutes is reused, a list read by a client listing the models starts a background read when it
  is older than that, and *Read models again* (or `POST /_/providers/qoder/refresh-models`, signed in) forces one. A list in
  a shape the bridge does not read is an error, never a guessed list. The CLI publishes no context sizes, so every model lists the 128000 working size.
- **Requests.** A conversation runs one `qoder --print` process with its input kept open: the bridge asks for `stream-json` input and output, so the first prompt
  starts the process and each later message goes in as one JSON line. Text and thinking stream as partial events when the CLI knows them; a CLI that refuses
  `--include-partial-messages` or `stream-json` output is asked again in the plainer shape. A CLI that refuses `--input-format` is not asked for a warm chat again in
  that run: every request gets its own process with the prompt on stdin. Every run has no built-in tools, `--no-session-persistence`, and the isolated config folder.
  Paced by the same governor as everything else (one at a time, 1 s apart, 20 a minute, 300 calls a day by default), with a timeout of ten minutes per call.
- **A kept chat lives in memory.** The first request of a conversation pays for the CLI to start; follow-ups on the same process take a few seconds. At most three
  chats are kept, each ends after ten idle minutes, twenty-four requests or 150,000 characters, and a request that changes the model, the effort, the tools or an
  earlier message starts a new process. A process takes roughly 450 to 500 MB while idle and up to about 900 MB while answering. Linking a different token, unlinking
  and stopping the program close the chats. If a process dies between turns, the next request starts a new chat with the whole conversation. Nothing is written to disk.
- **Tools, thinking and pictures.** There is no native tool handoff: tools go in the prompt as the text protocol the account-backed providers use
  (`<tool_call>{"name":"...","arguments":{...}}</tool_call>`), and the calls are read back and returned as `tool_calls`. `reasoning_effort` becomes the CLI's own
  `--reasoning-effort` (low, medium, high, xhigh, max); `none` becomes `--thinking disabled`, and a model whose thinking cannot be switched off gets
  `--thinking enabled` when no effort was asked. A picture goes in as an image block of a stream-json user message, right after its `[attached image N]` marker, in a
  kept chat and in a one-off run alike (the newest four, 10 MB each; one left out is named in the prompt). `--attachment` is not used: it hands the model a file path,
  and every model but one then tries to open it with a tool, which is off here. A CLI that refuses `--input-format` is sent the words and a note. `temperature` has no flag: it is
  named in `X-ULA-Ignored`.
- **Why the prompt is still a transcript.** A new chat is given the whole conversation, including tool results, with the tool bridge when tools are offered; a
  continuation is given only the new messages. The CLI is told not to persist a session, so the conversation exists only in that process.
- **Refusals.** A token the CLI refuses marks the account refused; its models are cleared, and the next request says the model is unknown until a new token is
  pasted. A rate limit pauses requests for a minute; the CLI gives no `Retry-After`. An answer the CLI stops at its output limit comes back as
  `finish_reason: "length"`. The CLI's own message is passed on in words, with the token scrubbed.
- **First call is slow.** A CLI process starts from cold, so the first call of a conversation takes about fifteen seconds. Later messages go to the same process and
  answer in a few seconds. A client whose connection test gives up in 15 or 20 seconds can report a timeout while a normal chat would have worked; raise that client's
  own timeout. `unofficial-free-llm-api log` prints when the CLI first wrote anything and when the answer ended, without words.

## Running with no desktop (server, container)

Linking DeepSeek needs a window, so link on your computer, then copy the provider's session folder into the server's data folder:
`deepseek_session.json` for DeepSeek. A session copied to another machine or address may be signed out by the provider. This is not tested, and is the first thing
to try if you need it.

Qoder needs none of that: open the web interface of the running copy (through an SSH tunnel if the port is not reachable) and paste the personal access token
there, or copy `qoder_key.json` from a machine that has it. It is not tied to a browser profile or a machine. The
Qoder machine needs the Qoder CLI installed (`npm install -g @qoder-ai/qodercli`); the token is the only login it needs.
