'use client';
import { useEffect, useRef, useState } from 'react';
import { Panel, SensorLine, FlameTimeline, fireBands, fmtTime, COLORS } from './Charts';

const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';
const CLIENT_MAX = 1200; // client-side cap, matches backend history (~10 min)
const RANGES = [{ label: '30 sec', s: 30 }, { label: '1 min', s: 60 }, { label: '5 min', s: 300 }];

const getJSON = (path) => fetch(API + path, { cache: 'no-store' }).then((r) => {
  if (!r.ok) throw new Error(r.status);
  return r.json();
});

function usePoll() {
  const [status, setStatus] = useState(null);
  const [history, setHistory] = useState([]);
  const [backendUp, setBackendUp] = useState(null);

  useEffect(() => {
    let version = null;
    let alive = true;
    async function tick() {
      try {
        const s = await getJSON('/api/status');
        if (s.history_version !== version) {
          // first load, or backend switched LIVE<->DEMO and cleared its buffer
          const h = await getJSON(`/api/sensors/history?limit=${CLIENT_MAX}`);
          version = s.history_version;
          if (alive) setHistory(h);
        } else {
          // pull a few recent points so nothing is missed between polls
          const recent = await getJSON('/api/sensors/history?limit=10');
          if (alive) setHistory((h) => {
            const lastT = h.at(-1)?.t ?? 0;
            const fresh = recent.filter((p) => p.t > lastT);
            return fresh.length ? [...h, ...fresh].slice(-CLIENT_MAX) : h;
          });
        }
        if (alive) { setStatus(s); setBackendUp(true); }
      } catch {
        if (alive) setBackendUp(false);
      }
    }
    tick();
    const id = setInterval(tick, 1000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  return { status, history, backendUp };
}

const OVERALL = {
  SAFE: { cls: 'ok', icon: '🟢', label: 'ALL CLEAR', text: 'No flame detected. All monitored values within limits.' },
  WARNING: { cls: 'warn', icon: '🟠', label: 'WARNING', text: 'Abnormal reading detected. Check active alerts.' },
  FIRE: { cls: 'fire', icon: '🔴', label: 'FIRE DETECTED', text: 'Flame sensor triggered. Follow the evacuation procedure.' },
  OFFLINE: { cls: 'off', icon: '⚫', label: 'NO LIVE DATA', text: 'No live sensor data available. Check ESP32 power and WiFi.' },
};

const fmt = (v, d = 1) => (v == null ? '—' : Number(v).toFixed(d));

// Two-tone siren via Web Audio (no sound file). Browsers only allow audio after a user
// click, so the AudioContext is created by the "Enable alarm sound" button.
function useAlarm(ctxRef, active) {
  useEffect(() => {
    const ctx = ctxRef.current;
    if (!active || !ctx) return;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'square';
    gain.gain.value = 0.12;
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    let high = true;
    const id = setInterval(() => {
      high = !high;
      osc.frequency.setValueAtTime(high ? 880 : 660, ctx.currentTime);
    }, 450);
    osc.frequency.value = 880;
    return () => { clearInterval(id); osc.stop(); osc.disconnect(); };
  }, [ctxRef, active]);
}

export default function Dashboard() {
  const { status, history, backendUp } = usePoll();
  const [range, setRange] = useState(30);
  const [demoBusy, setDemoBusy] = useState(false);

  const overallKey = backendUp === false ? 'OFFLINE' : status?.overall ?? 'OFFLINE';
  const overall = OVERALL[overallKey];
  const latest = status?.online ? status.latest : null;
  const demo = status?.mode === 'DEMO';

  const audioRef = useRef(null);
  const [soundOn, setSoundOn] = useState(false);
  const flameNow = latest?.flame1 === 0 || latest?.flame2 === 0;
  useAlarm(audioRef, soundOn && flameNow);
  function toggleSound() {
    if (soundOn) { audioRef.current?.suspend(); setSoundOn(false); return; }
    audioRef.current ??= new AudioContext();
    audioRef.current.resume();
    setSoundOn(true);
  }

  // visible window measured on the server clock so browser clock skew doesn't matter
  const now = status?.server_time ?? 0;
  const domain = [now - range, now];
  const view = backendUp ? history.filter((p) => p.t >= now - range) : [];
  const bands = fireBands(view);
  const hasDHT = view.some((p) => p.temperature != null);
  const hasSmoke = view.some((p) => p.smoke != null);
  const noData = view.length === 0;
  const offlineMsg = ['No live sensor data available', backendUp === false ? 'Backend unreachable' : 'Waiting for ESP32…'];

  async function toggleDemo() {
    setDemoBusy(true);
    try {
      await fetch(`${API}/api/demo`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !demo }),
      });
    } finally { setDemoBusy(false); }
  }

  const lastSeen = status?.esp32_last_seen ? Math.max(0, Math.round(now - status.esp32_last_seen)) : null;

  return (
    <main className="wrap">
      {/* ---------- Header ---------- */}
      <header className="top">
        <div>
          <p className="eyebrow">ESP32 · DHT11 · 2× Flame · MQ-2</p>
          <h1>Industrial Fire Monitoring Control Room</h1>
        </div>
        <div className="top-right">
          <span className={`pill ${demo ? 'pill-warn' : latest ? 'pill-ok' : 'pill-off'}`}>
            {demo ? '◆ DEMO MODE' : latest ? '● LIVE DATA' : '○ NO LIVE DATA'}
          </span>
          <span className="muted small">{now ? fmtTime(now) : '--:--:--'}</span>
          <button className={`btn ${flameNow && !soundOn ? 'btn-alarm' : ''}`} onClick={toggleSound} aria-pressed={soundOn}>
            {soundOn ? '🔔 Alarm sound on' : '🔕 Enable alarm sound'}
          </button>
          <button className="btn" onClick={toggleDemo} disabled={!backendUp || demoBusy} aria-pressed={demo}>
            {demo ? 'Exit demo mode' : 'Start demo mode'}
          </button>
        </div>
      </header>
      {demo && (
        <div className="demo-banner" role="note">
          DEMO MODE — all values below are simulated. Real ESP32 data automatically switches back to LIVE DATA.
        </div>
      )}

      {/* ---------- Main Fire Status ---------- */}
      <section className={`status status-${overall.cls}`} role="status" aria-live="assertive">
        <span className="status-icon" aria-hidden>{overall.icon}</span>
        <div>
          <h2>{overall.label}</h2>
          <p>{overall.text}</p>
        </div>
        <div className="status-meta">
          <span>{status?.alerts?.length ?? 0} active alert(s)</span>
          {latest && <span className="muted small">Updated {fmtTime(latest.t)}</span>}
        </div>
      </section>

      {/* ---------- Sensor Cards ---------- */}
      <section className="cards">
        <Card label="Temperature" value={fmt(latest?.temperature)} unit="°C" sub="DHT11"
          state={latest?.temperature == null ? 'off' : latest.temperature >= status.thresholds.temp_warn ? 'warn' : 'ok'} />
        <Card label="Humidity" value={fmt(latest?.humidity)} unit="%" sub="DHT11"
          state={latest?.humidity == null ? 'off' : 'ok'} />
        {[1, 2].map((n) => {
          const v = latest?.[`flame${n}`];
          return <Card key={n} label={`Flame Sensor ${n}`} sub={`raw: ${v ?? '—'} (1 = no flame, 0 = flame)`}
            value={v == null ? '—' : v === 0 ? 'FLAME' : 'CLEAR'} state={v == null ? 'off' : v === 0 ? 'fire' : 'ok'} />;
        })}
        <Card label="MQ-2 Smoke" value={latest?.smoke ?? (latest ? 'N/C' : '—')} unit={latest?.smoke != null ? 'raw ADC' : ''}
          sub={latest?.smoke != null ? 'uncalibrated, not PPM' : 'MQ-2 not connected'}
          state={latest?.smoke == null ? 'off' : latest.smoke >= status.thresholds.smoke_warn ? 'warn' : 'ok'} />
      </section>

      {/* ---------- System Health ---------- */}
      <section className="panel">
        <header className="panel-head"><h3>System Health</h3></header>
        <ul className="health">
          <Health name="Backend API" ok={backendUp} text={backendUp ? 'Online' : backendUp === false ? 'Unreachable' : 'Checking…'} />
          <Health name="ESP32 link" ok={demo ? null : status?.online && !demo}
            text={demo ? 'Demo (simulated)' : lastSeen == null ? 'Never connected' : status.online ? `Last seen ${lastSeen}s ago` : `Offline · ${lastSeen}s ago`} />
          <Health name="DHT11" ok={latest ? latest.temperature != null : null} text={latest ? (latest.temperature != null ? 'Reading' : 'Data unavailable') : '—'} />
          <Health name="Flame sensors" ok={latest ? true : null} text={latest ? 'Reporting' : '—'} />
          <Health name="Suppression" ok={latest?.pump_on == null ? null : latest.mode === 'backend'}
            text={latest?.pump_on == null ? 'No data (old firmware?)' : latest.mode === 'backend' ? 'Controlled by backend' : 'ESP32 local mode'} />
          <Health name="MQ-2" ok={latest?.smoke != null ? true : null} text={latest?.smoke != null ? 'Reading' : 'Not connected'} />
          <Health name="Buffered readings" ok={null} text={`${history.length} / ${CLIENT_MAX}`} />
        </ul>
      </section>

      {/* ---------- Graphs / Sensor Overview ---------- */}
      <section className="graphs">
        <div className="graphs-head">
          <h2>Sensor Overview {demo && <span className="pill pill-warn small">DEMO</span>}</h2>
          <div className="seg" role="group" aria-label="Visible time range">
            {RANGES.map((r) => (
              <button key={r.s} className={range === r.s ? 'on' : ''} aria-pressed={range === r.s} onClick={() => setRange(r.s)}>
                {r.label}
              </button>
            ))}
          </div>
        </div>
        <p className="muted small legend-note">
          <span className="swatch" style={{ background: COLORS.fire }} /> Shaded red = period where a flame sensor reported fire
        </p>
        <div className="grid2">
          <Panel title="Temperature History" subtitle="°C · DHT11"
            empty={noData ? offlineMsg : !hasDHT && ['DHT11 data unavailable', 'Check DHT11 wiring']}>
            <SensorLine data={view} domain={domain} dataKey="temperature" name="Temperature" unit="°C"
              color={COLORS.temperature} yLabel="Temperature (°C)" yDomain={['dataMin - 2', 'dataMax + 2']}
              threshold={status?.thresholds.temp_warn} bands={bands} />
          </Panel>
          <Panel title="Humidity History" subtitle="% RH · DHT11"
            empty={noData ? offlineMsg : !hasDHT && ['DHT11 data unavailable', 'Check DHT11 wiring']}>
            <SensorLine data={view} domain={domain} dataKey="humidity" name="Humidity" unit="%"
              color={COLORS.humidity} yLabel="Humidity (%)" yDomain={[0, 100]} bands={bands} />
          </Panel>
          <Panel title={hasSmoke ? 'MQ-2 Raw Sensor Reading' : 'Smoke Sensor History'} subtitle="raw ADC 0–4095 · not PPM"
            empty={noData ? offlineMsg : !hasSmoke && ['MQ-2 NOT CONNECTED', 'Waiting for sensor data…']}>
            <SensorLine data={view} domain={domain} dataKey="smoke" name="MQ-2 raw" unit=""
              color={COLORS.smoke} yLabel="Raw ADC value" yDomain={[0, 'auto']}
              threshold={status?.thresholds.smoke_warn} bands={bands} />
          </Panel>
          <Panel title="Flame Detection Timeline" subtitle="digital · 1 = no flame, 0 = flame" empty={noData && offlineMsg}>
            <FlameTimeline data={view} domain={domain} />
          </Panel>
        </div>
      </section>

      {/* ---------- Live Telemetry Table ---------- */}
      <section className="panel">
        <header className="panel-head"><h3>Live Telemetry</h3><span className="muted small">latest 10 readings</span></header>
        {history.length === 0 ? <p className="muted pad">No live sensor data available</p> : (
          <div className="table-scroll">
            <table>
              <thead><tr><th>Time</th><th>Temp (°C)</th><th>Humidity (%)</th><th>Flame 1</th><th>Flame 2</th><th>MQ-2 raw</th><th>Fire at</th><th>Pump</th><th>Nozzle</th><th>Source</th></tr></thead>
              <tbody>
                {history.slice(-10).reverse().map((p) => (
                  <tr key={p.t} className={p.flame1 === 0 || p.flame2 === 0 ? 'row-fire' : ''}>
                    <td>{fmtTime(p.t)}</td><td>{fmt(p.temperature)}</td><td>{fmt(p.humidity)}</td>
                    <td>{p.flame1 === 0 ? '0 🔥' : '1'}</td><td>{p.flame2 === 0 ? '0 🔥' : '1'}</td>
                    <td>{p.smoke ?? 'N/C'}</td>
                    <td>{!p.fire_position || p.fire_position === 'none' ? '—' : p.fire_position}</td>
                    <td>{p.pump_on == null ? '—' : p.pump_on ? 'ON 💧' : 'off'}</td>
                    <td>{p.servo_angle == null ? '—' : `${p.servo_angle}°`}</td><td>{p.source === 'demo' ? 'DEMO' : 'ESP32'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ---------- Active Alerts ---------- */}
      <section className="panel">
        <header className="panel-head"><h3>Active Alerts</h3></header>
        {backendUp === false ? <p className="muted pad">Backend unreachable — alerts unavailable</p>
          : !status?.alerts?.length ? <p className="muted pad">✓ No active alerts</p> : (
            <ul className="alerts">
              {status.alerts.map((a) => (
                <li key={a.message} className={`alert alert-${a.level}`}>
                  <span aria-hidden>{a.level === 'critical' ? '⛔' : '⚠️'}</span>
                  <strong>{a.level.toUpperCase()}</strong>
                  <span className="muted">{a.sensor}</span>
                  <span>{a.message}</span>
                </li>
              ))}
            </ul>
          )}
      </section>

      {/* ---------- System Architecture ---------- */}
      <section className="panel">
        <header className="panel-head"><h3>System Architecture</h3></header>
        <ol className="arch">
          {[
            ['Sensors', 'DHT11 · Flame ×2 · MQ-2'],
            ['ESP32', 'Reads every 0.5 s · aims nozzle · runs pump'],
            ['WiFi · HTTP POST', 'JSON → /api/sensors'],
            ['FastAPI backend', 'Alerts · history · spray decision'],
            ['Next.js dashboard', 'Polls every 1 s'],
          ].map(([t, s]) => <li key={t}><strong>{t}</strong><span className="muted small">{s}</span></li>)}
        </ol>
      </section>

      <section className="grid2">
        {/* ---------- AI / ML Future Module ---------- */}
        <section className="panel future">
          <header className="panel-head"><h3>AI / ML Module</h3><span className="pill pill-off small">PLANNED</span></header>
          <ul className="muted">
            <li>Fire-risk prediction from temperature/humidity/smoke trends</li>
            <li>Anomaly detection to reduce false flame alarms</li>
            <li>Camera-based flame & smoke recognition</li>
          </ul>
        </section>
        {/* ---------- Fire Suppression Module ---------- */}
        <Suppression latest={latest} sup={status?.suppression} demo={demo} online={!!status?.online} />
      </section>
    </main>
  );
}

const DIRECTION = (a) => (a == null ? '' : a > 100 ? 'left' : a < 80 ? 'right' : 'centre');

function Suppression({ latest, sup, demo, online }) {
  const [busy, setBusy] = useState(false);
  const hasData = latest?.pump_on != null;
  const ov = sup?.override ?? { mode: null, seconds_left: 0 };
  const pumpOn = !!latest?.pump_on;

  async function send(action) {
    setBusy(true);
    try {
      await fetch(`${API}/api/suppression`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
    } finally { setBusy(false); }
  }

  const disabled = busy || demo || !online;
  return (
    <section className="panel">
      <header className="panel-head">
        <h3>Fire Suppression Module</h3>
        <span className={`pill small ${!hasData ? 'pill-off' : pumpOn ? 'pill-warn' : 'pill-ok'}`}>
          {!hasData ? 'NO DATA' : pumpOn ? '💧 SPRAYING' : 'STANDBY'}
        </span>
      </header>
      {!hasData ? (
        <p className="muted pad">
          {demo ? 'Not simulated in demo mode.' : 'Waiting for the suppression firmware (pump and servo status).'}
        </p>
      ) : (
        <ul className="health">
          <Health name="Water pump" ok={pumpOn ? false : true} text={pumpOn ? 'ON, spraying' : 'Off'} />
          <Health name="Fire position" ok={latest.fire_position == null ? null : latest.fire_position === 'none'}
            text={!latest.fire_position || latest.fire_position === 'none' ? 'No fire' : `🔥 ${latest.fire_position.toUpperCase()}`} />
          {/* Not reported by the ESP32: same rule the firmware uses (flame seen or pump running) */}
          <Health name="Red LED + buzzer" ok={!(pumpOn || latest.flame1 === 0 || latest.flame2 === 0)}
            text={pumpOn || latest.flame1 === 0 || latest.flame2 === 0 ? 'Alarm on' : 'Off (green LED on)'} />
          <Health name="Nozzle" ok={null} text={`${latest.servo_angle}° (${DIRECTION(latest.servo_angle)})`} />
          <Health name="Control" ok={latest.mode === 'backend'}
            text={latest.mode === 'backend' ? 'Backend decides' : 'ESP32 deciding locally (backend not answering)'} />
          <Health name="Operator override" ok={ov.mode ? false : null}
            text={ov.mode === 'spray' ? `Manual spray, ${ov.seconds_left}s left`
              : ov.mode === 'block' ? `Spraying blocked, ${ov.seconds_left}s left` : 'None (automatic)'} />
        </ul>
      )}
      <div className="pad" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button className="btn" disabled={disabled} onClick={() => send('spray')}>💧 Spray now (10 s)</button>
        <button className="btn" disabled={disabled} onClick={() => send('block')}>✋ Block spraying (60 s)</button>
        <button className="btn" disabled={disabled || !ov.mode} onClick={() => send('auto')}>↺ Back to automatic</button>
      </div>
    </section>
  );
}

function Card({ label, value, unit, sub, state }) {
  return (
    <div className={`card card-${state}`}>
      <span className="card-label">{label}</span>
      <span className="card-value">{value}<small>{unit && ` ${unit}`}</small></span>
      <span className="muted small">{sub}</span>
    </div>
  );
}

function Health({ name, ok, text }) {
  const cls = ok === true ? 'ok' : ok === false ? 'fire' : 'off';
  return (
    <li><span className={`dot dot-${cls}`} aria-hidden /> <span>{name}</span> <span className="muted small">{text}</span></li>
  );
}
