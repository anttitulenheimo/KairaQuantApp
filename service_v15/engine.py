"""Pure Python counterpart to V14. Versioned synthetic prices and accounting."""
from datetime import datetime, timedelta, timezone
import math
import re

CAPITAL, UNIT = 10000, 100_000_000
COSTS = {"base": .006, "stress": .012}
START = datetime(2020, 1, 14, tzinfo=timezone.utc)
END = datetime(2021, 1, 14, tzinfo=timezone.utc)
HOURS = (END - START).total_seconds() / 3600
TIMES = [START] + [datetime(2020, month, 1, tzinfo=timezone.utc) for month in range(2, 13)] + [datetime(2021, 1, 1, tzinfo=timezone.utc)]
TERMINAL = {"FILLED", "REJECTED", "CANCELED", "SKIPPED"}


def check(condition, message):
    if not condition:
        raise ValueError(message)


def iso(t):
    return t.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def config_valid(config):
    check(isinstance(config, dict) and set(config) == {"asset", "cost", "scenario", "profile"}, "Virheellinen asetusmuoto")
    check(all(isinstance(v, str) for v in config.values()), "Asetusten tulee olla tekstiä")
    check(config["asset"] in ("BTC", "ETH") and config["cost"] in COSTS and config["scenario"] in ("waves", "trend", "shock") and config["profile"] in ("normal", "partial", "faults"), "Tuntematon suoritusasetus")
    return dict(config)


def price(config, time, delay=0, close=False):
    h = (time - START).total_seconds() / 3600 + delay + (.8 if close else 0)
    check(0 <= h < HOURS, "Hinta puuttuu")
    x = h / HOURS
    base, phase = (100, 0) if config["asset"] == "BTC" else (40, 1.3)
    log_change = .22 * math.sin(x * 7 * math.pi + phase) + .08 * math.sin(x * 23 * math.pi)
    if config["scenario"] == "trend":
        log_change = .85 * x + .09 * math.sin(9 * math.pi * x + phase)
    elif config["scenario"] == "shock":
        log_change = .18 * x + .045 * math.sin(18 * x + phase) - (.72 * math.exp(-(x - .36) * 2.4) if x >= .36 else 0)
    return float(f"{base * math.exp(log_change):.8f}")


def size_order(cash, quantity, p, fee, initial=False):
    check(all(type(v) in (int, float) and math.isfinite(v) for v in (cash, quantity, p, fee)) and cash >= 0 and quantity >= 0 and p > 0 and fee in (.003, .006), "Virheellinen salkku tai hinta")
    if initial:
        change = .1 * cash / (1 + fee)
    else:
        equity = cash + quantity * p
        check(equity > 0, "Salkun arvo ei kelpaa")
        difference = .1 * equity - quantity * p
        change = 0 if abs(difference) <= 1e-12 * equity else difference / (1 + .1 * fee if difference > 0 else 1 - .1 * fee)
    side = "SELL" if change < 0 else "BUY"
    capacity = cash / (p * (1 + fee)) if side == "BUY" else quantity
    units = math.floor(min(abs(change) / p, capacity) * UNIT)
    check(0 <= units <= 2**53 - 1, "Virheellinen määrä")
    notional = units / UNIT * p
    reason = ("Alle 1 $ testiminimin tai paino tavoitteessa" if notional < 1 else
              "Alkuosto kuluineen 10 %" if initial else
              "Paino alle 10 % tavoitteen" if side == "BUY" else "Paino yli 10 % tavoitteen")
    return {"side": side, "units": units if notional >= 1 else 0, "reason": reason}


def decision(account, config, index, run):
    time = TIMES[index]
    p = price(config, time)
    return {"id": f"{run}:{index}", "index": index, "time": iso(time), "price": p,
            "cashBefore": account["cash"], "unitsBefore": account["units"],
            **size_order(account["cash"], account["units"] / UNIT, p, COSTS[config["cost"]] / 2, index == 0)}


