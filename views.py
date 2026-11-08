"""Visual card rendering for Telegram — quote-block cards with emoji, status, and urgency indicators."""

from __future__ import annotations

import os
import re
from datetime import date, datetime, timezone
from typing import Optional
from urllib.parse import urlparse
from zoneinfo import ZoneInfo

CARDLAKE_OPEN_URL = os.environ.get("CARDLAKE_URL", "https://cardlake.app") + "/vault/"

# Card type → (emoji, label)
CARD_TYPES = {
    "reminder": ("🔔", "Reminder"),
    "learning": ("📚", "Learning"),
    "work": ("💼", "Work item"),
    "family": ("👪", "Family"),
    "bookmark": ("🔖", "Bookmark"),
    "talking_point": ("💬", "Misc"),
    "kanban": ("🗂", "GitHub issue"),
    "file": ("📎", "File"),
}
# Priority order for showing cards
TYPE_ORDER = ["reminder", "learning", "work", "family", "bookmark", "talking_point", "kanban", "file"]

MAX_PANEL_CARDS = 3
MAX_TOTAL_CARDS = 10


def _now() -> datetime:
    """Now in the configured time zone (UTC fallback)."""
    tz_name = os.environ.get("TZ", "").strip()
    try:
        return datetime.now(ZoneInfo(tz_name) if tz_name else datetime.now().astimezone().tzinfo)
    except Exception:
        return datetime.now().astimezone()


def _parse_meta(card: dict) -> dict:
    return card.get("metadata") or {}


def _due_info(card: dict, now: datetime) -> Optional[tuple[date, bool]]:
    """(due date, whether overdue) for unfinished reminders."""
    meta = _parse_meta(card)
    if card.get("type") != "reminder" or meta.get("completed") or not meta.get("due_date"):
        return None
    try:
        due = datetime.fromisoformat(str(meta["due_date"]).replace("Z", "+00:00"))
    except ValueError:
        return None
    if due.tzinfo is None:
        due = due.replace(tzinfo=timezone.utc)
    if (due.hour, due.minute, due.second, due.microsecond) == (0, 0, 0, 0):
        return due.date(), due.date() < now.date()
    return due.astimezone(now.tzinfo).date(), due < now


def urgency_label(card: dict, now: datetime) -> str:
    """Short urgency text: '⚠️ overdue 3 days', '📅 due today', or ''."""
    info = _due_info(card, now)
    if not info:
        return ""
    day, passed = info
    late = (now.date() - day).days
    if passed and late > 0:
        return f"⚠️ overdue {late}d"
    if passed:
        return "⚠️ overdue"
    if day == now.date():
        return "📅 due today"
    return f"due {day:%d %b}"


def is_overdue(card: dict, now: datetime) -> bool:
    info = _due_info(card, now)
    return info is not None and info[1]


def is_due_today(card: dict, now: datetime) -> bool:
    info = _due_info(card, now)
    return info is not None and info[0] == now.date() and not info[1]


def _plain(text) -> str:
    """Clean text for Telegram — remove markdown-breaking chars."""
    if not text:
        return ""
    text = re.sub(r"\s+", " ", str(text)).strip()
    return text.replace("[", "(").replace("]", ")").replace("_", r"\_").replace("*", r"\*").replace("`", r"\`")


def _link_url(card: dict) -> str:
    url = str(card.get("metadata", {}).get("url", "")).strip()
    if re.match(r"https?://[^\s()]+$", url):
        host = urlparse(url).hostname or ""
        host = host[4:] if host.startswith("www.") else host
        return url, host
    return "", ""


def _type_info(card: dict) -> tuple[str, str]:
    return CARD_TYPES.get(card.get("type"), ("🃏", "Card"))


def panel_text(card: dict, now: datetime) -> str:
    """Full card as a Telegram quote-block panel."""
    emoji, label = _type_info(card)
    meta = _parse_meta(card)

    # Top line: type + urgency + pin
    parts = [f"{emoji} **{label}**"]
    urg = urgency_label(card, now)
    if urg:
        parts.append(urg)
    if card.get("pinned_at"):
        parts.append("📌")
    top = " · ".join(parts)

    # Title
    title = _plain(card.get("title")) or "_Untitled_"
    lines = [f"> {top}", f"> **{title}**"]

    # Link
    url, host = _link_url(card)
    if url:
        lines.append(f"> [{host}]({url})")

    return "\n".join(lines)


def mini_line(card: dict, now: datetime) -> str:
    """One-liner for compact display."""
    emoji, _ = _type_info(card)
    title = _plain(card.get("title")) or "Untitled"
    parts = [f"{emoji} {title}"]
    urg = urgency_label(card, now)
    if urg:
        parts.append(urg)
    url, host = _link_url(card)
    if url:
        parts.append(f"[{host}]({url})")
    return "— " + " · ".join(parts)


def by_priority(cards: list[dict], now: datetime) -> list[dict]:
    """Sort: overdue first, due today second, pinned third, then by type priority."""
    def rank(c: dict) -> tuple:
        if is_overdue(c, now):
            return (0,)
        if is_due_today(c, now):
            return (1,)
        pinned = 0 if c.get("pinned_at") else 1
        type_idx = TYPE_ORDER.index(c.get("type")) if c.get("type") in TYPE_ORDER else 99
        return (2, pinned, type_idx)
    return sorted(cards, key=rank)


