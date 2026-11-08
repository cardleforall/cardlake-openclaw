"""Secrets redaction — strips tokens, keys, passwords before sending to Cardlake."""

from __future__ import annotations

import re

REMOVED = "█" * 8

# Patterns that look like secrets
_LONG_HEX = re.compile(r"(?<![A-Za-z0-9])[0-9a-fA-F]{32,}(?![A-Za-z0-9])")
_LONG_RANDOM = re.compile(r"(?<![A-Za-z0-9_/+=-])[A-Za-z0-9_/+=-]{40,}(?![A-Za-z0-9_/+=-])")
_BEARER = re.compile(r"(?i)(bearer|token|apikey|api_key|secret)\s+(\S{8,})")
_URL_LOGIN = re.compile(r"(https?://)[^:@]+@")
_NAMED = re.compile(r"(?i)(?P<name>password|passwd|secret|token|api_key|apikey|auth|key)\s*[:=]\s*(?P<value>['\"]?\S+)")

_PLAIN_WORDS = frozenset(
    "a an and are as at be been being broken by can changed correct could did does "
    "empty expired for from good has have here in incorrect invalid is it length limit "
    "limits missing needed new no not of old on or our ready required reset rotated "
    "same set should still that the their them there this to too updated use used "
    "valid was what when where which will with wrong you your".split()
)


def _looks_random(run: str) -> bool:
    return bool(re.search(r"[a-z]", run) and re.search(r"[A-Z]", run) and re.search(r"\d", run))


def redact_text(text: str) -> str:
    """Remove secrets from text."""
    if not text:
        return text
    text = _LONG_HEX.sub(REMOVED, text)
    text = _URL_LOGIN.sub(r"\1" + REMOVED + "@", text)
    text = _BEARER.sub(r"\1 " + REMOVED, text)
    text = _NAMED.sub(lambda m: f"{m.group('name')}: {REMOVED}"
                      if m.group('value').strip("'\"`").lower().rstrip(".!?") not in _PLAIN_WORDS
                      else m.group(0), text)
    text = _LONG_RANDOM.sub(lambda m: REMOVED if _looks_random(m.group(0)) else m.group(0), text)
    return text


def redact(value: object) -> object:
    """Recursively redact strings in a nested structure."""
    if isinstance(value, str):
        return redact_text(value)
    if isinstance(value, dict):
        return {key: redact(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [redact(item) for item in value]
    return value