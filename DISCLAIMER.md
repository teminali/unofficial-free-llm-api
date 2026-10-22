# Disclaimer: read this before you link an account

This project is **unofficial**. It is not made, endorsed, sponsored or supported by DeepSeek, Google or any other
company, and it uses no API that any of them has published for this purpose. It talks to the same web chat you use in a
browser, with a login you create yourself, and turns that into an OpenAI-style API on your own computer.

Developers will know what that means. Here it is in plain words anyway.

## What can go wrong

- **It may break the provider's terms.** Chat websites are normally licensed for a person using them, not for programs
  calling them. Whether yours forbids this is for you to read and decide. Nothing in this repository is legal advice.
- **The account can be punished.** Providers slow accounts down, ask for human checks, sign them out, or mute them. A
  DeepSeek account has been muted for days after bursts of messages sent this way ("Messages too frequent", then a mute).
  The bridge paces and caps requests and stops at the first refusal to lower that risk. It cannot remove it. Use an account
  you can afford to lose, and not one you earn from or depend on.
- **It can stop working at any time.** The bridge depends on the pages and private endpoints of a website. They change
  without notice; when they do, a provider here breaks until someone fixes it.
- **Your sessions are credentials.** A linked login is stored on your computer in the data folder (`~/.unofficial-free-llm-api`, or
  `~/.unofficial-llm-api` if version 0.1.x made it, unless you moved it), readable only by you (mode 0600). Anyone who gets that folder can use your account. The API keys
  this server makes are stored only as hashes.
- **Gemini conversations appear in your Gemini activity.** A conversation is a chat in your account, like one you typed, and it is not deleted from here.
- **Answers are the web chat's answers.** No SLA, no usage guarantees, no token counts (the numbers in responses are
  estimates), and features the website does not have (a temperature setting, images in, strict function calling) are not
  there. Tool calls are produced by asking the chat for a plain format and reading what comes back; they can be wrong.

## What it is not for

- Selling or sharing access to your account, or running a service for other people on it.
- Getting around a limit a provider put on an account you do not own.
- Anything you would not do by hand in the browser at that volume.
- Production workloads. Use the provider's official API for those.

## No warranty

The software is provided as is, under the MIT license in [LICENSE](LICENSE): no warranty of any kind, and the authors are not
liable for what happens to your accounts, your data or anything else. You are responsible for how you use it.
