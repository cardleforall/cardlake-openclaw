#!/usr/bin/env python3
"""
Cardlake for OpenClaw — command dispatcher, button handler, and automation entry point.

Usage from OpenClaw:
  python3 cardlake.py feed           # !cardlake feed
  python3 cardlake.py today          # !cardlake today  
  python3 cardlake.py deal           # !cardlake deal
  python3 cardlake.py save <text>    # !cardlake save <text>
  python3 cardlake.py snooze <text>  # !cardlake snooze <text>
  python3 cardlake.py morning        # morning automation (returns SILENT if nothing due)
  python3 cardlake.py tap <chat> <msg> <code>  # button handler
"""

import os, sys, json, logging, re
from pathlib import Path

logging.basicConfig(level=logging.WARNING)
logger = logging.getLogger("cardlake")

# Ensure the cardlake package is importable
SCRIPT_DIR = Path(__file__).parent
sys.path.insert(0, str(SCRIPT_DIR))

from __init__ import (feed, search_cards, today_cards, deal as deal_api,
                      check_connection, create_reminder, create_learning,
                      create_talking_point, create_bookmark, create_work_item,
                      snooze_card, unsnooze_card, complete_card, like_card,
                      update_card, get_card)
from views import (feed_text, today_text, deal_text, _now, feed_parts,
                   today_parts, deal_parts, by_priority, panel_text,
                   mini_line, CARDLAKE_OPEN_URL)
from views import MAX_PANEL_CARDS, MAX_TOTAL_CARDS

STATE_FILE = SCRIPT_DIR / ".cardlake_state.json"
CALLBACK_PREFIX = "clk:"


# ── State persistence ────────────────────────────────────────────────────────


def _load_state() -> dict:
    if STATE_FILE.exists():
        try:
            return json.loads(STATE_FILE.read_text())
        except (json.JSONDecodeError, OSError):
            pass
    return {"messages": {}, "next_id": 1}


def _save_state(state: dict):
    STATE_FILE.write_text(json.dumps(state, indent=2))
    # Keep only last 200 messages
    while len(state["messages"]) > 200:
        state["messages"].pop(next(iter(state["messages"])))
    STATE_FILE.write_text(json.dumps(state, indent=2))


def _msg_key(chat_id: str, msg_id: str) -> str:
    return f"{chat_id}:{msg_id}"


def store_card(chat_id: str, msg_id: str, card: dict | None, idx: int = 0):
    state = _load_state()
    key = _msg_key(chat_id, msg_id)
    state["messages"][key] = {
        "card": card,
        "idx": idx,
        "result": None,
        "undo": [],
    }
    _save_state(state)


def get_card_state(chat_id: str, msg_id: str) -> dict | None:
    state = _load_state()
    return state["messages"].get(_msg_key(chat_id, msg_id))


def update_card_state(chat_id: str, msg_id: str, **updates):
    state = _load_state()
    key = _msg_key(chat_id, msg_id)
    if key in state["messages"]:
        state["messages"][key].update(updates)
        _save_state(state)


# ── Button action helpers ────────────────────────────────────────────────────


def _action_for(card: dict, code: str):
    """Returns (tool_call, label, undo_tool_calls) or None."""
    ref = {"card_type": card["type"], "card_id": card["id"]}

    if code == "d":  # Done
        if card["type"] == "reminder":
            return ("complete", "Done", [("uncomplete", ref)])
        if card["type"] == "learning":
            return ("complete", "Watched", [("uncomplete", ref)])
        return None
    if code == "t":  # Tomorrow
        return ("snooze", "Snoozed until tomorrow", [("unsnooze", ref)])
    if code == "w":  # Next week
        return ("snooze_7", "Snoozed for a week", [("unsnooze", ref)])
    return None


def _execute_action(action_type: str, card: dict):
    """Execute a card action via the Cardlake API."""
    try:
        if action_type == "complete":
            result = complete_card(card["type"], card["id"])
        elif action_type == "snooze":
            result = snooze_card(card["type"], card["id"], 1)
        elif action_type == "snooze_7":
            result = snooze_card(card["type"], card["id"], 7)
        elif action_type == "uncomplete":
            if card["type"] == "reminder":
                result = update_card("reminder", card["id"], completed=False)
            else:
                result = update_card("learning", card["id"], status="saved")
        elif action_type == "unsnooze":
            result = unsnooze_card(card["type"], card["id"])
        else:
            result = {"error": f"Unknown action: {action_type}"}
        if "error" in result:
            logger.error(f"Action {action_type} failed: {result['error']}")
            return False
        return True
    except Exception as e:
        logger.error(f"Action failed: {e}")
        return False


