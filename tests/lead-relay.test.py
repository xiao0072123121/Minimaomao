import importlib.util
import json
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("relay", Path(__file__).parents[1] / "tools/lead-relay/server.py")
relay = importlib.util.module_from_spec(spec)
spec.loader.exec_module(relay)
ID = "4532994172262753536"
OTHER = "5108371059752839168"


class RelayTest(unittest.TestCase):
    def test_only_transient_system_busy_retries_once(self):
        with patch.object(relay, "_source_read", side_effect=[relay.SourceFailure("BINANCE_11012005"), {"data": "ok"}]) as read, patch.object(relay.time, "sleep"):
            self.assertEqual(relay.source_read("detail", ID), {"data": "ok"})
            self.assertEqual(read.call_count, 2)
        for code in ["HTTP_403", "HTTP_429", "BINANCE_11012005"]:
            with patch.object(relay, "_source_read", side_effect=relay.SourceFailure(code)) as read, patch.object(relay.time, "sleep"):
                with self.assertRaises(relay.SourceFailure):
                    relay.source_read("detail", ID)
                self.assertEqual(read.call_count, 2 if code == "BINANCE_11012005" else 1)

    def test_failure_keeps_only_own_source_data_and_timestamp(self):
        now = [1795660000]
        failing = set()
        calls = []
        def fetch(section, portfolio_id):
            calls.append((section, portfolio_id))
            if portfolio_id in failing:
                raise relay.SourceFailure("HTTP_403")
            return {"data": portfolio_id}
        records = relay.Records([{"id": ID}, {"id": OTHER}], fetch=fetch, clock=lambda: now[0])
        original = records.get("detail", ID)
        records.get("detail", ID)
        self.assertEqual(len(calls), 1)
        now[0] += 121
        failing.add(ID)
        old = records.get("detail", ID)
        self.assertEqual(old["fetched_at"], original["fetched_at"])
        self.assertEqual(old["data"], original["data"])
        self.assertEqual(old["error"], "HTTP_403")
        records.get("detail", ID)
        self.assertEqual(len(calls), 2)
        self.assertEqual(records.get("detail", OTHER)["data"]["data"], OTHER)

    def test_unconfigured_id_or_endpoint_never_fetches(self):
        def unexpected(*_):
            self.fail("invalid request reached source")
        records = relay.Records([{"id": ID}], fetch=unexpected)
        for section, portfolio_id in [("orders", ID), ("detail", "unknown"), ("https://evil.test", ID)]:
            with self.assertRaises(ValueError):
                records.get(section, portfolio_id)
        self.assertEqual(records.entries, {})

    def test_cold_failure_does_not_make_up_a_timestamp(self):
        def failed(*_):
            raise relay.SourceFailure("HTTP_403")
        records = relay.Records([{"id": ID}], fetch=failed)
        value = records.get("order-history", ID)
        self.assertIsNone(value["data"])
        self.assertIsNone(value["fetched_at"])

    def test_source_request_is_fixed_and_anonymous(self):
        class Response:
            def __enter__(self): return self
            def __exit__(self, *_): pass
            def read(self, size):
                self.size = size
                return json.dumps({"code": "000000", "success": True, "data": {"list": [], "total": 0}}).encode()
        def open_request(request, timeout):
            self.assertTrue(request.full_url.startswith(relay.UPSTREAM))
            self.assertEqual(json.loads(request.data), {"portfolioId": ID, "pageNumber": 1, "pageSize": 20})
            self.assertNotIn("Authorization", request.headers)
            self.assertNotIn("Cookie", request.headers)
            self.assertLessEqual(timeout, 4)
            return Response()
        with patch.object(relay.urllib.request, "urlopen", open_request):
            self.assertEqual(relay.source_read("order-history", ID)["data"]["list"], [])

    def test_identity_mismatch_and_oversize_are_rejected(self):
        class Response:
            def __enter__(self): return self
            def __exit__(self, *_): pass
            def read(self, size): return body
        for body in [b" " * (relay.MAX_BYTES + 1), json.dumps({"code": "000000", "success": True, "data": {"leadPortfolioId": OTHER}}).encode()]:
            with patch.object(relay.urllib.request, "urlopen", lambda *_, **kw: Response()):
                with self.assertRaises(relay.SourceFailure):
                    relay.source_read("detail", ID)


if __name__ == "__main__":
    unittest.main()
