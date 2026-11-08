#!/usr/bin/env python3
"""
Cardlake button handler for OpenClaw Telegram command buttons.

Usage:
  python3 button_handler.py <action>
  
Where action is one of:
  done <chat_id> <msg_idx>   — Complete a card (reminder/learning)
  snooze1 <chat_id> <msg_idx> — Snooze 1 day
  snooze7 <chat_id> <msg_idx> — Snooze 7 days
  undo <chat_id> <msg_idx>    — Undo last action

The handler reads card state from .cardlake_state.json.
"""

import sys, os, json, re
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from __init__ import complete_card, snooze_card, unsnooze_card, update_card, delete_card
from views import CARD_TYPES

STATE_FILE = Path(__file__).parent / ".cardlake_state.json"


def load_state() -> dict:
    if STATE_FILE.exists():
        try:
            return json.loads(STATE_FILE.read_text())
        except (json.JSONDecodeError, OSError):
            pass
    return {"messages": {}}


def save_state(state: dict):
    STATE_FILE.write_text(json.dumps(state, indent=2))


def get_card_by_idx(chat_id: str, msg_idx: str) -> dict | None:
    state = load_state()
    key = f"{chat_id}:{msg_idx}"
    entry = state["messages"].get(key)
    return entry


def store_card_state(chat_id: str, msg_idx: str, card: dict):
    state = load_state()
    key = f"{chat_id}:{msg_idx}"
    state["messages"][key] = {
        "card": card,
        "result": None,
        "undo": [],
    }
    save_state(state)


def update_state(chat_id: str, msg_idx: str, **updates):
    state = load_state()
    key = f"{chat_id}:{msg_idx}"
    if key in state["messages"]:
        state["messages"][key].update(updates)
        save_state(state)


def clk_done(chat_id: str, msg_idx: str) -> str:
    entry = get_card_by_idx(chat_id, msg_idx)
    if not entry or not entry.get("card"):
        return "Card not found. Feed may be out of date."
    card = entry["card"]
    ct = card.get("type", "")
    cid = card.get("id", "")
    result = complete_card(ct, cid)
    if "error" in result:
        return f"Error: {result['error']}"
    update_state(chat_id, msg_idx, result="Done", undo=[f"uncomplete"])
    title = card.get("title", "Card")
    return f"✅ Done: {title}"


def clk_snooze1(chat_id: str, msg_idx: str) -> str:
    entry = get_card_by_idx(chat_id, msg_idx)
    if not entry or not entry.get("card"):
        return "Card not found."
    card = entry["card"]
    ct = card.get("type", "")
    cid = card.get("id", "")
    snooze_card(ct, cid, 1)
    update_state(chat_id, msg_idx, result="Tomorrow", undo=["unsnooze"])
    title = card.get("title", "Card")
    return f"⏰ Snoozed until tomorrow: {title}"


def clk_snooze7(chat_id: str, msg_idx: str) -> str:
    entry = get_card_by_idx(chat_id, msg_idx)
    if not entry or not entry.get("card"):
        return "Card not found."
    card = entry["card"]
    ct = card.get("type", "")
    cid = card.get("id", "")
    snooze_card(ct, cid, 7)
    update_state(chat_id, msg_idx, result="Next week", undo=["unsnooze"])
    title = card.get("title", "Card")
    return f"📅 Snoozed for a week: {title}"


def clk_undo(chat_id: str, msg_idx: str) -> str:
    entry = get_card_by_idx(chat_id, msg_idx)
    if not entry:
        return "Nothing to undo."
    card = entry["card"]
    if not entry.get("result"):
        return "Nothing to undo."
    ct = card.get("type", "")
    cid = card.get("id", "")
    
    # Undo based on what was done
    if entry["result"] in ("Done",):
        if ct == "reminder":
            update_card("reminder", cid, completed=False)
        elif ct == "learning":
            update_card("learning", cid, status="saved")
    elif entry["result"] in ("Tomorrow", "Next week"):
        unsnooze_card(ct, cid)
    
    update_state(chat_id, msg_idx, result=None, undo=[])
    title = card.get("title", "Card")
    return f"↩ Undone: {title}"


if __name__ == "__main__":
    if len(sys.argv) < 4:
        print("Usage: button_handler.py <done|snooze1|snooze7|undo> <chat_id> <msg_idx>")
        sys.exit(1)
    
    action = sys.argv[1]
    chat_id = sys.argv[2]
    msg_idx = sys.argv[3]
    
    if action == "done":
        print(clk_done(chat_id, msg_idx))
    elif action == "snooze1":
        print(clk_snooze1(chat_id, msg_idx))
    elif action == "snooze7":
        print(clk_snooze7(chat_id, msg_idx))
    elif action == "undo":
        print(clk_undo(chat_id, msg_idx))
    else:
        print(f"Unknown action: {action}")