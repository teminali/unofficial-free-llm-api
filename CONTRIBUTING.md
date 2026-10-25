# Contributing

Thanks for looking. This project is small on purpose: no runtime dependencies, no build step, plain Node.js 22+ and plain browser JavaScript.

```bash
npm install     # jsdom only, for the interface tests
npm test        # everything; each file also runs alone: node --test test/server.test.js
npm run demo    # the web interface with the demo provider
```

## What makes a good change

- **A fix has a check that was seen failing first.** Write the test, watch it fail on the old code, then fix. Name the general rule that broke, not just the input that showed it
  (the bridge tests are written that way: "a request with no tools never has a call read out of its answer").
- **Providers change their sites.** If one breaks, an issue with the `ULA_DEBUG=1` log lines (they carry names and sizes, never prompts) is as good as a patch.
  A selector that moved belongs in the lists at the top of `src/providers/gemini/page.js`.
- **Account safety is a feature.** Do not add a way around the governor's pacing, caps or cooldowns, and do not add retries against a provider that refused.
- **Nothing sensitive in logs, tests or fixtures.** No real tokens, cookies, emails or prompts. The stand-ins in `test/` are for that.
- Keep the surface honest: if a feature is a prompt trick and not a native one, the docs say so.

## Layout

```
bin/            the command
src/server.js   HTTP: /v1, the admin API, the web interface; auth and origin checks
src/engine.js   one chat completion: governor, prompt, provider call, OpenAI-shaped answer
src/bridge.js   text only: conversation -> prompt, answer -> text and tool calls
src/governor.js pacing, caps, cooldowns, queue
src/providers/  deepseek, gemini, qwen, bike4mind, demo; chrome.js and chrome_cdp.js (the shared Chrome driver)
web/            the interface (no build)
test/           node:test files, with stand-ins for DeepSeek, Gemini, Bike4Mind and the demo provider (Qwen has none yet)
```

## Pull requests

Run `npm test`. Say what you ran against (a stand-in, or a real account) in the description; both are fine, but say which.
Donations are welcome but never expected: see [DONATE.md](DONATE.md).
