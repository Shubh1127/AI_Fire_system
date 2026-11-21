from fastapi.testclient import TestClient

import main

c = TestClient(main.app)


def test_flow():
    main.clear_history()
    assert c.get("/api/status").json()["overall"] == "OFFLINE"

    ok = {"temperature": 26.4, "humidity": 48.2, "flame1": 1, "flame2": 1, "smoke": None}
    assert c.post("/api/sensors", json=ok).status_code == 200
    s = c.get("/api/status").json()
    assert s["overall"] == "SAFE" and s["mode"] == "LIVE" and s["alerts"] == []

    c.post("/api/sensors", json={**ok, "flame2": 0})
    s = c.get("/api/status").json()
    assert s["overall"] == "FIRE" and "Flame Sensor 2" in s["alerts"][0]["message"]

    c.post("/api/sensors", json={**ok, "temperature": None, "humidity": None})
    assert c.get("/api/status").json()["overall"] == "WARNING"

    h = c.get("/api/sensors/history?limit=2").json()
    assert len(h) == 2 and h[-1]["temperature"] is None and h[-1]["smoke"] is None

    assert c.post("/api/sensors", json={**ok, "flame1": 5}).status_code == 422

    # demo is dropped (and its points cleared) the moment real data arrives
    c.post("/api/demo", json={"enabled": True})
    assert c.get("/api/status").json()["mode"] == "DEMO"
    c.post("/api/sensors", json=ok)
    s = c.get("/api/status").json()
    assert s["mode"] == "LIVE" and len(c.get("/api/sensors/history").json()) == 1


def test_suppression():
    main.clear_history()
    base = {"temperature": 26.0, "humidity": 50.0, "flame1": 1, "flame2": 1, "smoke": None,
            "device_id": "esp32-fire-01", "pump_on": False, "servo_angle": 90, "mode": "backend"}
    r = c.post("/api/sensors", json=base).json()
    assert r["command"] == {"servo_angle": 90, "pump": False}

    # left sensor sees flame twice in a row -> confirmed fire, aim left, spray
    c.post("/api/sensors", json={**base, "flame1": 0})
    r = c.post("/api/sensors", json={**base, "flame1": 0}).json()
    assert r["risk"] == "FIRE" and r["command"] == {"servo_angle": 135, "pump": True}

    # operator blocks spraying
    c.post("/api/suppression", json={"action": "block"})
    r = c.post("/api/sensors", json={**base, "flame1": 0}).json()
    assert r["command"]["pump"] is False
    s = c.get("/api/status").json()
    assert s["suppression"]["override"]["mode"] == "block"

    # back to auto, then manual spray with no fire
    c.post("/api/suppression", json={"action": "auto"})
    main.clear_history()
    c.post("/api/suppression", json={"action": "spray"})
    r = c.post("/api/sensors", json=base).json()
    assert r["command"]["pump"] is True

    # pump reported on -> alert shown
    c.post("/api/sensors", json={**base, "pump_on": True})
    assert any(a["sensor"] == "Pump" for a in c.get("/api/status").json()["alerts"])
    assert c.post("/api/suppression", json={"action": "boom"}).status_code == 422
