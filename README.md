# Cardlake for OpenClaw

[Cardlake](https://cardlake.app) cards in OpenClaw — visual Telegram messages with inline buttons, a morning digest, and AI-powered card saving.

## Setup

1. Get a Cardlake account at [cardlake.app](https://cardlake.app)
2. Set the API token:
   ```
   export CARDLAKE_API_TOKEN="your-token"
   ```
3. Add it to your OpenClaw `.env` or gateway config so it persists:
   ```json
   { "env": { "CARDLAKE_API_TOKEN": "your-token" } }
   ```

## Commands

| Command | What it does |
|---|---|
| `!cardlake feed` | Show your feed as visual cards |
| `!cardlake feed reminders` | Just reminders |
| `!cardlake feed learning` | Just learnings |
| `!cardlake feed work` | Just work items |
| `!cardlake today` | What's overdue or due today |
| `!cardlake deal` | Five random cards to review |
| `!cardlake save <text>` | Save text as a card |
| `!cardlake snooze <text>` | Snooze a matching card |

Each card appears with **✅ Done**, **⏰ Tomorrow**, and **📅 Next week** buttons. Tap one and the card updates instantly with an **↩ Undo** option.

## Morning automation

The daily digest runs automatically. Set the delivery channel and time:
```bash
openclaw automations list
```

## Architecture

- `__init__.py` — Cardlake API client
- `views.py` — Visual card rendering (Telegram quote blocks, emoji, urgency)
- `buttons.py` — Inline button definitions (Done, Snooze, Undo)
- `commands.py` — Command handlers
- `redact.py` — Secret redaction

## Self-hosted Cardlake

Set `CARDLAKE_API_URL` to your instance's address:
```
export CARDLAKE_API_URL="https://cardlake.example.com"
export CARDLAKE_URL="https://cardlake.example.com"
```