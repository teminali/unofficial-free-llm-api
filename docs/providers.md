# Providers

Both providers are driven the way a person uses the site. Linking never sees a password: you sign in yourself, in a Chrome window.

## How linking works (both providers)

1. **Link account** opens an ordinary Chrome window on a private profile folder inside the data folder
   (`<data>/deepseek-chrome` or `<data>/gemini-chrome`), never your everyday profile. It is started without a debugging port, so the
   sign-in is an ordinary one (Google refuses a sign-in from a browser that is being driven).
2. You sign in there, then press **I have signed in** in the web interface.
3. The bridge quits that Chrome, starts another on the same profile, checks you are signed in and reads what it needs:
   DeepSeek's session token and cookies, or Gemini's model picker. Then it works without the window. For DeepSeek this check is an
   ordinary Chrome window that opens for a few seconds, because DeepSeek answers a hidden Chrome with a "request blocked" page and
   gives it none of the cookies its API needs (`ULA_DEEPSEEK_HIDDEN=1` brings the hidden one back). If DeepSeek refuses the check
   anyway, the Accounts card says so, and **Advanced: paste a session token** still works.

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

## Running with no desktop (server, container)

Linking needs a window. Link on your computer, then copy the provider's session folder into the server's data folder:
`deepseek_session.json` for DeepSeek, `gemini_session.json` plus `gemini-chrome/` for Gemini. A server needs Chrome installed for Gemini. A session
copied to another machine or address may be signed out by the provider. This is not tested, and is the first thing to try if you need it.