def behavior(config, index):
    return ["lost_ack", "partial", "rejected", "delayed", "canceled"][index % 5] if config["profile"] == "faults" else config["profile"]


def broker_response(intent, config, polls):
    check(type(polls) is int and 0 <= polls <= 3, "Virheellinen välittäjän vastaus")
    mode = behavior(config, intent["index"])
    fills = []
    status, cash, held = "SUBMITTED", intent["cashBefore"], intent["unitsBefore"]

    def fill(units, delay):
        nonlocal status, cash, held
        p = price(config, TIMES[intent["index"]], delay)
        notional = units / UNIT * p
        fee = notional * COSTS[config["cost"]] / 2
        if (intent["side"] == "BUY" and notional + fee > cash + 1e-9) or (intent["side"] == "SELL" and units > held):
            status = "REJECTED"
            return False
        fills.append({"id": f'{intent["id"]}/fill/{len(fills) + 1}', "orderId": intent["id"],
                      "time": iso(TIMES[intent["index"]] + timedelta(hours=delay)), "side": intent["side"], "units": units, "price": p, "fee": fee})
        cash += -notional - fee if intent["side"] == "BUY" else notional - fee
        held += units if intent["side"] == "BUY" else -units
        return True

    if polls:
        if mode == "rejected":
            status = "REJECTED"
        elif mode == "delayed" and polls < 3:
            status = "WAITING"
        elif mode in ("partial", "canceled"):
            first = max(1, intent["units"] // 2)
            if fill(first, 0):
                status = "FILLED" if first == intent["units"] else "PARTIAL"
                if polls >= 2 and status != "FILLED":
                    if mode == "canceled":
                        status = "CANCELED"
                    elif fill(intent["units"] - first, 1):
                        status = "FILLED"
        elif fill(intent["units"], 2 if mode == "delayed" else 0):
            status = "FILLED"
    return {"status": status, "fills": fills}


def create_run(config, run):
    config = config_valid(config)
    check(isinstance(run, str) and re.fullmatch(r"[a-zA-Z0-9-]{8,80}", run), "Virheellinen ajotunniste")
    return ({"version": 1, "engine": "v15.0", "run": run, "config": config, "orders": [], "complete": False},
            {"version": 1, "run": run, "orders": {}})


def project(journal, broker):
    check(isinstance(journal, dict) and set(journal) == {"version", "engine", "run", "config", "orders", "complete"}, "Virheellinen suoritusloki")
    check(isinstance(broker, dict) and set(broker) == {"version", "run", "orders"}, "Virheellinen välittäjäloki")
    config = config_valid(journal["config"])
    check(journal["version"] == 1 and journal["engine"] == "v15.0" and broker["version"] == 1 and isinstance(journal["run"], str) and re.fullmatch(r"[a-zA-Z0-9-]{8,80}", journal["run"]) and broker["run"] == journal["run"], "Lokien versiot tai ajot eivät täsmää")
    check(isinstance(journal["orders"], list) and len(journal["orders"]) <= 13 and type(journal["complete"]) is bool and isinstance(broker["orders"], dict), "Virheellinen tila")
    account = {"cash": CAPITAL, "units": 0, "fees": 0}
    orders, fills, known = [], [], set()
    for index, ack in enumerate(journal["orders"]):
        check(isinstance(ack, dict) and set(ack) == {"sent", "polls"} and type(ack["sent"]) is bool and type(ack["polls"]) is int and 0 <= ack["polls"] <= 3 and (ack["sent"] or ack["polls"] == 0), "Virheellinen kuittaus")
        intent = decision(account, config, index, journal["run"])
        remote = broker["orders"].get(intent["id"])
        response = {"status": "PREPARED" if intent["units"] else "SKIPPED", "fills": []}
        if remote is not None:
            known.add(intent["id"])
            check(isinstance(remote, dict) and set(remote) == {"intent", "polls", "lostAck"}, "Virheellinen välittäjäkirjaus")
            check(intent["units"] > 0 and remote["intent"] == intent and type(remote["polls"]) is int and ack["polls"] <= remote["polls"] <= 3 and type(remote["lostAck"]) is bool and remote["lostAck"] == (behavior(config, index) == "lost_ack"), "Välittäjän toimeksianto ei täsmää")
        if ack["sent"]:
            check(remote is not None and intent["units"] > 0, "Lähetetty toimeksianto puuttuu välittäjältä")
            response = broker_response(intent, config, ack["polls"])
        check(index == len(journal["orders"]) - 1 or response["status"] in TERMINAL, "Avoin toimeksianto estää seuraavan päätöksen")
        orders.append({**intent, **response, "brokerPolls": remote["polls"] if remote else None})
        for f in response["fills"]:
            notional = f["units"] / UNIT * f["price"]
            account["cash"] += -notional - f["fee"] if f["side"] == "BUY" else notional - f["fee"]
            account["units"] += f["units"] if f["side"] == "BUY" else -f["units"]
            account["fees"] += f["fee"]
        check(math.isfinite(account["cash"]) and account["cash"] >= -1e-9 and account["units"] >= 0, "Virheellinen saldo")
        account["cash"] = max(0, account["cash"])
        fills.extend(response["fills"])
    check(set(broker["orders"]) == known, "Välittäjällä on tuntematon toimeksianto")
    pending = orders[-1] if orders and orders[-1]["status"] not in TERMINAL else None
    check(not journal["complete"] or (len(orders) == 13 and not pending), "Keskeneräinen ajo ei ole valmis")
    time = TIMES[len(orders) - 1] + timedelta(hours=max(0, journal["orders"][-1]["polls"] - 1)) if orders else START
    if fills:
        time = max(time, datetime.fromisoformat(fills[-1]["time"].replace("Z", "+00:00")))
    p = price(config, END - timedelta(hours=1), close=True) if journal["complete"] else price(config, time)
    equity = account["cash"] + account["units"] / UNIT * p
    return {"account": account, "orders": orders, "fills": fills, "pending": pending,
            "time": iso(END if journal["complete"] else time), "price": p, "equity": equity,
            "reserve": account["units"] / UNIT * p * COSTS[config["cost"]] / 2 if journal["complete"] else 0,
            "complete": journal["complete"], "nextTime": iso(TIMES[len(orders)] if len(orders) < 13 else END)}


def transition(journal, broker):
    """Return ordered durable writes. Never mutates the supplied snapshots."""
    import copy
    journal, broker = copy.deepcopy(journal), copy.deepcopy(broker)
    view = project(journal, broker)
    if view["complete"]:
        return [], False, "Testivuosi on valmis."
    if not view["pending"]:
        if len(journal["orders"]) == 13:
            journal["complete"] = True
        else:
            journal["orders"].append({"sent": False, "polls": 0})
        return [("journal", journal)], False, "Päätös tai loppuarvostus tallennettu."
    intent = {k: v for k, v in view["pending"].items() if k not in ("status", "fills", "brokerPolls")}
    ack = journal["orders"][-1]
    writes = []
    if not ack["sent"]:
        if intent["id"] not in broker["orders"]:
            lost = behavior(journal["config"], intent["index"]) == "lost_ack"
            broker["orders"][intent["id"]] = {"intent": intent, "polls": 0, "lostAck": lost}
            writes.append(("broker", broker))
            if lost:
                return writes, True, "Testikeskeytys: hyväksymiskuittaus katosi. Jatka samalla tunnisteella."
        ack["sent"] = True
    else:
        remote = broker["orders"][intent["id"]]
        if remote["polls"] == ack["polls"]:
            remote["polls"] += 1
            writes.append(("broker", broker))
        ack["polls"] = remote["polls"]
    writes.append(("journal", journal))
    return writes, False, "Toimeksiannon tila täsmäytetty."
