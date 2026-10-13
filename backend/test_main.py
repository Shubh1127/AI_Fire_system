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
