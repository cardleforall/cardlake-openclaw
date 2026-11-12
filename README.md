# Cardlake for OpenClaw

[Cardlake](https://cardlake.app) cards in OpenClaw: browse your feed in Telegram with `/cardlake`, mark cards done or snooze them with inline buttons, and get a morning digest.

There are two parts:

- **The `/cardlake` plugin** (`index.mjs`, `lib/`): a native OpenClaw plugin that owns the Telegram command and its buttons. This is the only part that handles button taps.
- **Python helpers** (`cardlake.py`, `__init__.py`, `views.py`, `morning.sh`): text commands and the morning digest, run as scripts.

## `/cardlake` in Telegram

Send `/cardlake` in your private chat with the bot. One message shows one card at a time:

```
🗂 Cardlake
Card 1 of 10+

🔔 Reminder · ⚠️ overdue 2d
Renew passport

[ ✅ Done ] [ ⏰ 1 day ] [ 📅 7 days ]
[ ◀ Prev ] [ 🔄 ] [ Next ▶ ]
```

- **◀ Prev / Next ▶** browse the feed in Cardlake's own order, ten cards per page, fetching further pages as you go. **🔄** reloads the current page.
- **✅ Done** completes a reminder or marks a learning as watched. It is shown only for those two types. Completing a recurring reminder moves it to its next due date, and the message says so.
- **⏰ 1 day / 📅 7 days** snooze the card. The message shows the time Cardlake reports it will return.
- **📌 Pin / Unpin** pins or unpins the card in Cardlake and confirms it by reading the card back.
- **↩️ Undo** replaces the action buttons after a confirmed Done or snooze, for 24 hours or until **🔄**. It reopens the reminder, restores the learning's previous status, or unsnoozes the card (pinning it again if the action unpinned it), then reads it back before saying "Undone." A recurring reminder's Done has no Undo, since its due date has already moved on.
- `/cardlake <filter>` limits the feed: `reminders`, `learning`, `work`, `family`, `bookmarks`, `misc`, `github`, `files`, `favorites`.

The message is edited in place; once a card has been updated, its action buttons are replaced by **↩️ Undo**.

### Setup

The gateway environment needs:

| Variable | |
|---|---|
| `CARDLAKE_API_TOKEN` | Cardlake API token (from cardlake.app). |
| `CARDLAKE_TELEGRAM_USER_ID` | Numeric Telegram user ID of the one person allowed to use `/cardlake`. The token gives full access to that person's Cardlake, so nobody else is served. |
| `CARDLAKE_API_URL` | Optional. HTTPS base URL of a self-hosted Cardlake. The token is sent there, so only use a server you trust. |

Then, as the gateway operator:

1. Install and enable this directory as a local plugin with `openclaw plugins install <path>` (or your usual plugin workflow). Its id is `cardlake`; it registers the `/cardlake` command and the `cardlake` Telegram callback namespace.
2. Allow inline buttons in private chats if they aren't already: `channels.telegram.capabilities.inlineButtons` must be `dm`, `all`, or `allowlist` with you on the allowlist.
3. Restart or reload the gateway so the plugin and environment are picked up.

This repository does not change any OpenClaw configuration by itself. If an older Cardlake button plugin (`cardlake-buttons`) is installed, disable it first: both register `/cardlake`.

### How taps are protected

- **Who:** `/cardlake` and every tap are accepted only from `CARDLAKE_TELEGRAM_USER_ID`, authorized by OpenClaw, in a private chat (chat id = user id), on the Telegram account that issued the view. Group chats are refused. Anything else gets "only available to its owner" and Cardlake is not contacted.
- **Which message:** each view has a random 16-character id in its `callback_data`, bound to the message on its first tap. Button indexes are never reused across messages.
- **Stale buttons:** every edit bumps a revision carried by the buttons. A tap on an older keyboard (for example after a failed edit, or a quick double tap) re-renders the current view instead of acting, so a button can only act on the card it was shown with. Views expire after 24 hours idle or when the gateway restarts; old buttons then say "expired" and are removed.
- **Duplicates:** one tap at a time per view, one update at a time per card across all views, and a card that has been updated (in any view) cannot be updated again from another view.
- **Before writing,** the card is re-read. If it was deleted, already finished, already snoozed, or its title, due date or status changed since it was shown, nothing is written; the view shows the current card instead.
- **After writing,** success is only reported when confirmed: a snooze must come back with the same card and a `snoozed_until`, and a completion is read back from Cardlake. A timeout, server error or unreadable response means the write may or may not have happened. The card is then marked "Cardlake did not confirm the update" and its buttons are disabled for 10 minutes (or until **🔄**), rather than repeating the write.
- **Errors** are explained in the message: a rejected API token, Cardlake unreachable, a request Cardlake refused (and that nothing changed), or a missing configuration. The token never appears in messages or logs.

### Limits

- State is in memory: views do not survive a gateway restart, and two gateway processes do not share it.
- Re-reading before a write narrows but cannot close the window in which another client changes the card.
- Paging follows Cardlake's cursors. After cards are snoozed or completed, the feed shifts, so a later page may skip or repeat a card. **🔄** reloads.
- There is no Undo. Use the Cardlake app to reverse an action.

## Python text commands

`cardlake.py` prints text for use from scripts or the agent:

```sh
python3 cardlake.py feed [filter]   # feed as text
python3 cardlake.py today           # overdue or due today
python3 cardlake.py deal            # five random cards
python3 cardlake.py save <text>     # save as a Misc card
python3 cardlake.py snooze <text>   # snooze the best search match for a day
python3 cardlake.py morning         # digest, or SILENT if nothing is due
python3 cardlake.py test            # check the connection
```

The older `tap` command, `button_handler.py`, `buttons.py` and `cardlake_bot.py --buttons` are not Telegram callback handlers and should not be wired to buttons: they look cards up by message index. Use the `/cardlake` plugin for buttons.

## Morning automation

`morning.sh` prints the digest of overdue and due-today reminders, or nothing. Schedule it with `openclaw automations`.

## Self-hosted Cardlake

```sh
export CARDLAKE_API_URL="https://cardlake.example.com"   # API (plugin and Python)
export CARDLAKE_URL="https://cardlake.example.com"       # "Open Cardlake" links in the Python views
```

## Architecture

- `index.mjs`, `openclaw.plugin.json`, `package.json`: OpenClaw plugin entry and metadata
- `lib/client.mjs`: Cardlake MCP client with classified errors
- `lib/view.mjs`: Telegram card rendering (types, urgency, buttons)
- `lib/browser.mjs`: `/cardlake` sessions, authorization, browsing and Done/Snooze
- `__init__.py`: Python Cardlake API client
- `views.py`: Python text rendering (cards, urgency, digest)
- `cardlake.py`: Python command dispatcher
- `redact.py`: secret redaction

## Tests

```sh
npm test
# or separately:
node --test 'tests/*.test.mjs'
python3 -m unittest discover -s tests -v
```

The tests use a scripted fake Cardlake and fake Telegram callbacks. They need no network, token or Telegram account.

Two contract tests run against the OpenClaw installed on the machine, and are skipped if it can't be found (set `OPENCLAW_DIST` to its `dist/` directory):

- `renderer.contract.test.mjs` sends card text through OpenClaw's Telegram renderer.
- `scanner.contract.test.mjs` runs OpenClaw's code-safety scanner, the one `openclaw security audit --deep` applies to installed plugins, over this whole directory (tests included) and `SKILL.md`. It fails on any critical or warn finding. Keep `child_process`, `eval`, and `process.env` next to `fetch(` out of every `.mjs` file here, including tests.
