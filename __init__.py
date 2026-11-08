"""Cardlake for OpenClaw: your Cardlake cards in Telegram, visual and tappable."""

from __future__ import annotations

import os
import json
import logging
from pathlib import Path

logger = logging.getLogger(__name__)

CONFIG_DIR = Path(os.path.dirname(os.path.abspath(__file__)))
CARDLAKE_API_BASE = os.environ.get("CARDLAKE_API_URL", "https://cardlake.app")
CARDLAKE_TOKEN = os.environ.get("CARDLAKE_API_TOKEN", "")

# ── helpers ─────────────────────────────────────────────────────────────────


def _cardlake_api(path: str, method: str = "GET", body: dict | None = None) -> dict:
    """Raw Cardlake API call. Returns the response JSON or raises."""
    import urllib.request
    import urllib.error

    url = f"{CARDLAKE_API_BASE}/api{path}"
    headers = {
        "Authorization": f"Bearer {CARDLAKE_TOKEN}",
        "Content-Type": "application/json",
        "Accept": "application/json",
    }
    data = json.dumps(body).encode() if body else None
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        msg = f"Cardlake API error {e.code}: {e.read().decode(errors='replace')[:200]}"
        logger.error(msg)
        return {"error": msg}
    except Exception as e:
        logger.error(f"Cardlake API call failed: {e}")
        return {"error": str(e)}


# ── public API helpers ──────────────────────────────────────────────────────


def feed(limit: int = 20, **filters) -> list[dict]:
    resp = _cardlake_api("/feed", "POST", {"limit": limit, **filters})
    return resp.get("cards", [])


def today() -> list[dict]:
    resp = _cardlake_api("/feed", "POST", {"limit": 50, "types": ["reminder"]})
    return resp.get("cards", [])


def deal(limit: int = 5) -> list[dict]:
    resp = _cardlake_api("/feed/deal", "POST", {"limit": limit})
    return resp.get("cards", [])


def save_card(card_type: str, title: str, **kwargs) -> dict:
    return _cardlake_api(f"/cards/{card_type}", "POST", {"title": title, **kwargs})


def snooze_card(card_type: str, card_id: str, days: int = 1) -> dict:
    return _cardlake_api(f"/cards/{card_type}/{card_id}/snooze", "POST", {"days": days})


def complete_card(card_type: str, card_id: str) -> dict:
    return _cardlake_api(f"/cards/{card_type}/{card_id}/complete", "POST", {})


def search_cards(query: str, limit: int = 20) -> list[dict]:
    resp = _cardlake_api("/cards/search", "POST", {"query": query, "limit": limit})
    return resp.get("cards", [])


def get_card(card_type: str, card_id: str) -> dict | None:
    return _cardlake_api(f"/cards/{card_type}/{card_id}")


# ── environment ──────────────────────────────────────────────────────────────


def check_connection() -> str | None:
    """Returns None if connected, or an error message string."""
    if not CARDLAKE_TOKEN:
        return "Cardlake API token not configured. Set CARDLAKE_API_TOKEN."
    result = _cardlake_api("/account")
    if "error" in result:
        return f"Cardlake connection failed: {result['error']}"
    return None