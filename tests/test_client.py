"""Tests for the Python Cardlake client's MCP response handling (no network)."""

import importlib.util
import io
import json
import os
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent


def load_client():
    with mock.patch.dict(os.environ, {"CARDLAKE_API_TOKEN": "test-token"}):
        spec = importlib.util.spec_from_file_location("cardlake_client", ROOT / "__init__.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
    return module


class FakeResponse(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def respond(result):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "result": result}).encode()
    return mock.patch("urllib.request.urlopen", side_effect=lambda *a, **kw: FakeResponse(body))


class RpcTest(unittest.TestCase):
    def setUp(self):
        self.client = load_client()

    def test_tool_error_is_an_error(self):
        with respond({"isError": True, "content": [{"type": "text", "text": "Error: Card not found"}]}):
            self.assertEqual(self.client._rpc("get_card", {}), {"error": "Error: Card not found"})
        with respond({"isError": True, "content": []}):
            self.assertIn("error", self.client._rpc("get_card", {}))

    def test_failed_actions_report_failure(self):
        with respond({"isError": True, "content": [{"type": "text", "text": "Error: Card not found"}]}):
            self.assertIn("error", self.client.snooze_card("reminder", "x", 1))
            self.assertIn("error", self.client.complete_card("reminder", "x"))
            self.assertIsNone(self.client.get_card("reminder", "x"))

    def test_prefers_structured_content(self):
        with respond({"structuredContent": {"cards": [1]}, "content": [{"type": "text", "text": '{"cards": [2]}'}]}):
            self.assertEqual(self.client.feed(5), [1])

    def test_text_content_still_parsed(self):
        with respond({"content": [{"type": "text", "text": '{"cards": [{"id": "a"}]}'}]}):
            self.assertEqual(self.client.feed(5), [{"id": "a"}])

    def test_missing_token(self):
        self.client.API_TOKEN = ""
        self.assertEqual(self.client._rpc("list_feed"), {"error": "CARDLAKE_API_TOKEN not set"})


if __name__ == "__main__":
    unittest.main()
