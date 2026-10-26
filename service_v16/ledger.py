"""Decimal shadow ledger. Quotes determine simulated prices; no broker API calls."""
from datetime import datetime, timedelta
from decimal import Decimal, ROUND_DOWN

from .market import UTC, iso, timestamp

UNIT = Decimal(100_000_000)
TARGET = Decimal("0.10")
COSTS = {"base": Decimal("0.003"), "stress": Decimal("0.006")}
GRACE = timedelta(minutes=5)


def next_month(time):
    return datetime(time.year + (time.month == 12), time.month % 12 + 1, 1, tzinfo=UTC)


def accounts():
    return {f"{asset}-{cost}": {"asset": asset, "cost": cost, "cash": "10000", "units": 0, "fees": "0"}
            for asset in ("BTC", "ETH") for cost in COSTS}


def fill(account, quote, *, initial):
    cash, held, fee = Decimal(account["cash"]), Decimal(account["units"]) / UNIT, COSTS[account["cost"]]
    bid, ask, mid = (Decimal(quote[k]) for k in ("bid", "ask", "mid"))
    difference = TARGET * (cash + held * mid) - held * mid
    side = "BUY" if initial or difference >= 0 else "SELL"
    price = ask if side == "BUY" else bid
    if initial:
        quantity = TARGET * cash / (ask * (1 + fee))
    elif side == "BUY":
        quantity = difference / ((1 - TARGET) * mid + TARGET * ask * (1 + fee))
    else:
        quantity = -difference / ((1 - TARGET) * mid + TARGET * bid * (1 - fee))
    capacity = cash / (price * (1 + fee)) if side == "BUY" else held
    units = int((min(quantity, capacity) * UNIT).to_integral_value(rounding=ROUND_DOWN))
    notional = Decimal(units) / UNIT * price
    reason = "Initial allocation including fees: 10%" if initial else ("Below target weight" if side == "BUY" else "Above target weight")
    if notional < 1:
        return {"side": "HOLD", "units": 0, "price": str(price), "fee": "0", "status": "SKIPPED", "reason": "Below $1 test minimum or at target weight"}
    charge = notional * fee
    account["cash"] = str(cash + (-notional - charge if side == "BUY" else notional - charge))
    account["units"] += units if side == "BUY" else -units
    account["fees"] = str(Decimal(account["fees"]) + charge)
    if Decimal(account["cash"]) < 0 or account["units"] < 0:
        raise ValueError("Simulated fill violated account balances")
    return {"side": side, "units": units, "price": str(price), "fee": str(charge), "status": "SIMULATED_FILL", "reason": reason}


def advance(state, market, now):
    """Mutate a transaction-local state and return uniquely keyed decision records."""
    initial = state["next_due"] is None
    due = now if initial else timestamp(state["next_due"])
    events = []
    while due <= now:
        missed = not initial and now > due + GRACE
        if not missed and not initial and any(timestamp(q["bar_end"]) < due for q in market["symbols"].values()):
            state["message"] = "Waiting for the completed hourly bar ending at the monthly boundary"
            return events
        period = "initial" if initial else due.strftime("%Y-%m")
        for key, account in state["accounts"].items():
            quote = market["symbols"][account["asset"] + "/USD"]
            result = {"status": "MISSED", "side": "HOLD", "units": 0, "price": None, "fee": "0",
                      "reason": "Monthly window missed; no catch-up trade"} if missed else fill(account, quote, initial=initial)
            events.append({"id": f'{state["run"]}:{key}:{period}', "run": state["run"], "account": key,
                           "scheduled_at": iso(due), "observed_at": iso(now), "quote_time": quote["quote_time"] if not missed else None,
                           "bid": quote["bid"] if not missed else None, "ask": quote["ask"] if not missed else None,
                           "bar_end": quote["bar_end"] if not missed else None, **result,
                           "cash_after": account["cash"], "units_after": account["units"]})
        state["next_due"] = iso(next_month(due))
        state["message"] = "Monthly window missed; next scheduled boundary retained" if missed else "Simulated decisions recorded; waiting for the next monthly boundary"
        due, initial = timestamp(state["next_due"]), False
    return events