# ── Command handlers ─────────────────────────────────────────────────────────


def cmd_feed(args: str = "") -> str:
    now = _now()
    filters = {}
    if args:
        type_map = {
            "reminders": ["reminder"], "reminder": ["reminder"],
            "learning": ["learning"], "learnings": ["learning"],
            "work": ["work"], "family": ["family"],
            "bookmarks": ["bookmark"], "bookmark": ["bookmark"],
            "favorites": [], "favourite": [],
            "snoozed": [], "misc": ["talking_point"],
            "github": ["kanban"], "files": ["file"],
        }
        mapped = type_map.get(args.lower().rstrip("s"), [])
        if args.lower() == "snoozed":
            filters["view"] = "snoozed"
        elif args.lower() in ("favorites", "favourite"):
            filters["liked_only"] = True
        elif mapped:
            filters["types"] = mapped
    cards = feed(20, **filters)
    return feed_text(cards, now)


def cmd_today() -> str:
    now = _now()
    cards = feed(50)
    text = today_text(cards, now)
    if text is None:
        return "_Nothing is overdue or due today._\n\n🔗 [Open Cardlake]({})".format(CARDLAKE_OPEN_URL)
    return text


def cmd_deal() -> str:
    from views import is_overdue, is_due_today
    now = _now()
    cards = feed(50)
    # Filter out urgent/pinned for deal
    pool = [c for c in cards
            if not (is_overdue(c, now) or is_due_today(c, now))
            and not c.get("pinned_at")]
    import random
    dealt = random.sample(pool, min(5, len(pool)))
    return deal_text(dealt, now)


def cmd_save(text: str) -> str:
    if not text:
        return "Usage: `!cardlake save <text>`"
    result = create_talking_point(text[:80], content=text[:2000])
    if "error" in result:
        return f"❌ {result['error']}"
    return f"✅ Saved as Misc card."


def cmd_snooze(text: str) -> str:
    if not text:
        return "Usage: `!cardlake snooze <text>`"
    results = search_cards(text, 20)
    if not results:
        return f'_No card matches_ "{text}"'
    card = results[0]
    ct, cid = card.get("type", ""), card.get("id", "")
    result = snooze_card(ct, cid, 1)
    title = card.get("title", "Untitled")
    return f"⏰ Snoozed until tomorrow: _{title}_"


def cmd_morning() -> str:
    """Morning automation — returns 'SILENT' if nothing to send."""
    now = _now()
    cards = feed(50)
    text = today_text(cards, now)
    if text is None:
        return "SILENT"
    return text


def cmd_tap(chat_id: str, msg_id: str, code: str) -> str:
    """Handle a button tap."""
    state = get_card_state(chat_id, msg_id)
    if not state or not state.get("card"):
        return "These buttons are out of date."

    card = state["card"]

    if code == "u":  # Undo
        if not state.get("undo"):
            return "Nothing to undo."
        for undo_type in state["undo"]:
            _execute_action(undo_type, card)
        update_card_state(chat_id, msg_id, result=None, undo=[])
        return "↩ Undone."

    if state.get("result"):
        return f"Already done."

    action = _action_for(card, code)
    if not action:
        return "That button doesn't apply."

    ok = _execute_action(action, card)
    if not ok:
        return "Couldn't update Cardlake."

    _, label, undo = action
    update_card_state(chat_id, msg_id, result=label, undo=undo)
    return f"✅ {label}"


# ── Main dispatcher ──────────────────────────────────────────────────────────


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Commands: feed [filter], today, deal, save <text>, snooze <text>, morning, tap <chat> <msg> <code>")
        sys.exit(1)

    cmd = sys.argv[1]

    if cmd == "feed":
        result = cmd_feed(" ".join(sys.argv[2:]))
    elif cmd == "today":
        result = cmd_today()
    elif cmd == "deal":
        result = cmd_deal()
    elif cmd == "save":
        result = cmd_save(" ".join(sys.argv[2:]))
    elif cmd == "snooze":
        result = cmd_snooze(" ".join(sys.argv[2:]))
    elif cmd == "morning":
        result = cmd_morning()
    elif cmd == "tap":
        if len(sys.argv) < 5:
            result = "Usage: cardlake.py tap <chat_id> <msg_id> <code>"
        else:
            result = cmd_tap(sys.argv[2], sys.argv[3], sys.argv[4])
    elif cmd == "test":
        err = check_connection()
        result = f"✅ Connected to Cardlake" if not err else f"❌ {err}"
    else:
        result = f"Unknown command: {cmd}"

    print(result)