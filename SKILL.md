# Cardlake for OpenClaw

Cardlake cards in OpenClaw — visual Telegram messages with inline buttons, daily morning digest, and AI-powered card saving.

## Prerequisites

- `CARDLAKE_API_TOKEN` environment variable set (get it from cardlake.app)
- Telegram channel configured in OpenClaw

## Commands

Available through chat:

- **`!cardlake feed`** — Show feed as visual card panels with buttons
- **`!cardlake feed <filter>`** — Filter: `reminders`, `learning`, `work`, `family`, `bookmarks`, `favorites`, `snoozed`
- **`!cardlake today`** — Overdue/due today reminders
- **`!cardlake deal`** — Random cards to review
- **`!cardlake save <text>`** — Save as a card (AI-classified)
- **`!cardlake snooze <text>`** — Snooze a matching card

### Card buttons

Each shown card gets inline buttons:
- **✅ Done** — complete a reminder or mark learning as watched
- **⏰ Tomorrow** — snooze 1 day
- **📅 Next week** — snooze 7 days
- **↩ Undo** — revert the last action

## Morning automation

Creates a daily digest of overdue/due cards. Set up via:
```
openclaw automations add ... 
```

## Connection

Requires a Cardlake account. The API token goes in your gateway env.