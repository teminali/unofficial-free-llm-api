# Providers

DeepSeek, Gemini and Qwen are driven the way a person uses the site: linking never sees a password, because you sign in yourself, in a Chrome window.
Bike4Mind is different: it uses its own official API, and you link it by pasting an API key from your Bike4Mind account. No browser is involved.

## How linking works (DeepSeek, Gemini, Qwen)

1. **Link account** opens an ordinary Chrome window on a private profile folder inside the data folder
   (`<data>/deepseek-chrome`, `gemini-chrome` or `qwen-chrome`), never your everyday profile. It is started without a debugging port, so the
   sign-in is an ordinary one (Google refuses a sign-in from a browser that is being driven).
2. You sign in there, then press **I have signed in** in the web interface.
3. The bridge quits that Chrome, starts another on the same profile, checks you are signed in and reads what it needs:
   DeepSeek's session token and cookies, Gemini's model picker, or Qwen's token and model list. For DeepSeek this check is an
   ordinary Chrome window that opens for a few seconds, because DeepSeek answers a hidden Chrome with a "request blocked" page and
   gives it none of the cookies its API needs (`ULA_DEEPSEEK_HIDDEN=1` brings the hidden one back). If DeepSeek refuses the check
   anyway, the Accounts card says so, and **Advanced: paste a session token** still works. DeepSeek then works without a window;
   Gemini runs in the background; Qwen keeps a Chrome window open while the program runs, because its requests go through the page.

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

## Gemini

- Drives gemini.google.com in a Chrome that has your profile. A conversation keeps one tab open, like a person's: the next message goes into the same tab with no page load. At most 3 tabs stay open (the oldest closes to make room), and a tab left alone for 5 minutes closes; the conversation is then opened again by its address when it goes on. The prompt is pasted in and the answer read back as it grows. Controls the page draws inside an answer (a quick reply such as "Yes" under a question) are not read as the answer.
- Models: `gemini` and `gemini-auto` are always listed and mean the mode the page is on (no model is chosen); a real *Auto* row in your account takes the `gemini-auto` name. The rest are the rows of the page's own model picker for your account (locked rows are not offered). The list is read when you link and again when it is 15 minutes old, on a real call or when a client lists the models; *Read models again* on the Accounts page (or `POST /_/providers/gemini/refresh-models`, signed in) forces a read. A read that finds nothing keeps the old list.
- `reasoning_effort` (or the *Default thinking level* on the Accounts page) puts the page's Thinking level on low, medium or high.
- Chrome runs in the background (`--headless=new`). If Google shows a cookie question or a human check there, the request fails
  with a message, the lane pauses for five minutes, and the page opens in a visible Chrome for you to answer. `ULA_GEMINI_VISIBLE=1` shows the window always. `ULA_GEMINI_MINIMAL=1` starts the driven Chrome with a window and only the flags that driving needs (no background-rendering switches), to compare it with an ordinary Chrome on the same profile; it is for diagnosis.
- **Your Gemini history.** A conversation is one chat in your account (a request that continues it opens it again and adds a message) and stays in your Gemini
  activity: this program never deletes a Gemini chat, because that means driving the page's menus. With `--no-sessions` every request is a chat of its own.
- Chrome stays in memory while it works (hundreds of MB) and is closed after ten idle minutes.
- **Gemini's own error** ("Sorry, something went wrong", "I seem to be encountering an error") is not an answer: it is reported as a failed request (`gemini_error`, 502) so the client can try again.
- **Speed.** Gemini is slow and uneven through this lane (4 seconds to over a minute). The program's tab sends the request within a tenth of a second; the wait is Gemini's own answer. The measurements and what was ruled out are in the README, under *If something does not work*; `unofficial-free-llm-api log` prints the request timeline of each call.
- The page's markup is read with selectors that Google renames without notice. Every miss is logged (`ULA_DEBUG=1`); when the lane breaks, that line says what to fix.

## Qwen

- Drives chat.qwen.ai in a Chrome window with the private profile. The window stays open while the program runs. A request is typed into the page's real
  message box and sent with one Send click; the outgoing request and its stream are read from the page. Before an answer is accepted, the request is checked for
  the exact message, model, account and conversation the bridge meant to use. A mismatch fails the request instead of accepting the answer.
- One chat for a whole conversation, like DeepSeek: a continuation goes into the same chat and carries only what is new. Chats this program created are tracked
  in `chats-qwen.json` (ids only, never words) and removed when their conversation has been quiet for 20 minutes, when more than 6 are open, when one grows long,
  or when the program stops. Your other Qwen chats are never touched. A removal is deferred while that chat has a draft or an answer in its composer.
- Models: Qwen has no fixed aliases. The ids are the ones your account offers, for example `qwen3.7-plus` or `qwen3.8-max`. The list is read when you link, refreshed
  in the background whenever a client lists the models, and can be forced with *Read models again* (or `POST /_/providers/qwen/refresh-models`, signed in).
- **Limits.** Qwen can ask for a browser verification (a slider or similar). When it does, the request fails with `403 qwen_verification_required`, the lane pauses
  for 20 minutes, and you complete the check in the Qwen window yourself. The program does not try to pass it or retry around it. Qwen can also return a model's daily
  limit as ordinary answer text (Qwen3.8-Max did): that text is returned as the answer, not detected as an error, and no other model is tried.