# ── Today checklist ──────────────────────────────────────────────────────────


def today_cards(cards: list[dict], now: datetime) -> list[dict]:
    """Filter to overdue + due today reminders."""
    return [c for c in cards if is_overdue(c, now) or is_due_today(c, now)]


def checklist(cards: list[dict], now: datetime, results: dict[str, str] = None) -> str:
    """Pinned checklist of today's cards with completion marks."""
    results = results or {}
    lines = []
    due = today_cards(cards, now)
    for card in due[:MAX_TOTAL_CARDS]:
        title = _plain(card.get("title")) or "Untitled"
        cid = str(card.get("id"))
        if cid in results:
            lines.append(f"✅ {title} · _{results[cid]}_")
        else:
            lines.append(f"⬜ {title}")
    overdue_count = sum(1 for c in due if is_overdue(c, now))
    left = sum(1 for c in due if str(c.get("id")) not in (results or {}))
    summary_parts = []
    if overdue_count:
        summary_parts.append(f"{overdue_count} overdue")
    if left:
        summary_parts.append(f"{left} left")
    if not left:
        summary_parts.append("🎉 all clear")
    heading = f"**☀️ Today** · {' · '.join(summary_parts)}"
    body = "\n".join(lines) if lines else "_Nothing due today._"
    return f"{heading}\n\n{body}"


# ── Feed views ───────────────────────────────────────────────────────────────


def feed_text(cards: list[dict], now: datetime, heading: str = "🗂 Your Feed") -> str:
    """Full feed as chat message: top cards as panels, rest as mini lines."""
    if not cards:
        return f"{heading}\n\n_Your feed is empty._\n\nOpen Cardlake: {CARDLAKE_OPEN_URL}"

    sorted_cards = by_priority(cards, now)
    shown = sorted_cards[:MAX_TOTAL_CARDS]
    panels = shown[:MAX_PANEL_CARDS]
    rest = shown[MAX_PANEL_CARDS:]

    lines = [f"**{heading}**"]
    for card in panels:
        lines.append("")
        lines.append(panel_text(card, now))
    if rest:
        lines.append("")
        lines.extend(mini_line(c, now) for c in rest)
    if len(cards) > len(shown):
        lines.append(f"\n_…and {len(cards) - len(shown)} more in Cardlake._")
    lines.append("")
    lines.append(f"🔗 [Open Cardlake]({CARDLAKE_OPEN_URL})")
    return "\n".join(lines)


def feed_parts(cards: list[dict], now: datetime, heading: str = "🗂 Your Feed"):
    """Split feed into parts for Telegram button delivery: [(text, card|None)]. """
    if not cards:
        return [(feed_text(cards, now, heading), None)]
    sorted_cards = by_priority(cards, now)
    shown = sorted_cards[:MAX_TOTAL_CARDS]
    panels = shown[:MAX_PANEL_CARDS]
    rest = shown[MAX_PANEL_CARDS:]

    parts = []
    for i, card in enumerate(panels):
        text = panel_text(card, now)
        if i == 0:
            text = f"**{heading}**\n\n{text}"
        parts.append((text, card))

    if rest:
        mini = "\n".join(mini_line(c, now) for c in rest)
        if len(cards) > len(shown):
            mini += f"\n_…{len(cards) - len(shown)} more_"
        parts.append((mini, None))

    parts.append((f"🔗 [Open Cardlake]({CARDLAKE_OPEN_URL})", None))
    return parts


def today_text(cards: list[dict], now: datetime) -> str | None:
    """Today's digest message, or None if nothing due."""
    due = [c for c in cards if is_overdue(c, now) or is_due_today(c, now)]
    if not due:
        return None
    overdue_count = sum(1 for c in due if is_overdue(c, now))
    summary = f"{overdue_count} overdue" + (f", {len(due) - overdue_count} due today" if len(due) > overdue_count else "")
    heading = f"☀️ Today in Cardlake · {summary}"
    return feed_text(due, now, heading)


def today_parts(cards: list[dict], now: datetime):
    """Today's message parts for button delivery."""
    due = [c for c in cards if is_overdue(c, now) or is_due_today(c, now)]
    if not due:
        return []
    overdue_count = sum(1 for c in due if is_overdue(c, now))
    summary = f"{overdue_count} overdue" + (f", {len(due) - overdue_count} due today" if len(due) > overdue_count else "")
    heading = f"☀️ Today · {summary}"
    return feed_parts(due, now, heading)


# ── Deal me 5 ────────────────────────────────────────────────────────────────


DEAL_SIZE = 5


def deal_pick(cards: list[dict], now: datetime) -> list[dict]:
    """Pick cards for Deal — exclude urgent/pinned/finished."""
    pool = [c for c in cards
            if not (is_overdue(c, now) or is_due_today(c, now))
            and not c.get("pinned_at")]
    import random
    return random.sample(pool, min(DEAL_SIZE, len(pool)))


def deal_text(dealt: list[dict], now: datetime) -> str:
    if not dealt:
        return f"Nothing to deal.\n\n🔗 [Open Cardlake]({CARDLAKE_OPEN_URL})"
    return feed_text(dealt, now, "🃏 Deal me 5")


def deal_parts(dealt: list[dict], now: datetime):
    if not dealt:
        return [(deal_text(dealt, now), None)]
    return feed_parts(dealt, now, "🃏 Deal me 5")