# Providers

Both providers are driven the way a person uses the site. Linking never sees a password: you sign in yourself, in a Chrome window.

## How linking works (both providers)

1. **Link account** opens an ordinary Chrome window on a private profile folder inside the data folder
   (`<data>/deepseek-chrome` or `<data>/gemini-chrome`), never your everyday profile. It is started without a debugging port, so the
   sign-in is an ordinary one (Google refuses a sign-in from a browser that is being driven).
2. You sign in there, then press **I have signed in** in the web interface.
3. The bridge quits that Chrome, starts a hidden one on the same profile, checks you are signed in and reads what it needs:
   DeepSeek's session token and cookies, or Gemini's model picker. Then it works without the window.

Unlinking deletes the saved session and the profile folder.

Set `ULA_CHROME_PATH` if Chrome is somewhere unusual. Chromium and Edge are tried when Chrome is missing.

## DeepSeek

- Talks to chat.deepseek.com's own endpoints with your saved token and cookies, answering the site's proof-of-work for every message.
- One fresh chat per request, deleted as soon as the answer is in, so your history stays clean.
- `deepseek-chat` is the plain chat; `deepseek-reasoner` turns DeepThink on (its replies end after about two minutes, whatever it is doing);
  `deepseek-auto` lets the plain chat ask DeepThink one hard question when you send `tools`, then carry on from the answer.
- **Limits it will hit.** DeepSeek refuses an account that sends about 13 messages a minute ("Messages too frequent"), and has muted accounts
  for days and signed them out afterwards. So: one request at a time, at least 4 s apart, at most 10 a minute, and a 20-minute rest after any refusal.
  A mute is detected, the date is shown, and nothing is sent until it ends.
- **Pasting a token** (for a machine with no Chrome): on the Accounts page, *Advanced*. In a browser signed in to chat.deepseek.com, open developer
  tools, Application, Local storage, and copy the `value` inside `userToken`. The token alone may not be enough if the site asks for its cookies.
  Linking through Chrome is the supported path.

## Gemini

- Drives gemini.google.com in a Chrome that has your profile: one fresh tab per request, the prompt pasted in, the answer read back as it grows, the tab closed.
- Models are the rows of the page's own model picker for your account (a free account may only have *Auto*; locked rows are not offered).
  They are read when you link; link again to refresh them.
- `reasoning_effort` (or the *Default thinking level* on the Accounts page) puts the page's Thinking level on low, medium or high.
- Chrome runs in the background (`--headless=new`). If Google shows a cookie question or a human check there, the request fails
  with a message, the lane pauses for five minutes, and the page opens in a visible Chrome for you to answer. `ULA_GEMINI_VISIBLE=1` shows the window always.
- **Your Gemini history.** Each request is a chat in your account and stays in your Gemini activity.
- Chrome stays in memory while it works (hundreds of MB) and is closed after ten idle minutes.
- The page's markup is read with selectors that Google renames without notice. Every miss is logged (`ULA_DEBUG=1`); when the lane breaks, that line says what to fix.

## Running with no desktop (server, container)

Linking needs a window. Link on your computer, then copy the provider's session folder into the server's data folder:
`deepseek_session.json` for DeepSeek, `gemini_session.json` plus `gemini-chrome/` for Gemini. A server needs Chrome installed for Gemini. A session
copied to another machine or address may be signed out by the provider. This is not tested, and is the first thing to try if you need it.
