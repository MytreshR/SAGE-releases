# SAGE

**Speech Answer Generation Engine** — a desktop assistant for live interviews and
meetings.

SAGE listens to the conversation, works out when a question has actually been
asked, and puts an answer on screen that you can say out loud — fast enough to be
useful while the other person is still looking at you. The window is hidden from
screen sharing, so it stays invisible in Zoom, Teams, and Google Meet.

## Download

**[Download the latest release →](https://github.com/MytreshR/SAGE-releases/releases/latest)**

Windows 10/11, 64-bit.

## Setup

1. **Install** — run the setup file. Windows will warn about an unknown
   publisher, because the installer is not code-signed yet. Choose
   **More info → Run anyway**.
2. **Add an OpenAI API key** — SAGE opens Settings on first launch and asks for
   one. Create a key at
   [platform.openai.com/api-keys](https://platform.openai.com/api-keys).
3. **Paste in your resume** (Settings → Resume). This matters more than it
   looks: it grounds the answers *and* improves speech recognition of your own
   employers and technologies.
4. **Allow microphone access** when prompted.

### About the API key

SAGE runs on **your own OpenAI account**. There is no subscription and nothing
is billed by SAGE — but transcription and answers are charged to your OpenAI
account at OpenAI's rates, and the key never leaves your machine except to call
OpenAI directly.

## What it does

- **Streaming transcription** — audio is sent as it is captured, so the
  transcript arrives while you are still listening to the question
- **Question detection** — filters out small talk, filler and background noise,
  so it answers questions rather than everything it hears
- **Grounded answers** — draws on the resume you provide, and is instructed not
  to invent employers, dates, metrics or experience you do not have
- **Screenshot solving** — capture a coding or system-design question on screen
  and get a full worked solution
- **Two modes** — *Interview* answers as a candidate; *General* helps in any
  live conversation, meeting or call
- **Hidden from screen sharing**, always-on-top, adjustable opacity

## Requirements

- Windows 10 or 11 (64-bit)
- An OpenAI API key
- A microphone, or system audio capture

## Licence

Copyright © 2026 Mytresh Ravi. All rights reserved.

SAGE is proprietary software, distributed as a compiled application. **This
repository hosts release downloads only — it does not contain source code**, and
the source is not licensed for reuse or derivative works.

**Interested in the source?** It is available for licensing, and enquiries are
welcome — please get in touch rather than extracting it:

> **mytresh1984@outlook.com**

## Responsible use

SAGE is a tool for preparation and live assistance. Some interview processes and
proctored assessments prohibit outside assistance — please use it in line with
the rules of any process you take part in.
