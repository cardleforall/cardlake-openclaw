# Cardlake for OpenClaw

Cardlake cards in OpenClaw: a `/cardlake` Telegram feed browser with Done and Snooze buttons, text commands, and a morning digest.

## Prerequisites

- `CARDLAKE_API_TOKEN` set in the gateway environment (from cardlake.app)
- `CARDLAKE_TELEGRAM_USER_ID` set to the owner's numeric Telegram user ID
- The `cardlake` plugin from this repository installed and enabled (see README.md)

## Telegram

- **`/cardlake`**: browse the feed one card at a time in a private chat, with ◀ Prev, 🔄 and Next ▶
- **`/cardlake <filter>`**: `reminders`, `learning`, `work`, `family`, `bookmarks`, `misc`, `github`, `files`, `favorites`

Buttons on the shown card:
- **✅ Done**: complete a reminder or mark a learning as watched
- **⏰ 1 day**: snooze for a day
- **📅 7 days**: snooze for a week
- **📌 Pin / Unpin**: pin or unpin the card
- **↩️ Undo**: shown after a Done or snooze; reverses it

The plugin handles these taps itself. Do not handle `callback_data` starting with `cardlake:` and do not run the Python `tap`, `button_handler.py` or `cardlake_bot.py done/snooze` scripts for button taps: they identify cards by message index and can act on the wrong card. If a user asks to act on a card shown by `/cardlake`, tell them to use its buttons or the Cardlake app.

## Text commands

Run from this directory:

- `python3 cardlake.py feed [filter]`: feed as text
- `python3 cardlake.py today`: overdue or due today
- `python3 cardlake.py deal`: five random cards
- `python3 cardlake.py save <text>`: save as a Misc card
- `python3 cardlake.py snooze <text>`: snooze the best search match for a day

## Morning automation

`morning.sh` prints a digest of overdue and due-today reminders, or nothing. Schedule it with `openclaw automations`.
