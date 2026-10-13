"""Fire & smoke monitoring backend.

ESP32 POSTs readings to /api/sensors; the dashboard polls /api/status and
/api/sensors/history. History lives in memory only.
"""
import asyncio
import math
import time
from collections import deque
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Optional

from fastapi import FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

# Tuning knobs - adjust to your room and sensors.
HISTORY_MAX = 600          # ~10 min at 1 reading/s
OFFLINE_AFTER_S = 5        # no reading for this long => ESP32 offline
TEMP_WARN_C = 45.0
TEMP_RISE_WARN_C = 3.0     # rise within TEMP_RISE_WINDOW_S => warning
TEMP_RISE_WINDOW_S = 30
SMOKE_WARN_RAW = 1500      # raw 12-bit ADC, NOT ppm - calibrate against clean air

# ponytail: in-memory history, lost on restart; swap for SQLite/Postgres when persistence matters
history = deque(maxlen=HISTORY_MAX)
state = {"demo": False, "last_esp32": None, "history_version": 0}


class Reading(BaseModel):
    temperature: Optional[float] = Field(None, ge=-40, le=125)
    humidity: Optional[float] = Field(None, ge=0, le=100)
    flame1: int = Field(..., ge=0, le=1)  # 1 = no flame, 0 = flame detected
    flame2: int = Field(..., ge=0, le=1)
    smoke: Optional[int] = Field(None, ge=0, le=4095)


class DemoToggle(BaseModel):
    enabled: bool


def clear_history():
    history.clear()
    state["history_version"] += 1


def add_reading(r: Reading, source: str):
    history.append({
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "t": time.time(),
        **r.model_dump(),
        "source": source,
    })


def compute_alerts(latest, now):
    alerts = []
    if latest is None or now - latest["t"] > OFFLINE_AFTER_S:
        return [{"level": "critical", "sensor": "ESP32", "message": "No live sensor data - ESP32 offline"}]
    for key, name in (("flame1", "Flame Sensor 1"), ("flame2", "Flame Sensor 2")):
        if latest[key] == 0:
            alerts.append({"level": "critical", "sensor": name, "message": f"Flame detected by {name}"})
    temp = latest["temperature"]
    if temp is None:
        alerts.append({"level": "warning", "sensor": "DHT11", "message": "DHT11 data unavailable - check wiring"})
    else:
        if temp >= TEMP_WARN_C:
            alerts.append({"level": "warning", "sensor": "DHT11", "message": f"High temperature: {temp:.1f} °C"})
        past = [h for h in history if h["temperature"] is not None and latest["t"] - h["t"] <= TEMP_RISE_WINDOW_S]
        if past and temp - past[0]["temperature"] >= TEMP_RISE_WARN_C:
            alerts.append({"level": "warning", "sensor": "DHT11",
                           "message": f"Rapid temperature rise: +{temp - past[0]['temperature']:.1f} °C in {TEMP_RISE_WINDOW_S}s"})
    if latest["smoke"] is not None and latest["smoke"] >= SMOKE_WARN_RAW:
        alerts.append({"level": "warning", "sensor": "MQ-2", "message": f"Smoke level high (raw {latest['smoke']})"})
    return alerts


def demo_reading(tick: int) -> Reading:
    """90 s scripted scenario: normal -> heating -> flame -> cooling."""
    p = tick % 90
    if p < 25:
        temp = 25 + 0.3 * math.sin(tick / 3)
    elif p < 60:
        temp = 25 + (p - 25) * 0.7
    else:
        temp = max(25.0, 49.5 - (p - 60) * 0.8)
    return Reading(
        temperature=round(temp, 1),
        humidity=round(max(20.0, 55 - (temp - 25) * 0.9), 1),
        flame1=0 if 45 <= p < 62 else 1,
        flame2=0 if 50 <= p < 58 else 1,
        smoke=int(300 + max(0, temp - 25) * 70),
    )


async def demo_loop():
    tick = 0
    while True:
        await asyncio.sleep(1)
        if state["demo"]:
            add_reading(demo_reading(tick), "demo")
            tick += 1
        else:
            tick = 0


@asynccontextmanager
async def lifespan(_app):
    task = asyncio.create_task(demo_loop())
    yield
    task.cancel()


app = FastAPI(title="Fire Monitoring API", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


@app.post("/api/sensors")
def ingest(r: Reading):
    if state["demo"]:  # real hardware wins: leave demo and drop simulated points
        state["demo"] = False
        clear_history()
    state["last_esp32"] = time.time()
    add_reading(r, "esp32")
    return {"ok": True}


@app.get("/api/sensors/latest")
def latest():
    return history[-1] if history else None


@app.get("/api/sensors/history")
def get_history(limit: int = Query(60, ge=1, le=HISTORY_MAX)):
    return list(history)[-limit:]


@app.get("/api/status")
def status():
    now = time.time()
    last = history[-1] if history else None
    online = last is not None and now - last["t"] <= OFFLINE_AFTER_S
    alerts = compute_alerts(last, now)
    if not online:
        overall = "OFFLINE"
    elif any(a["level"] == "critical" for a in alerts):
        overall = "FIRE"
    elif alerts:
        overall = "WARNING"
    else:
        overall = "SAFE"
    return {
        "mode": "DEMO" if state["demo"] else "LIVE",
        "overall": overall,
        "online": online,
        "esp32_last_seen": state["last_esp32"],
        "server_time": now,
        "latest": last,
        "alerts": alerts,
        "history_version": state["history_version"],
        "thresholds": {"temp_warn": TEMP_WARN_C, "smoke_warn": SMOKE_WARN_RAW},
    }


@app.post("/api/demo")
def set_demo(body: DemoToggle):
    if body.enabled != state["demo"]:
        state["demo"] = body.enabled
        clear_history()  # never mix simulated and real points
    return {"demo": state["demo"]}
