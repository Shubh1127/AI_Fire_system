# ESP32 Fire Monitoring System

## Run
Backend (port 8000, binds all interfaces so the ESP32 can reach it):

    cd backend && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
    .venv/bin/uvicorn main:app --host 0.0.0.0 --port 8000
    .venv/bin/python -m pytest -q        # self-check

Frontend (port 3000):

    cd frontend && npm install && npm run dev
    # backend elsewhere? NEXT_PUBLIC_API_URL=http://<ip>:8000 npm run dev

ESP32: open `firmware/fire_monitor/fire_monitor.ino`, set WiFi + `API_URL` (your laptop's LAN IP),
flash. Set `MQ2_CONNECTED 1` only after the MQ-2 voltage divider is wired.

## API
- `POST /api/sensors` — ESP32 reading `{temperature, humidity, flame1, flame2, smoke}` (null = unavailable)
- `GET  /api/sensors/latest`
- `GET  /api/sensors/history?limit=60` (max 600, in memory)
- `GET  /api/status` — mode, overall status, alerts, health
- `POST /api/demo {"enabled": true}` — simulated data; any real ESP32 POST turns it off

Thresholds (temperature, rapid rise, MQ-2 raw) are constants at the top of `backend/main.py`.
