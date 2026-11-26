"""Bounded, anonymous Binance public-record relay; no account credentials."""
import argparse
import datetime
import http.server
import json
import resource
import time
import urllib.error
import urllib.parse
import urllib.request

MAX_BYTES = 128 * 1024
TTL = 120
PREFIX = "/minimaomao-data/lead-portfolio/"
UPSTREAM = "https://www.binance.com/bapi/futures/v1/friendly/future/copy-trade/lead-portfolio/"


class SourceFailure(Exception):
    pass


def source_read(section, portfolio_id):
    deadline = time.monotonic() + 3.8
    for attempt in range(2):
        try:
            return _source_read(section, portfolio_id, max(0.1, deadline - time.monotonic()))
        except SourceFailure as error:
            # Binance's transient system-busy response is safe to retry once.
            # Access denials and rate limits are never retried here.
            if str(error) != "BINANCE_11012005" or attempt or deadline - time.monotonic() < 0.5:
                raise
            time.sleep(0.25)


def _source_read(section, portfolio_id, timeout):
    url = UPSTREAM + section
    headers = {"Content-Type": "application/json", "Accept": "application/json"}
    data = None
    if section == "detail":
        url += "?portfolioId=" + portfolio_id
    else:
        data = json.dumps({"portfolioId": portfolio_id, "pageNumber": 1, "pageSize": 20}).encode()
    try:
        with urllib.request.urlopen(urllib.request.Request(url, data=data, headers=headers), timeout=timeout) as response:
            body = response.read(MAX_BYTES + 1)
        if len(body) > MAX_BYTES:
            raise SourceFailure("RESPONSE_TOO_LARGE")
        result = json.loads(body)
        value = result.get("data")
        if result.get("code") != "000000" or result.get("success") is not True or not isinstance(value, dict):
            code = str(result.get("code", ""))
            raise SourceFailure("BINANCE_" + code if code.isdigit() and len(code) <= 24 else "BINANCE_ERROR")
        if section == "detail":
            if value.get("leadPortfolioId") != portfolio_id:
                raise SourceFailure("IDENTITY_MISMATCH")
            value = {key: value.get(key) for key in ["leadPortfolioId", "nickname", "status", "positionShow", "lastTradeTime"]}
        elif (not isinstance(value.get("list"), list) or len(value["list"]) > 20
              or any(not isinstance(row, dict) for row in value["list"])):
            raise SourceFailure("INVALID_RECORDS")
        return {"code": "000000", "success": True, "data": value}
    except urllib.error.HTTPError as error:
        raise SourceFailure("HTTP_" + str(error.code)) from None
    except SourceFailure:
        raise
    except Exception:
        raise SourceFailure("SOURCE_UNAVAILABLE") from None


class Records:
    def __init__(self, traders, fetch=source_read, clock=time.time):
        self.ids = {item["id"] for item in traders}
        if not 1 <= len(self.ids) <= 16 or any(not item.isdigit() or not 10 <= len(item) <= 24 for item in self.ids):
            raise ValueError("invalid trader registry")
        self.fetch = fetch
        self.clock = clock
        self.entries = {}

    def get(self, section, portfolio_id):
        if section not in {"detail", "order-history", "position-history"} or portfolio_id not in self.ids:
            raise ValueError("unsupported request")
        key = (section, portfolio_id)
        previous = self.entries.get(key)
        now = self.clock()
        if previous and now - previous["attempt"] < TTL:
            return previous
        try:
            data = self.fetch(section, portfolio_id)
            value = {"data": data, "fetched_at": datetime.datetime.fromtimestamp(now, datetime.timezone.utc).isoformat(), "error": None}
        except SourceFailure as error:
            value = {"data": previous["data"] if previous else None, "fetched_at": previous["fetched_at"] if previous else None, "error": str(error)}
        value["attempt"] = now
        self.entries[key] = value
        return value


def handler_for(records):
    class Handler(http.server.BaseHTTPRequestHandler):
        def setup(self):
            super().setup()
            self.connection.settimeout(5)

        def reply(self, status, value, headers=None):
            body = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            for key, value in (headers or {}).items():
                self.send_header(key, value)
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            self.handle_records()

        def do_POST(self):
            self.handle_records()

        def handle_records(self):
            url = urllib.parse.urlsplit(self.path)
            if url.path == "/health" and self.command == "GET":
                return self.reply(200, {"ok": True, "traders": len(records.ids), "cache_entries": len(records.entries), "peak_rss_kib": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss})
            section = url.path.removeprefix(PREFIX)
            if not url.path.startswith(PREFIX) or section not in {"detail", "order-history", "position-history"}:
                return self.reply(404, {"error": "not found"})
            try:
                if section == "detail":
                    params = urllib.parse.parse_qs(url.query, keep_blank_values=True)
                    if self.command != "GET" or set(params) != {"portfolioId"} or len(params["portfolioId"]) != 1:
                        raise ValueError()
                    portfolio_id = params["portfolioId"][0]
                else:
                    if self.command != "POST" or url.query or self.headers.get("Transfer-Encoding"):
                        raise ValueError()
                    length = int(self.headers.get("Content-Length", "0"))
                    if not 1 <= length <= 1024:
                        raise ValueError()
                    body = json.loads(self.rfile.read(length))
                    if not isinstance(body, dict) or set(body) != {"portfolioId", "pageNumber", "pageSize"} or body["pageNumber"] != 1 or body["pageSize"] != 20:
                        raise ValueError()
                    portfolio_id = body["portfolioId"]
                if not isinstance(portfolio_id, str):
                    raise ValueError()
                result = records.get(section, portfolio_id)
            except (ValueError, TypeError, KeyError):
                return self.reply(400, {"error": "unsupported request"})
            if result["data"] is None:
                return self.reply(503, {"error": result["error"]})
            headers = {"X-Source-Fetched-At": result["fetched_at"], "X-Source-Stale": "1" if result["error"] else "0"}
            return self.reply(200, result["data"], headers)

        def log_message(self, *_):
            pass  # Do not log incoming headers, credentials or body.

    return Handler


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--registry", required=True)
    parser.add_argument("--port", type=int, default=8937)
    args = parser.parse_args()
    # This single-process service is designed for <64 MiB RSS; bound address
    # space too, so a faulty response cannot approach the 900 MiB stop line.
    resource.setrlimit(resource.RLIMIT_AS, (384 * 1024**2, 384 * 1024**2))
    with open(args.registry) as file:
        records = Records(json.load(file))
    server = http.server.HTTPServer(("127.0.0.1", args.port), handler_for(records))
    server.timeout = 1
    while resource.getrusage(resource.RUSAGE_SELF).ru_maxrss < 900 * 1024:
        server.handle_request()
    server.server_close()
    raise SystemExit("RSS stop threshold reached")


if __name__ == "__main__":
    main()
