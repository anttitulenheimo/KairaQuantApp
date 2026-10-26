"""Read-only Alpaca US data transport and strict completed-bar validation."""
from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
import json
import re
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, build_opener, HTTPRedirectHandler

UTC = timezone.utc
SYMBOLS = ("BTC/USD", "ETH/USD")
BASE_URL = "https://data.alpaca.markets/v1beta3/crypto/us/"
QUOTE_MAX_AGE = 60
BAR_FINALIZATION_DELAY = 60
MAX_SPREAD = Decimal("0.02")


def utcnow():
    return datetime.now(UTC)


def iso(value):
    return value.astimezone(UTC).isoformat(timespec="microseconds").replace("+00:00", "Z")


def timestamp(value):
    # Python 3.10 accepts only 3/6 fractional digits. Provider RFC3339 values
    # can contain nanoseconds; normalize explicitly to microsecond precision.
    match = re.fullmatch(r"(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(?:Z|\+00:00)", value) if isinstance(value, str) else None
    if not match:
        raise ValueError("Timestamp must explicitly use UTC RFC3339")
    fraction = (match[2] or "").ljust(6, "0")[:6]
    try:
        return datetime.fromisoformat(f"{match[1]}.{fraction}+00:00")
    except ValueError:
        raise ValueError("Invalid UTC timestamp") from None


def number(value, *, positive=True):
    if isinstance(value, bool) or not isinstance(value, (int, float, str, Decimal)):
        raise ValueError("Invalid numeric field")
    if len(str(value)) > 80:
        raise ValueError("Numeric field exceeds the size limit")
    try:
        result = Decimal(str(value))
    except InvalidOperation:
        raise ValueError("Invalid numeric field") from None
    if not result.is_finite() or result > Decimal("1e18") or (result <= 0 if positive else result < 0):
        raise ValueError("Numeric field is outside its valid range")
    return result


def bar_window(now):
    end = (now - timedelta(seconds=BAR_FINALIZATION_DELAY)).replace(minute=0, second=0, microsecond=0)
    return end - timedelta(hours=2), end


def validate(quotes, bars, now):
    """Require both symbols, fresh noncrossed quotes and two contiguous closed hours."""
    if not isinstance(quotes, dict) or set(quotes) != set(SYMBOLS):
        raise ValueError("Both BTC/USD and ETH/USD quotes are required")
    if not isinstance(bars, dict) or set(bars) != set(SYMBOLS):
        raise ValueError("Both BTC/USD and ETH/USD bar series are required")
    start, end = bar_window(now)
    result = {}
    for symbol in SYMBOLS:
        q = quotes[symbol]
        if not isinstance(q, dict):
            raise ValueError("Invalid quote record")
        t = timestamp(q.get("t"))
        age = (now - t).total_seconds()
        if not -2 <= age <= QUOTE_MAX_AGE:
            raise ValueError(f"{symbol}: quote is stale or ahead of the clock")
        bid, ask = number(q.get("bp")), number(q.get("ap"))
        number(q.get("bs"), positive=False)
        number(q.get("as"), positive=False)
        mid = (bid + ask) / 2
        if ask < bid or (ask - bid) / mid > MAX_SPREAD:
            raise ValueError(f"{symbol}: crossed quote or spread exceeds 2%")
        rows = bars[symbol]
        if not isinstance(rows, list) or len(rows) != 2:
            raise ValueError(f"{symbol}: two contiguous completed hourly bars are required")
        normalized = []
        for index, row in enumerate(rows):
            if not isinstance(row, dict) or timestamp(row.get("t")) != start + timedelta(hours=index):
                raise ValueError(f"{symbol}: missing, duplicate, unordered or incomplete hourly bar")
            values = {key: number(row.get(key), positive=key != "v") for key in ("o", "h", "l", "c", "v")}
            if not values["l"] <= min(values["o"], values["c"]) <= max(values["o"], values["c"]) <= values["h"]:
                raise ValueError(f"{symbol}: invalid OHLC bounds")
            normalized.append({"time": iso(timestamp(row["t"])), **{key: str(value) for key, value in values.items()}})
        result[symbol] = {"quote_time": iso(t), "bid": str(bid), "ask": str(ask), "mid": str(mid),
                          "spread_bps": str((ask - bid) / mid * 10000), "bars": normalized,
                          "bar_end": iso(end)}
    return {"observed_at": iso(now), "symbols": result}


