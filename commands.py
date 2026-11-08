"""Command handlers for !cardlake feed/today/deal/save/snooze."""

from __future__ import annotations

import json
import logging
from typing import Any, Optional

from . import views
from .buttons import CardlakeButtons, keyboard_for, CALLBACK_PREFIX

logger = logging.getLogger(__name__)


def handle_callback(chat_id: str, message_id: str, data: str,
                    buttons: CardlakeButtons, cardlake_call) -> str:
    """Process a button tap. Returns toast text for Telegram."""
    toast, _ = buttons_utils.handle_tap(chat_id, message_id, data, buttons, cardlake_call)
    return toast


def cmd_feed(ctx, buttons: Optional[CardlakeButtons] = None, filter_type: str = "") -> str:
    """!cardlake feed — show the feed as visual cards."""
    from . import feed as feed_api

    now = views._now()
    filters = {}
    if filter_type:
        from .views import CARD_TYPES
        type_map = {"reminders": "reminder", "learning": "learning", "learnings": "learning",
                    "work": "work", "family": "family", "bookmarks": "bookmark",
                    "favorites": "favorite", "snoozed": "snoozed"}
        mapped = type_map.get(filter_type.lower().rstrip("s"), filter_type)
        if mapped == "snoozed":
            filters["view"] = "snoozed"
        elif mapped == "favorite":
            filters["liked_only"] = True
        else:
            filters["types"] = [mapped]

    cards = feed_api(20, **filters)
    parts = views.feed_parts(cards, now)
    return _send_or_text(parts, buttons)


def cmd_today(ctx, buttons: Optional[CardlakeButtons] = None) -> str:
    """!cardlake today — what's overdue or due today."""
    from . import today as today_api

    now = views._now()
    cards = today_api()
    text = views.today_text(cards, now)
    if text is None:
        return "_Nothing is overdue or due today._\n\n🔗 [Open Cardlake]({})".format(views.CARDLAKE_OPEN_URL)

    parts = views.today_parts(cards, now)
    return _send_or_text(parts, buttons)


def cmd_deal(ctx, buttons: Optional[CardlakeButtons] = None) -> str:
    """!cardlake deal — five random cards to review."""
    from . import deal as deal_api

    now = views._now()
    cards = deal_api()
    dealt = views.deal_pick(cards, now)
    parts = views.deal_parts(dealt, now)
    return _send_or_text(parts, buttons)


def cmd_save(raw_args: str) -> str:
    """!cardlake save <text> — save as a card."""
    if not raw_args:
        return "Usage: `!cardlake save <text>`"
    # TODO: use AI to classify the card type
    return _simple_save(raw_args)


def cmd_snooze(raw_args: str) -> str:
    """!cardlake snooze <text> — snooze a matching card."""
    if not raw_args:
        return "Usage: `!cardlake snooze <text>`"

    from . import search_cards as search_api
    results = search_api(raw_args, 20)
    if not results:
        return f'_No card matches_ "{raw_args}"'

    card = results[0]
    from . import snooze_card as snooze_api
    result = snooze_api(card.get("type", ""), card.get("id", ""), 1)
    title = views._plain(card.get("title")) or "Untitled"
    return f"⏰ Snoozed until tomorrow: _{title}_"


# ── helpers ──────────────────────────────────────────────────────────────────


def _simple_save(text: str) -> str:
    """Basic save without AI classification — creates a talking-point card."""
    from . import save_card as save_api
    result = save_api("talking_point", text[:80],
                      **{"content": text[:2000]})
    if "error" in result:
        return f"❌ Couldn't save: {result['error']}"
    return f"✅ Saved as Misc card."


def _send_or_text(parts: list, buttons: Optional[CardlakeButtons]) -> str:
    """Send as visual cards if buttons are available, else return text."""
    if buttons and len(parts) > 1:
        # We'll send via the message tool — return the first part as preview text
        # and store state for button handling
        return parts[0][0]  # Will be replaced by actual button sending
    return "\n\n".join(t for t, _ in parts)