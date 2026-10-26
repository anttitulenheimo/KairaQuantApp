"""No provider traffic: transport fixtures exercise the real normalization boundary."""
import copy
from datetime import datetime, timedelta
from decimal import Decimal
from io import BytesIO
import json
from urllib.error import HTTPError
from urllib.parse import parse_qs, urlsplit

import pytest

from service_v16.market import AlpacaSource, FeedError, FixtureSource, NoRedirect, UTC, bar_window, iso, number, validate

NOW = datetime(2020, 2, 1, 0, 2, tzinfo=UTC)


def batch():
    return FixtureSource().fetch(NOW)


def test_valid_batch_has_two_finalized_hours_and_quote_provenance():
    quotes, bars = batch()
    result = validate(quotes, bars, NOW)
    assert set(result["symbols"]) == {"BTC/USD", "ETH/USD"}
    assert result["symbols"]["BTC/USD"]["mid"] == "100.0"
    assert result["symbols"]["BTC/USD"]["bar_end"] == "2020-02-01T00:00:00.000000Z"
    assert [b["time"] for b in result["symbols"]["BTC/USD"]["bars"]] == ["2020-01-31T22:00:00.000000Z", "2020-01-31T23:00:00.000000Z"]


@pytest.mark.parametrize("case", ["stale", "future", "crossed", "wide", "zero", "nan", "missing_asset", "timezone", "boolean", "missing_bar", "duplicate_bar", "unordered_bar", "open_bar", "bad_ohlc", "negative_volume"])
def test_bad_data_blocks_entire_batch(case):
    q, b = batch()
    if case == "stale": q["BTC/USD"]["t"] = iso(NOW - timedelta(seconds=61))
    elif case == "future": q["ETH/USD"]["t"] = iso(NOW + timedelta(seconds=3))
    elif case == "crossed": q["BTC/USD"]["bp"] = 110
    elif case == "wide": q["BTC/USD"]["ap"] = 120
    elif case == "zero": q["BTC/USD"]["bp"] = 0
    elif case == "nan": q["BTC/USD"]["ap"] = float("nan")
    elif case == "missing_asset": del q["ETH/USD"]
    elif case == "timezone": q["BTC/USD"]["t"] = "2020-02-01T00:02:00"
    elif case == "boolean": q["BTC/USD"]["bp"] = True
    elif case == "missing_bar": b["BTC/USD"].pop()
    elif case == "duplicate_bar": b["ETH/USD"][1] = copy.deepcopy(b["ETH/USD"][0])
    elif case == "unordered_bar": b["BTC/USD"].reverse()
    elif case == "open_bar": b["BTC/USD"][1]["t"] = iso(NOW.replace(minute=0))
    elif case == "bad_ohlc": b["BTC/USD"][0]["l"] = 101
    elif case == "negative_volume": b["BTC/USD"][0]["v"] = -1
    with pytest.raises(ValueError): validate(q, b, NOW)


def test_bar_finalization_window_and_numeric_limits():
    boundary = NOW.replace(minute=0)
    assert bar_window(boundary + timedelta(seconds=59))[1] == boundary - timedelta(hours=1)
    assert bar_window(boundary + timedelta(seconds=60))[1] == boundary
    for value in ("1e999999", "1" * 100, float("inf"), -1):
        with pytest.raises(ValueError): number(value)
    assert number(0, positive=False) == 0


class Opener:
    def __init__(self, responses): self.responses, self.requests = list(responses), []
    def open(self, request, timeout):
        self.requests.append(request)
        value = self.responses.pop(0)
        if isinstance(value, Exception): raise value
        return BytesIO(json.dumps(value).encode())


def test_transport_uses_only_get_data_endpoints_and_bounded_pagination():
    q, b = batch()
    transport = Opener([{"quotes": q}, {"bars": {"BTC/USD": b["BTC/USD"]}, "next_page_token": "page2"}, {"bars": {"ETH/USD": b["ETH/USD"]}, "next_page_token": None}])
    source = AlpacaSource("test-key", "test-secret", opener=transport)
    quotes, bars = source.fetch(NOW)
    assert validate(quotes, bars, NOW)
    assert len(transport.requests) == 3
    for request in transport.requests:
        assert request.get_method() == "GET"
        assert urlsplit(request.full_url).netloc == "data.alpaca.markets"
        assert "test-secret" not in request.full_url
    params = parse_qs(urlsplit(transport.requests[1].full_url).query)
    assert params["timeframe"] == ["1Hour"]
    assert params["start"] == ["2020-01-31T22:00:00.000000Z"]
    assert params["end"] == ["2020-01-31T23:59:59.999999Z"]
    assert source.configured
    with pytest.raises(ValueError): source.get("orders", {})
    assert NoRedirect().redirect_request(None, None, None, None, None, None) is None


def test_transport_rate_limit_and_credentials_errors_never_expose_response_secrets():
    error = HTTPError("https://data.alpaca.markets", 429, "secret-response", {"Retry-After": "120"}, BytesIO(b"secret-body"))
    source = AlpacaSource("test-key", "test-secret", opener=Opener([error]))
    with pytest.raises(FeedError) as caught: source.fetch(NOW)
    assert caught.value.retry_after == 120
    assert "secret" not in str(caught.value)
    source = AlpacaSource("", "", opener=Opener([]))
    with pytest.raises(FeedError, match="credentials are missing"): source.fetch(NOW)
    assert not source.opener.requests


def test_transport_rejects_repeated_page_token_and_unknown_symbols():
    q, b = batch()
    for pages in ([{"bars": {}, "next_page_token": "same"}] * 2, [{"bars": {"DOGE/USD": []}}]):
        source = AlpacaSource("key", "secret", opener=Opener([{"quotes": q}, *pages]))
        with pytest.raises(FeedError): source.fetch(NOW)


def test_provider_nanosecond_and_variable_precision_timestamps():
    from service_v16.market import timestamp
    for fraction, microsecond in [("1", 100000), ("1234", 123400), ("123456789", 123456)]:
        assert timestamp(f"2026-10-15T12:00:00.{fraction}Z").microsecond == microsecond
    for value in ["2026-10-15", "2026-10-15T12:00:00+02:00", "2026-10-15T12:00:00.1234567890Z"]:
        with pytest.raises(ValueError):
            timestamp(value)