class FeedError(Exception):
    def __init__(self, message, retry_after=30):
        super().__init__(message)
        self.retry_after = min(300, max(30, retry_after))


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *_):
        # Never forward credentials to a redirect destination.
        return None


class AlpacaSource:
    name = "alpaca_us"
    mode = "live"

    def __init__(self, key, secret, *, opener=None):
        self.key, self.secret = key, secret
        self.opener = opener or build_opener(NoRedirect())

    @property
    def configured(self):
        return bool(self.key and self.secret)

    def get(self, endpoint, params):
        if not self.configured:
            raise FeedError("Alpaca data credentials are missing", 300)
        if endpoint not in ("latest/quotes", "bars"):
            raise ValueError("Only read-only market-data endpoints are allowed")
        request = Request(BASE_URL + endpoint + "?" + urlencode(params), headers={
            "APCA-API-KEY-ID": self.key, "APCA-API-SECRET-KEY": self.secret,
            "Accept": "application/json", "User-Agent": "Kaira-V16/1.0"}, method="GET")
        try:
            with self.opener.open(request, timeout=5) as response:
                raw = response.read(1_000_001)
                if len(raw) > 1_000_000:
                    raise FeedError("Market-data response exceeds the size limit")
                result = json.loads(raw)
                if not isinstance(result, dict):
                    raise FeedError("Invalid market-data response")
                return result
        except HTTPError as error:
            retry = error.headers.get("Retry-After", "30")
            retry = int(retry) if retry.isdigit() else 30
            if error.code in (401, 403):
                raise FeedError("Alpaca data authentication or entitlement was rejected", 300) from None
            if error.code == 429:
                raise FeedError("Alpaca rate limit reached; waiting before retry", retry) from None
            raise FeedError(f"Market-data HTTP error ({error.code})", 60) from None
        except (URLError, TimeoutError, OSError):
            raise FeedError("Market-data connection failed", 60) from None
        except (ValueError, UnicodeError):
            raise FeedError("Invalid market-data JSON response", 60) from None

    def fetch(self, now):
        start, end = bar_window(now)
        quotes = self.get("latest/quotes", {"symbols": ",".join(SYMBOLS)}).get("quotes")
        params = {"symbols": ",".join(SYMBOLS), "timeframe": "1Hour", "start": iso(start),
                  "end": iso(end - timedelta(microseconds=1)), "limit": 1000, "sort": "asc"}
        bars = {symbol: [] for symbol in SYMBOLS}
        seen_tokens = set()
        for _ in range(4):
            page = self.get("bars", params)
            values = page.get("bars")
            if not isinstance(values, dict) or not set(values) <= set(SYMBOLS):
                raise FeedError("Unexpected symbols or missing bar response")
            for symbol, rows in values.items():
                if not isinstance(rows, list):
                    raise FeedError("Invalid bar response")
                bars[symbol].extend(rows)
                if len(bars[symbol]) > 2:
                    raise FeedError("Unexpected bars outside the bounded two-hour request")
            token = page.get("next_page_token")
            if not token:
                return quotes, bars
            if not isinstance(token, str) or token in seen_tokens or len(token) > 2048:
                raise FeedError("Invalid market-data pagination")
            seen_tokens.add(token)
            params["page_token"] = token
        raise FeedError("Market-data pagination limit exceeded")


class FixtureSource:
    """Explicit offline fixture mode. Never a fallback for a failed live feed."""
    name, mode, configured = "synthetic_fixture", "fixture", True

    def fetch(self, now):
        start, _ = bar_window(now)
        quotes, bars = {}, {}
        for symbol, price in zip(SYMBOLS, (100, 40)):
            quotes[symbol] = {"t": iso(now), "bp": price * .999, "ap": price * 1.001, "bs": 1000, "as": 1000}
            bars[symbol] = [{"t": iso(start + timedelta(hours=i)), "o": price, "h": price, "l": price, "c": price, "v": 100} for i in range(2)]
        return quotes, bars