- Pace: at least 10 seconds between requests, 6 a minute, 100 a day by default. A refusal or a verification sets a 20-minute pause.
- **Cancellation.** A request the client cancels is not retried. If Qwen had already confirmed it, the page's Stop button is clicked; if the click never went out,
  the exact draft is cleared only on the same account and page, so a message that was not sent is not left behind.
- **Speed, measured on 2026-10-23 with Qwen3.7-Plus:** a new chat took about 24 seconds for its first answer (most of it opening the chat and waiting for the page's
  composer), and a follow-up in an open chat took about 5 seconds. A recovery after a page change took about 16 seconds.
- The page's markup is read with selectors that Alibaba renames without notice. Every miss is logged (`ULA_DEBUG=1`); the `qwen:` lines carry stages, statuses and
  sizes, never prompts or answers.

## Bike4Mind

- **Its own API, with your key.** Make a key in your Bike4Mind account (Profile, then API Keys) and paste it on the Accounts page. The consent box says what
  it means: the key stays on this computer, requests go only to `app.bike4mind.com`, every request spends the credits in that account, and revoking the key in
  Bike4Mind stops it. Nothing opens a browser, so this lane needs no desktop and no Chrome.
- **What linking checks.** The key is used once to read the model list (`GET /api/v1/models`), the credit balance (`GET /api/v1/credits`) and, when the key
  allows the scope, the account name (`GET /api/v1/me`). A key Bike4Mind refuses (401) or one without the `ai:chat` scope (403) is not saved. The key and what was read
  are kept in `bike4mind_key.json`, mode 0600, like the other sessions. Unlinking deletes that file; the key itself still exists in your Bike4Mind account until you
  revoke it there.
- **Models.** The ids are the ones its API reports, text models only; open models or non-text entries are left out. Each has the context size and output limit
  its API reports, and flags for tools, vision and thinking. The list is read when you link, refreshed in the background when a client lists the models, and can be
  forced with *Read models again* (or `POST /_/providers/bike4mind/refresh-models`, signed in). A read that fails keeps the old list.
- **Requests.** `POST /api/ai/v1/completions` with the key in `x-api-key`, paced by the same governor as everything else (one at a time, 1 s apart, 20 a minute,
  300 calls a day by default). The API always answers with server-sent events: `meta`, then `content` and `tool_use` events, an in-band `error` if it fails, and
  `data: [DONE]`. The program reads it that way whether or not the caller asked to stream, and passes text on as it arrives. A `content` event may carry a delta or
  the whole answer so far; both are reduced to the new text.
- **Tools.** Tools are sent natively, in the shape the API documents (`tools: [{ toolSchema }]`). A native `tool_use` event is turned into the same
  `<tool_call>{"name":…,"arguments":…}</tool_call>` text the bridge transcript uses, so a client sees ordinary OpenAI `tool_calls`. A model whose model entry says
  it does not call tools refuses a request that offers them, before anything is spent.
- **Why the prompt is still a transcript.** The API takes `user`, `assistant` and `system` messages but has no `tool` role, and plain system prompts are ignored.
  So the program puts the system text and the conversation, including tool results, into one `user` message, the way it does for a website chat; only the tools are
  sent natively. The model still gets the whole conversation on every call: Bike4Mind keeps no chat on its side.
- **Thinking and pictures.** `reasoning_effort` maps to the API's `options.reasoningEffort` (low, medium, high); a thinking model is also asked to think with
  `options.thinking`. Inline pictures (`data:` URLs) go as native image parts when the chosen model supports vision: up to 8, 10 MB each, 20 MB of base64 in one
  request (the API refuses a body over 25 MB). A model without vision, or a picture over those limits, is told in the prompt that it cannot see it.
- **Credits and refusals.** The balance shown on the Accounts card is read from the API at linking, with *Read models again*, after each request's own credit
  event, and again after ten quiet minutes. The daily cap limits calls, not spending: every request bills the account. `422 insufficient_credits` ends the request
  with that message; a 429 pauses requests for at least a minute, or as long as its `Retry-After` says, and nothing is retried around it. An answer cut by the
  model's own output limit comes back as `finish_reason: "length"`.

## Running with no desktop (server, container)

Linking needs a window for DeepSeek, Gemini and Qwen. Link on your computer, then copy the provider's session folder into the server's data folder:
`deepseek_session.json` for DeepSeek, or `gemini_session.json` plus `gemini-chrome/` for Gemini. A server needs Chrome installed for Gemini. Qwen is not
supported without a desktop: its Chrome window must stay open and visible while requests run, so copying `qwen_session.json` and `qwen-chrome/` to a headless
server is not enough. A session copied to another machine or address may be signed out by the provider. This is not tested, and is the first thing to try if you
need it.

Bike4Mind needs none of that: open the web interface of the running copy (through an SSH tunnel if the port is not reachable) and paste the key there, or copy
`bike4mind_key.json` from a machine that has it. Its key is not tied to a browser profile or a machine.
