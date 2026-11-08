"""Cardlake for OpenClaw — MCP-based Cardlake API client.

Cardlake exposes an MCP (Model Context Protocol) server at /api/mcp.
All operations go through MCP JSON-RPC calls.
"""

from __future__ import annotations

import os
import json
import logging
import urllib.request
import urllib.error

logger = logging.getLogger(__name__)

CARDLAKE_API_BASE = os.environ.get("CARDLAKE_API_URL", "https://cardlake.app")
MCP_URL = f"{CARDLAKE_API_BASE}/api/mcp"
API_TOKEN = os.environ.get("CARDLAKE_API_TOKEN", "")

_ACCEPT = "application/json, text/event-stream"


def _rpc(method: str, params: dict | None = None) -> dict:
    """Call an MCP tool and return its result content."""
    if not API_TOKEN:
        return {"error": "CARDLAKE_API_TOKEN not set"}

    body = json.dumps({
        "jsonrpc": "2.0", "id": 1, "method": "tools/call",
        "params": {"name": method, "arguments": params or {}},
    }).encode()
    headers = {
        "Authorization": f"Bearer {API_TOKEN}",
        "Content-Type": "application/json",
        "Accept": _ACCEPT,
    }
    req = urllib.request.Request(MCP_URL, data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read())
    except urllib.error.HTTPError as e:
        msg = f"MCP error {e.code}: {e.read().decode(errors='replace')[:300]}"
        logger.error(msg)
        return {"error": msg}
    except Exception as e:
        logger.error(f"MCP call failed: {e}")
        return {"error": str(e)}

    err = data.get("error")
    if err:
        return {"error": err.get("message", str(err))}

    content = data.get("result", {}).get("content", [])
    # Extract text content
    texts = [item["text"] for item in content if item.get("type") == "text"]
    if not texts:
        return {"error": "No text content in response"}

    try:
        return json.loads(texts[0])
    except (ValueError, TypeError):
        return {"text": texts[0]}


# ── Feed ─────────────────────────────────────────────────────────────────────


def feed(limit: int = 20, **filters) -> list[dict]:
    result = _rpc("list_feed", {"limit": min(limit, 50), **filters})
    if "error" in result:
        logger.warning(f"list_feed error: {result['error']}")
        return []
    return result.get("cards", [])


def search_cards(query: str, limit: int = 20) -> list[dict]:
    result = _rpc("search_cards", {"query": query, "limit": min(limit, 50)})
    return result.get("cards", [])


def get_card(card_type: str, card_id: str) -> dict | None:
    result = _rpc("get_card", {"card_type": card_type, "card_id": card_id})
    return result if "error" not in result else None


# ── Create ────────────────────────────────────────────────────────────────────


def create_reminder(title: str, due_date: str | None = None, **kw) -> dict:
    return _rpc("create_reminder", {"title": title, **({"due_date": due_date} if due_date else {}), **kw})


def create_learning(title: str, url: str = "", notes: str = "", category: str = "others", **kw) -> dict:
    args = {"title": title, "category": category}
    if url:
        args["url"] = url
    if notes:
        args["notes"] = notes
    args.update(kw)
    return _rpc("create_learning", args)


def create_work_item(title: str, **kw) -> dict:
    return _rpc("create_work_item", {"title": title, **kw})


def create_bookmark(title: str, url: str = "", notes: str = "", **kw) -> dict:
    args = {"title": title}
    if url:
        args["url"] = url
    if notes:
        args["notes"] = notes
    args.update(kw)
    return _rpc("create_bookmark", args)


def create_talking_point(section_title: str, content: str, **kw) -> dict:
    return _rpc("create_talking_point", {"section_title": section_title, "content": content, **kw})


def create_file(title: str, **kw) -> dict:
    return _rpc("create_file", {"title": title, **kw})


# ── Update / Actions ─────────────────────────────────────────────────────────


def update_card(card_type: str, card_id: str, **updates) -> dict:
    return _rpc(f"update_{card_type}", {"id": card_id, **updates})


def delete_card(card_type: str, card_id: str) -> dict:
    return _rpc(f"delete_{card_type}", {"id": card_id})


def snooze_card(card_type: str, card_id: str, days: int = 1) -> dict:
    return _rpc("snooze_card", {"card_type": card_type, "card_id": card_id, "days": days})


def unsnooze_card(card_type: str, card_id: str) -> dict:
    return _rpc("unsnooze_card", {"card_type": card_type, "card_id": card_id})


def pin_card(card_type: str, card_id: str) -> dict:
    return _rpc("pin_card", {"card_type": card_type, "card_id": card_id})


def like_card(card_type: str, card_id: str, liked: bool = True) -> dict:
    return _rpc("like_card", {"card_type": card_type, "card_id": card_id, "liked": liked})


def complete_card(card_type: str, card_id: str) -> dict:
    if card_type == "reminder":
        return _rpc("update_reminder", {"id": card_id, "completed": True})
    if card_type == "learning":
        return _rpc("update_learning", {"id": card_id, "status": "watched"})
    return {"error": f"Can't complete card type: {card_type}"}


# ── Convenience ──────────────────────────────────────────────────────────────


def today_cards() -> list[dict]:
    """Reminders that are overdue or due today (uncompleted)."""
    all_reminders = feed(50, types=["reminder"])
    return [c for c in all_reminders
            if not (c.get("metadata") or {}).get("completed")]


def deal(limit: int = 5) -> list[dict]:
    return feed(50, sort="newest")


def check_connection() -> str | None:
    """Returns None if connected, or error string."""
    if not API_TOKEN:
        return "CARDLAKE_API_TOKEN not set."
    result = _rpc("list_feed", {"limit": 1})
    return None if "error" not in result else f"Cardlake: {result['error']}"