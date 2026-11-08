#!/usr/bin/env python3
"""
Cardlake Bot — complete feed/today/deal with button support.

Outputs JSON with:
  {"text": "...formatted feed...", "buttons": [{"idx": 1, "type": "reminder", "id": "...", "title": "..."}, ...]}

Use --buttons to include the button metadata in the output.
"""

import sys, os, json, random
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from __init__ import feed as feed_api, search_cards, check_connection
from __init__ import snooze_card, create_talking_point, complete_card, unsnooze_card
from __init__ import update_card as update_card_api
from views import _now, urgency_label, CARDLAKE_OPEN_URL, CARD_TYPES
from views import by_priority, is_overdue, is_due_today

MAX_BUTTON_CARDS = 3


def _clean(text, max_len=200):
    """Clean text for Telegram display."""
    t = str(text).replace('[', '(').replace(']', ')').replace('_', '\\_')
    t = t.replace('*', '\\*').replace('`', '\\`')
    return t[:max_len] if len(t) > max_len else t


def _card_button_info(card, idx):
    """Return button metadata for a card."""
    emoji, label = CARD_TYPES.get(card.get('type', ''), ('🃏', 'Card'))
    title = _clean(card.get('title', 'Untitled'), 50)
    return {
        "idx": idx,
        "type": card.get('type', ''),
        "id": card.get('id', ''),
        "title": title,
        "emoji": emoji,
        "label": label,
    }


def format_feed(cards, heading, include_buttons=False):
    """One message: 3 card panels with urgency, then mini-lines, then link.
    Returns {"text": str, "buttons": list}."""
    now = _now()
    sorted_cards = by_priority(cards, now)
    total = len(cards)

    lines = [f'**{heading}** · {total} cards', '']
    button_info = []

    for i, card in enumerate(sorted_cards[:MAX_BUTTON_CARDS]):
        emoji, label = CARD_TYPES.get(card.get('type', ''), ('🃏', 'Card'))
        urg = urgency_label(card, now)
        pin = ' 📌' if card.get('pinned_at') else ''
        meta = f' · {urg}' if urg else ''
        title = _clean(card.get('title', 'Untitled'))
        lines.append(f'> {emoji} **{label}**{meta}{pin}')
        lines.append(f'> **{title}**')
        lines.append('')
        if include_buttons:
            button_info.append(_card_button_info(card, i + 1))

    for card in sorted_cards[3:10]:
        emoji, _ = CARD_TYPES.get(card.get('type', ''), ('🃏', ''))
        title = _clean(card.get('title', 'Untitled'))
        lines.append(f'{emoji} {title}')

    if total > 10:
        lines.append(f'*…and {total - 10} more in Cardlake.*')

    lines.append('')
    lines.append(f'🔗 [Open Cardlake]({CARDLAKE_OPEN_URL})')

    return {"text": '\n'.join(lines), "buttons": button_info}


def cmd_feed(include_buttons=False):
    cards = feed_api(20)
    return format_feed(cards, "🗂 Your Cardlake Feed", include_buttons)


def cmd_today(include_buttons=False):
    now = _now()
    cards = feed_api(50)
    due = [c for c in cards if is_overdue(c, now) or is_due_today(c, now)]
    if not due:
        return {"text": "_Nothing overdue or due today._\n\n🔗 [Open Cardlake]({})".format(CARDLAKE_OPEN_URL),
                "buttons": []}
    overdue_count = sum(1 for c in due if is_overdue(c, now))
    summary = f'{overdue_count} overdue' if overdue_count else ''
    due_today = len(due) - overdue_count
    if due_today:
        summary += f', {due_today} due today' if summary else f'{due_today} due today'
    return format_feed(cards, f"☀️ Today in Cardlake · {summary}", include_buttons)


def cmd_deal(include_buttons=False):
    now = _now()
    cards = feed_api(50)
    pool = [c for c in cards
            if not (is_overdue(c, now) or is_due_today(c, now))
            and not c.get('pinned_at')]
    dealt = random.sample(pool, min(5, len(pool)))
    return format_feed(dealt, "🃏 Deal me 5", include_buttons)


def cmd_morning():
    now = _now()
    cards = feed_api(50)
    due = [c for c in cards if is_overdue(c, now) or is_due_today(c, now)]
    if not due:
        return "SILENT"
    result = format_feed(cards, "☀️ Cardlake Morning")
    return result["text"]


# ── Button actions ────────────────────────────────────────────────────────


def btn_done(card_type, card_id):
    result = complete_card(card_type, card_id)
    return None if "error" in result else "Done"


def btn_snooze(card_type, card_id, days=1):
    result = snooze_card(card_type, card_id, days)
    return None if "error" in result else f"Snoozed {'tomorrow' if days == 1 else 'a week'}"


def btn_undo(card_type, card_id, last_action):
    if last_action == "Done":
        if card_type == "reminder":
            update_card_api("reminder", card_id, completed=False)
        elif card_type == "learning":
            update_card_api("learning", card_id, status="saved")
        return "Undone"
    if last_action in ("Tomorrow", "Next week"):
        unsnooze_card(card_type, card_id)
        return "Unsnoozed"
    return "Nothing to undo"


if __name__ == '__main__':
    import sys
    if len(sys.argv) < 2:
        print('Usage: cardlake_bot.py <feed|today|deal|morning|done|snooze|undo> [args]')
        sys.exit(1)

    cmd = sys.argv[1]
    has_buttons = '--buttons' in sys.argv

    err = check_connection()
    if err and cmd not in ('done', 'snooze', 'undo'):
        print(json.dumps({"error": err}))
        sys.exit(1)

    if cmd == 'feed':
        data = cmd_feed(has_buttons)
        print(json.dumps(data) if has_buttons else data["text"])

    elif cmd == 'today':
        data = cmd_today(has_buttons)
        print(json.dumps(data) if has_buttons else data["text"])

    elif cmd == 'deal':
        data = cmd_deal(has_buttons)
        print(json.dumps(data) if has_buttons else data["text"])

    elif cmd == 'morning':
        print(cmd_morning())

    elif cmd == 'done':
        ct, cid = sys.argv[2], sys.argv[3]
        result = btn_done(ct, cid)
        print(result if result else "Error updating card")

    elif cmd == 'snooze':
        ct, cid, days = sys.argv[2], sys.argv[3], int(sys.argv[4]) if len(sys.argv) > 4 else 1
        result = btn_snooze(ct, cid, days)
        print(result if result else "Error snoozing card")

    elif cmd == 'undo':
        ct, cid, last = sys.argv[2], sys.argv[3], sys.argv[4]
        print(btn_undo(ct, cid, last))

    else:
        print(json.dumps({"error": f"Unknown: {cmd}"}))