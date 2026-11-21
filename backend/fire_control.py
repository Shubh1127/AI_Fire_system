"""Suppression decision layer: tells the ESP32 where to aim the nozzle and
whether to run the pump. Swap the rule block in decide() for the ML model later.
"""
import time

# Must match ANGLE_* in the ESP32 sketch
ANGLE_LEFT = 135
ANGLE_RIGHT = 45
ANGLE_CENTER = 90

FLAME_CONFIRM_READINGS = 2   # flame in 2 consecutive readings (~1 s) = confirmed fire
TEMP_FIRE_C = 50
TEMP_RISE_C = 8
SMOKE_HIGH = 2000            # raw ADC, calibrate once MQ-2 is connected
SPRAY_HOLD_S = 2.0           # keep spraying this long after the flame disappears

MANUAL_SPRAY_S = 10          # "Spray now" button runs for this long
MANUAL_BLOCK_S = 60          # "Block spray" button lasts this long

# Operator override from the dashboard. mode: None (auto) | "spray" | "block"
override = {"mode": None, "until": 0.0}

_state = {"baseline": None, "streak": 0, "angle": ANGLE_CENTER, "last_fire": 0.0}


def set_override(action: str):
    now = time.time()
    if action == "spray":
        override.update(mode="spray", until=now + MANUAL_SPRAY_S)
    elif action == "block":
        override.update(mode="block", until=now + MANUAL_BLOCK_S)
    else:
        override.update(mode=None, until=0.0)


def override_status():
    left = override["until"] - time.time()
    if override["mode"] and left > 0:
        return {"mode": override["mode"], "seconds_left": round(left)}
    override.update(mode=None, until=0.0)
    return {"mode": None, "seconds_left": 0}


def reset():
    _state.update(baseline=None, streak=0, angle=ANGLE_CENTER, last_fire=0.0)
    set_override("auto")


def _aim(f1, f2, ao1, ao2, last):
    if (f1 or f2) and ao1 is not None and ao2 is not None:
        s1, s2 = max(0, 4095 - ao1), max(0, 4095 - ao2)  # lower AO = stronger IR
        if s1 + s2 > 0:
            return round(ANGLE_RIGHT + (ANGLE_LEFT - ANGLE_RIGHT) * s1 / (s1 + s2))
    if f1 and f2:
        return ANGLE_CENTER
    if f1:
        return ANGLE_LEFT
    if f2:
        return ANGLE_RIGHT
    return last


def decide(r: dict) -> dict:
    st = _state
    now = time.time()
    f1 = r.get("flame1") == 0   # active LOW
    f2 = r.get("flame2") == 0
    temp = r.get("temperature")
    smoke = r.get("smoke")

    if temp is not None and not (f1 or f2):
        st["baseline"] = temp if st["baseline"] is None else 0.95 * st["baseline"] + 0.05 * temp
    st["streak"] = st["streak"] + 1 if (f1 or f2) else 0

    hot = temp is not None and (
        temp >= TEMP_FIRE_C or (st["baseline"] is not None and temp - st["baseline"] >= TEMP_RISE_C)
    )
    smoky = smoke is not None and smoke >= SMOKE_HIGH

    # ---- Rule-based risk (replace with ML model later) ----
    if st["streak"] >= FLAME_CONFIRM_READINGS or ((f1 or f2) and (hot or smoky)):
        risk = "FIRE"
    elif (f1 or f2) or hot or smoky:
        risk = "WARNING"
    else:
        risk = "SAFE"
    # -------------------------------------------------------

    if risk == "FIRE":
        st["last_fire"] = now
        st["angle"] = _aim(f1, f2, r.get("flame1_ao"), r.get("flame2_ao"), st["angle"])

    pump = (now - st["last_fire"]) < SPRAY_HOLD_S
    ov = override_status()["mode"]
    if ov == "spray":
        pump = True
    elif ov == "block":
        pump = False

    return {"risk": risk, "command": {"servo_angle": int(st["angle"]), "pump": bool(pump)}}
