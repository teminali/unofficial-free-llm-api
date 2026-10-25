# Disclaimer: read this before you link an account

This project is **unofficial**. It is not made, endorsed, sponsored or supported by DeepSeek, Google, Alibaba, Bike4Mind or any other
company. For DeepSeek, Gemini and Qwen it uses no API any of them has published for this purpose: it talks to the same web chat you use in a
browser, with a login you create yourself, and turns that into an OpenAI-style API on your own computer. Bike4Mind is the exception: it uses
Bike4Mind's own published API, with an API key from your own Bike4Mind account.

Developers will know what that means. Here it is in plain words anyway.

## What can go wrong

- **It may break the provider's terms.** Chat websites are normally licensed for a person using them, not for programs
  calling them. Whether yours forbids this is for you to read and decide. Nothing in this repository is legal advice.
  Bike4Mind is used through its official API instead, under the terms of that API; it is still not affiliated with this project.
- **The account can be punished.** Providers slow accounts down, ask for human checks, sign them out, or mute them. A
  DeepSeek account has been muted for days after bursts of messages sent this way ("Messages too frequent", then a mute).
  The bridge paces and caps requests and stops at the first refusal to lower that risk. It cannot remove it. Use an account
  you can afford to lose, and not one you earn from or depend on.
- **It can stop working at any time.** The bridge depends on the pages and private endpoints of a website. They change
  without notice; when they do, a provider here breaks until someone fixes it.
- **Your sessions are credentials.** A linked login is stored on your computer in the data folder (`~/.unofficial-free-llm-api`, or
  `~/.unofficial-llm-api` if version 0.1.x made it, unless you moved it), readable only by you (mode 0600). Anyone who gets that folder can use your account. The API keys
  this server makes are kept in `config.json` in that folder so the API page can show them again; the file already holds the admin token, so it is as sensitive as the sessions.
- **A Bike4Mind key is a credential that spends money.** It is kept in `bike4mind_key.json` in the same folder, mode 0600, and sent only to
  `app.bike4mind.com`. Every request bills the credits in that account, and this program cannot undo credits an answer used. Revoke the key in your
  Bike4Mind account at any time; that stops it there, whatever this program still has saved.
- **Gemini conversations appear in your Gemini activity.** A conversation is a chat in your account, like one you typed, and it is not deleted from here.
- **Qwen conversations are chats too.** This program deletes only the Qwen chats it created, when their conversation ends. A deletion that fails leaves that
  chat in your Qwen history, and a chat you started yourself is never touched.
- **Answers are the provider's answers.** No SLA, no usage guarantees, and the token counts in responses are estimates. On the website lanes,
  features the website does not have (a temperature setting, images in, strict function calling) are not there, and tool calls are produced by
  asking the chat for a plain format and reading what comes back; they can be wrong. Bike4Mind's API has its own set of features: tools, pictures
  and reasoning effort go natively where the model supports them, but the model can still call the wrong tool or write the wrong arguments.
  A provider can also put its own limit message in the answer as ordinary text (Qwen did for a model's daily limit), which this program returns as the answer.

## What it is not for

- Selling or sharing access to your account, or running a service for other people on it.
- Getting around a limit a provider put on an account you do not own.
- Anything you would not do by hand in the browser at that volume.
- Production workloads. Use the provider's official API for those.

## No warranty

The software is provided as is, under the MIT license in [LICENSE](LICENSE): no warranty of any kind, and the authors are not
liable for what happens to your accounts, your data or anything else. You are responsible for how you use it.
