'use client';
import {
  ResponsiveContainer, LineChart, Line, AreaChart, Area, XAxis, YAxis,
  CartesianGrid, Tooltip, ReferenceArea, ReferenceLine,
} from 'recharts';

export const COLORS = {
  temperature: '#fb923c',
  humidity: '#22d3ee',
  smoke: '#a8a29e',
  fire: '#ef4444',
  warn: '#f59e0b',
  grid: '#1f2a37',
  axis: '#8b98a9',
};

export const fmtTime = (t) =>
  new Date(t * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

const axisProps = { stroke: COLORS.axis, tick: { fill: COLORS.axis, fontSize: 11 }, tickLine: false };

function timeAxis(domain) {
  return (
    <XAxis dataKey="t" type="number" scale="time" domain={domain} tickFormatter={fmtTime}
      {...axisProps} minTickGap={40} />
  );
}

export function Panel({ title, subtitle, children, empty }) {
  return (
    <section className="panel chart-panel">
      <header className="panel-head">
        <h3>{title}</h3>
        {subtitle && <span className="muted small">{subtitle}</span>}
      </header>
      {empty ? (
        <div className="chart-empty" role="status">
          <strong>{empty[0]}</strong>
          {empty[1] && <span className="muted">{empty[1]}</span>}
        </div>
      ) : children}
    </section>
  );
}

/** Contiguous periods where either flame sensor reported 0 (flame). */
export function fireBands(points) {
  const bands = [];
  let start = null;
  points.forEach((p, i) => {
    const fire = p.flame1 === 0 || p.flame2 === 0;
    if (fire && start === null) start = p.t;
    if (start !== null && (!fire || i === points.length - 1)) {
      bands.push([start, p.t]);
      start = null;
    }
  });
  return bands;
}

function ValueTooltip({ active, payload, label, name, unit }) {
  if (!active || !payload?.length || payload[0].value == null) return null;
  return (
    <div className="tip">
      <div className="tip-time">{fmtTime(label)}</div>
      <div>{name}: <strong>{payload[0].value}{unit && ` ${unit}`}</strong></div>
    </div>
  );
}

export function SensorLine({ data, domain, dataKey, name, unit, color, yLabel, yDomain, threshold, bands }) {
  return (
    <div className="chart-box">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 10, right: 16, bottom: 4, left: 8 }}>
          <CartesianGrid stroke={COLORS.grid} vertical={false} />
          {timeAxis(domain)}
          <YAxis {...axisProps} domain={yDomain} width={56}
            label={{ value: yLabel, angle: -90, position: 'insideLeft', fill: COLORS.axis, fontSize: 11, dx: 4, style: { textAnchor: 'middle' } }} />
          {bands.map(([x1, x2]) => (
            <ReferenceArea key={x1} x1={x1} x2={x2} fill={COLORS.fire} fillOpacity={0.14} stroke="none" ifOverflow="hidden" />
          ))}
          {threshold != null && (
            <ReferenceLine y={threshold} stroke={COLORS.warn} strokeDasharray="4 4"
              label={{ value: `warn ${threshold}`, fill: COLORS.warn, fontSize: 10, position: 'insideTopRight' }} />
          )}
          <Tooltip content={<ValueTooltip name={name} unit={unit} />} cursor={{ stroke: COLORS.axis, strokeDasharray: '3 3' }} />
          <Line type="monotone" dataKey={dataKey} stroke={color} strokeWidth={2} dot={false}
            activeDot={{ r: 4, stroke: '#0b1118', strokeWidth: 2 }} connectNulls={false}
            isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function FlameTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  const detected = payload[0].value === 1;
  return (
    <div className="tip">
      <div className="tip-time">{fmtTime(label)}</div>
      <div style={{ color: detected ? COLORS.fire : undefined }}>
        {detected ? '🔥 Flame Detected (0)' : 'No Flame (1)'}
      </div>
    </div>
  );
}

export function FlameTimeline({ data, domain }) {
  return ['flame1', 'flame2'].map((key, i) => {
    const series = data.map((p) => ({ t: p.t, detected: p[key] === 0 ? 1 : 0 }));
    const now = data.at(-1)?.[key];
    const events = fireBands(data.map((p) => ({ ...p, flame1: p[key], flame2: 1 }))).length;
    return (
      <div key={key} className="flame-row">
        <div className="flame-row-head">
          <span>Flame Sensor {i + 1}</span>
          <span className={`pill ${now === 0 ? 'pill-fire' : 'pill-ok'}`}>
            {now === 0 ? '🔥 DETECTED' : '✓ No Flame'}
          </span>
          <span className="muted small">{events} event{events === 1 ? '' : 's'} in view</span>
        </div>
        <div className="flame-box">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={series} margin={{ top: 6, right: 16, bottom: 0, left: 8 }}>
              <CartesianGrid stroke={COLORS.grid} vertical={false} />
              {timeAxis(domain)}
              <YAxis {...axisProps} domain={[0, 1]} ticks={[0, 1]} width={72}
                tickFormatter={(v) => (v ? 'Detected' : 'No Flame')} />
              <Tooltip content={<FlameTooltip />} cursor={{ stroke: COLORS.axis, strokeDasharray: '3 3' }} />
              <Area type="stepAfter" dataKey="detected" stroke={COLORS.fire} strokeWidth={2}
                fill={COLORS.fire} fillOpacity={0.35} isAnimationActive={false} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>
    );
  });
}
