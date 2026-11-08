"""Inline button handlers for Telegram cards — Done, Tomorrow, Next week, Undo."""

from __future__ import annotations

import json
import logging
from typing import Any, Callable, Optional

from . import views

logger = logging.getLogger(__name__)

CALLBACK_PREFIX = "clk:"


def keyboard_for(card: Optional[dict], result: Optional[str] = None,
                 last: bool = False, has_undo: bool = False) -> list[list[dict]]:
    """Rows of inline buttons for a card message."""
    rows = []

    if card and card.get("id") and card.get("type"):
        if result:
            row = [{"text": f"✓ {result}", "callback_data": f"{CALLBACK_PREFIX}n"}]
            if has_undo:
                row.append({"text": "↩ Undo", "callback_data": f"{CALLBACK_PREFIX}u"})
            rows.append(row)
        elif card.get("_shown"):
            rows.append([
                {"text": "💾 Save to Cardlake", "callback_data": f"{CALLBACK_PREFIX}s"},
                {"text": "⏰ Remind tomorrow", "callback_data": f"{CALLBACK_PREFIX}r"},
            ])
        else:
            row = []
            if card.get("type") in ("reminder", "learning"):
                row.append({"text": "✅ Done", "callback_data": f"{CALLBACK_PREFIX}d"})
            row += [
                {"text": "⏰ Tomorrow", "callback_data": f"{CALLBACK_PREFIX}t"},
                {"text": "📅 Next week", "callback_data": f"{CALLBACK_PREFIX}w"},
            ]
            rows.append(row)

    if last:
        rows.append([
            {"text": "🔗 Open Cardlake", "url": views.CARDLAKE_OPEN_URL}
        ])

    return rows


class CardlakeButtons:
    """Manages inline buttons for Cardlake cards in Telegram."""

    def __init__(self, run_tool: Callable):
        self.run_tool = run_tool
        self._message_state: dict[tuple[str, str], dict] = {}

    def store(self, chat_id: str, msg_id: str, card: Optional[dict],
              result: Optional[str] = None, undo: list = None,
              last: bool = False):
        self._message_state[(chat_id, msg_id)] = {
            "card": card, "result": result,
            "undo": undo or [], "last": last,
        }

    def get_state(self, chat_id: str, msg_id: str) -> Optional[dict]:
        return self._message_state.get((chat_id, msg_id))

    def clear(self, chat_id: str, msg_id: str):
        self._message_state.pop((chat_id, msg_id), None)


def handle_tap(chat_id: str, message_id: str, data: str,
               buttons: CardlakeButtons,
               on_cardlake_call: Callable) -> tuple[str, Optional[str]]:
    """
    Handle a button tap. Returns (chat_message, new_text_or_None).
    chat_message is shown to the user as a toast; new_text is the updated
    message text when the card changes.
    """
    code = data[len(CALLBACK_PREFIX):]
    if code == "n":
        return "", None

    state = buttons.get_state(chat_id, message_id)
    if not state or state["card"] is None:
        return "These buttons are out of date.", None

    card = state["card"]
    title = views._plain(card.get("title")) or "Untitled"

    if code == "u":
        if not state["undo"]:
            return "Nothing to undo.", None
        for tool, args in state["undo"]:
            try:
                on_cardlake_call(tool, args)
            except Exception as e:
                return f"Couldn't undo: {e}", None
        state["result"] = None
        state["undo"] = []
        return f"↩ Undone: {title}", None

    if state["result"]:
        return f"Already {state['result'].lower()}.", None

    # Work out what to do
    action = self._action_for(card, code)
    if action is None:
        return "That button doesn't apply.", None

    (tool, args), said, undo = action
    try:
        result = on_cardlake_call(tool, args)
    except Exception as e:
        return f"Couldn't update Cardlake: {e}", None

    # If the tool created a card, store its id for undo
    if isinstance(result, dict) and "id" in result:
        undo = [(t, {k: (result["id"] if v == "$created" else v) for k, v in a.items()})
                for t, a in undo]

    state["result"] = said
    state["undo"] = undo
    return f"{said}: {title}", None

    @staticmethod
    def _action_for(card: dict, code: str) -> Optional[tuple]:
        """Returns ((tool, args), display_text, undo_steps) or None."""
        ref = {"card_type": card["type"], "card_id": card["id"]}

        if card.get("_shown"):
            if code == "s":
                from .views import _plain
                title = _plain(card.get("title")) or "Untitled"
                url = card.get("metadata", {}).get("url", "")
                create = ("create_learning", {"title": title, "url": url} if url else {"title": title})
                return create, "Saved", [("delete_learning", {"id": "$created"})]
            if code == "r":
                tomorrow = (views._now().date().isoformat())
                return ("create_reminder", {"title": card.get("title", ""), "due_date": tomorrow}), \
                       "Reminder for tomorrow", [("delete_reminder", {"id": "$created"})]
            return None

        if code in ("t", "w"):
            days = 1 if code == "t" else 7
            label = "tomorrow" if days == 1 else "a week"
            return ("snooze_card", {**ref, "days": days}), f"Snoozed until {label}", \
                   [("unsnooze_card", ref)]

        if code == "d":
            if card["type"] == "reminder":
                return ("complete_card", ref), "Done", [("uncomplete_card", ref)]
            if card["type"] == "learning":
                return ("mark_watched", ref), "Watched", [("mark_unwatched", ref)]

        return None