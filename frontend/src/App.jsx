import React, { useState, useEffect, useMemo } from 'react';
import {
  ComposedChart, Area, Line, Bar, BarChart, Cell, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, ReferenceLine,
} from 'recharts';
import './App.css';


const API = import.meta.env.VITE_API_URL || 'https://qwerty-i8su.vercel.app/api';
const TZ = 'Europe/London';
// Decisions made in January 2026 are for delivery on 2 Jan to 1 Feb 2026
const DATE_MIN = '2026-01-02';
const DATE_MAX = '2026-02-01';
const CUTOFFS = ['08:00', '09:00', '10:00', '12:00'];

const nf = (n, d = 0) => (n == null || Number.isNaN(n) ? '–' : n.toLocaleString('en-GB', { maximumFractionDigits: d, minimumFractionDigits: d }));
const fmtTime = (t) => new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: TZ });
const fmtStamp = (t) => new Date(t).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: TZ });
const fmtDate = (s) => new Date(s + 'T12:00:00Z').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
const addDays = (s, n) => { const d = new Date(s + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

function useApi(path) {
  const [s, setS] = useState({ status: 'loading' });
  const [n, setN] = useState(0);
  useEffect(() => {
    let off = false;
    setS({ status: 'loading' });
    fetch(API + path)
      .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then((d) => { if (!off) setS({ status: 'ready', data: d }); })
      .catch((e) => { console.error('Failed to fetch data:', e); if (!off) setS({ status: 'error' }); });
    return () => { off = true; };
  }, [path, n]);
  return [s, () => setN((x) => x + 1)];
}


const AX = { fill: '#8aa5b1', fontSize: 12 };

function Loading() { return <div className="wd-skel" aria-busy="true" aria-label="Loading Elexon data" />; }
function Failed({ retry }) {
  return (
    <div className="wd-state" role="alert">
      <h2 className="wd-h">Can't reach the data service</h2>
      <p>The dashboard couldn't load data from {API}. Check that the backend is running, then try again.</p>
      <button className="wd-retry" onClick={retry}>Try again</button>
    </div>
  );
}
function Kpi({ label, value, note, color }) {
  return <div className="wd-kpi"><span>{label}</span><b style={color ? { color } : undefined}>{value}</b><span>{note}</span></div>;
}

/* ---------- Day-ahead view: what the forecast said when the buyer had to decide ---------- */
function DayView({ date, cutoff, p90 }) {
  const [s, retry] = useApi(`/day?date=${date}&cutoff=${cutoff}`);
  const [hover, setHover] = useState(null);
  useEffect(() => setHover(null), [date, cutoff]);

  const pts = useMemo(() => (s.data?.points || []).map((p) => ({
    ...p,
    t: new Date(p.startTime).getTime(),
    band: p.forecast != null && p90 != null ? [Math.max(0, p.forecast - p90), p.forecast + p90] : null,
    error: p.forecast != null && p.actual != null ? p.forecast - p.actual : null,
  })), [s.data, p90]);

  if (s.status === 'loading') return <Loading />;
  if (s.status === 'error') return <Failed retry={retry} />;
  if (!pts.length) return <div className="wd-state"><h2 className="wd-h">No forecast for this day</h2><p>Elexon has no wind forecast published before {cutoff} on {fmtDate(addDays(date, -1))}. Try a later cutoff or another day.</p></div>;

  const withErr = pts.filter((p) => p.error != null);
  const mwh = (arr, f) => arr.reduce((a, p) => a + f(p) * 0.5, 0);
  const expected = mwh(pts, (p) => p.forecast ?? 0);
  const lowCase = p90 != null ? mwh(pts, (p) => Math.max(0, (p.forecast ?? 0) - p90)) : null;
  const published = Math.max(...pts.map((p) => new Date(p.publishTime).getTime()));
  const dayMae = withErr.length ? withErr.reduce((a, p) => a + Math.abs(p.error), 0) / withErr.length : null;
  const dayBias = withErr.length ? withErr.reduce((a, p) => a + p.error, 0) / withErr.length : null;
  const cur = hover || pts[Math.floor(pts.length / 2)];

  return (
    <>
      <section className="wd-stage" aria-label="Day-ahead wind forecast">
        <div className="wd-read" aria-live="polite">
          <div>
            <div className="wd-time">{fmtStamp(cur.t)}</div>
            <div className="wd-vals">
              <div className="wd-val">
                <div className="wd-num" style={{ color: 'var(--forecast)' }}>{nf(cur.forecast)}<small>MW</small></div>
                <span className="wd-key dash"><i style={{ color: 'var(--forecast)' }} />Forecast at {cutoff}</span>
              </div>
              <div className="wd-val">
                <div className="wd-num" style={{ color: 'var(--actual)' }}>{nf(cur.actual)}<small>MW</small></div>
                <span className="wd-key"><i style={{ color: 'var(--actual)' }} />Actual</span>
              </div>
            </div>
          </div>
          {cur.error != null && (
            <div className="wd-time" style={{ textAlign: 'right' }}>
              Forecast was <b style={{ color: cur.error > 0 ? 'var(--forecast)' : 'var(--actual)' }}>{nf(Math.abs(cur.error))} MW {cur.error > 0 ? 'too high' : 'too low'}</b>
            </div>
          )}
        </div>
        <div style={{ height: 360 }}>
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={pts} onMouseMove={(st) => st?.activePayload?.[0] && setHover(st.activePayload[0].payload)} onMouseLeave={() => setHover(null)} margin={{ top: 8, right: 8, left: -8, bottom: 0 }}>
              <defs>
                <linearGradient id="gA" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#4fd1c5" stopOpacity={0.35} /><stop offset="100%" stopColor="#4fd1c5" stopOpacity={0} /></linearGradient>
              </defs>
              <CartesianGrid stroke="#1f3a47" strokeDasharray="2 6" vertical={false} />
              <XAxis dataKey="t" type="number" scale="time" domain={['dataMin', 'dataMax']} tickFormatter={fmtTime} tick={AX} axisLine={false} tickLine={false} minTickGap={48} />
              <YAxis tick={AX} axisLine={false} tickLine={false} width={56} tickFormatter={(v) => (v / 1000).toFixed(0) + ' GW'} />
              <Tooltip content={() => null} cursor={{ stroke: '#e3eef1', strokeOpacity: 0.5 }} />
              {p90 != null && <Area dataKey="band" stroke="none" fill="#f4b860" fillOpacity={0.18} isAnimationActive={false} />}
              <Area dataKey="actual" type="monotone" stroke="#4fd1c5" strokeWidth={2.5} fill="url(#gA)" dot={false} activeDot={{ r: 5, fill: '#4fd1c5', stroke: '#0b1820', strokeWidth: 2 }} />
              <Line dataKey="forecast" type="monotone" stroke="#f4b860" strokeWidth={2.5} strokeDasharray="6 4" dot={false} activeDot={{ r: 5, fill: '#f4b860', stroke: '#0b1820', strokeWidth: 2 }} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
        {p90 != null && <div className="wd-legend"><span className="wd-key band"><i style={{ width: 22 }} />Typical error range (±{nf(p90)} MW, covers 90% of past misses)</span></div>}
      </section>

      <section className="wd-kpis" aria-label="Day summary">
        <Kpi label="Expected wind energy" value={`${nf(expected / 1000, 1)} GWh`} note={`Sum of the ${cutoff} forecast across the day.`} color="var(--forecast)" />
        <Kpi label="Low-wind planning case" value={lowCase == null ? '–' : `${nf(lowCase / 1000, 1)} GWh`} note="Forecast minus the typical error. Plan to buy extra cover against this." />
        <Kpi label="Forecast last updated" value={fmtStamp(published)} note="Latest forecast published before the cutoff." />
        <Kpi label="How this day turned out" value={dayMae == null ? '–' : `${nf(dayMae)} MW`} note={dayMae == null ? 'Actuals not available yet.' : `Average miss. Forecasts ran ${dayBias > 0 ? 'high' : 'low'} by ${nf(Math.abs(dayBias))} MW on average.`} />
      </section>
    </>
  );
}

/* ---------- Accuracy view: how far off the forecasts usually are ---------- */
function AccuracyView({ s, retry, onPick, picked }) {
  if (s.status === 'loading') return <Loading />;
  if (s.status === 'error') return <Failed retry={retry} />;
  const { summary: m, daily, byHour } = s.data;
  return (
    <>
      <section className="wd-kpis" aria-label="Accuracy summary">
        <Kpi label="Average miss (MAE)" value={`${nf(m.mae)} MW`} note={`${nf((m.mae / m.meanActual) * 100, 1)}% of average generation (${nf(m.meanActual)} MW).`} color="var(--forecast)" />
        <Kpi label="Large misses (RMSE)" value={`${nf(m.rmse)} MW`} note="Weighs big errors more heavily than MAE." />
        <Kpi label="Bias" value={`${m.bias > 0 ? '+' : '−'}${nf(Math.abs(m.bias))} MW`} note={m.bias > 0 ? 'Forecasts ran high on average.' : 'Forecasts ran low on average.'} color={m.bias > 0 ? 'var(--forecast)' : 'var(--actual)'} />
        <Kpi label="90% of misses are under" value={`${nf(m.p90AbsError)} MW`} note={`Across ${nf(m.n)} half-hours over ${m.days} delivery days.`} />
      </section>
      <div className="wd-2">
        <section className="wd-stage" style={{ marginBottom: 0 }}>
          <h2 className="wd-h">Average miss by delivery day</h2>
          <p className="wd-hs">Select a bar to open that day's forecast.</p>
          <div style={{ height: 280 }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={daily} margin={{ top: 4, right: 4, left: -8, bottom: 0 }}>
                <CartesianGrid stroke="#1f3a47" strokeDasharray="2 6" vertical={false} />
                <XAxis dataKey="date" tick={AX} axisLine={false} tickLine={false} tickFormatter={(d) => +d.slice(8)} interval={1} />
                <YAxis tick={AX} axisLine={false} tickLine={false} width={56} tickFormatter={(v) => nf(v)} />
                <Tooltip cursor={{ fill: 'rgba(227,238,241,.06)' }} contentStyle={{ background: '#102530', border: '1px solid #1f3a47', borderRadius: 10 }}
                  labelFormatter={fmtDate} formatter={(v) => [`${nf(v)} MW`, 'Average miss']} />
                <Bar dataKey="mae" radius={[4, 4, 0, 0]} cursor="pointer" onClick={(d) => onPick(d.date)}>
                  {daily.map((d) => <Cell key={d.date} fill={d.date === picked ? '#f4b860' : '#4fd1c5'} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </section>
        <section className="wd-stage" style={{ marginBottom: 0 }}>
          <h2 className="wd-h">Average miss by time of day</h2>
          <p className="wd-hs">Bars show the average miss. The line shows bias: above zero means forecasts ran high.</p>
          <div style={{ height: 280 }}>
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={byHour} margin={{ top: 4, right: 4, left: -8, bottom: 0 }}>
                <CartesianGrid stroke="#1f3a47" strokeDasharray="2 6" vertical={false} />
                <XAxis dataKey="hour" tick={AX} axisLine={false} tickLine={false} tickFormatter={(h) => String(h).padStart(2, '0')} interval={2} />
                <YAxis tick={AX} axisLine={false} tickLine={false} width={56} tickFormatter={(v) => nf(v)} />
                <ReferenceLine y={0} stroke="#8aa5b1" strokeOpacity={0.6} />
                <Tooltip cursor={{ fill: 'rgba(227,238,241,.06)' }} contentStyle={{ background: '#102530', border: '1px solid #1f3a47', borderRadius: 10 }}
                  labelFormatter={(h) => `${String(h).padStart(2, '0')}:00`} formatter={(v, n) => [`${nf(v)} MW`, n === 'mae' ? 'Average miss' : 'Bias']} />
                <Bar dataKey="mae" fill="#4fd1c5" fillOpacity={0.7} radius={[4, 4, 0, 0]} />
                <Line dataKey="bias" stroke="#f4b860" strokeWidth={2.5} dot={false} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </section>
      </div>
    </>
  );
}

export default function App() {
  const [tab, setTab] = useState('day');
  const [date, setDate] = useState('2026-01-15');
  const [cutoff, setCutoff] = useState('09:00');
  const [acc, retryAcc] = useApi(`/accuracy?cutoff=${cutoff}`);
  const p90 = acc.status === 'ready' ? acc.data.summary.p90AbsError : null;

  return (
    <div className="wd">
      <div className="wd-wrap">
        <header className="wd-head">
          <div>
            <h1>Wind forecast for day-ahead buying</h1>
            <p className="wd-sub">What the wind forecast said when you had to buy, and how far off it usually is. UK national wind generation from Elexon, January 2026.</p>
          </div>
          <div className="wd-seg" role="group" aria-label="View">
            <button aria-pressed={tab === 'day'} onClick={() => setTab('day')}>Forecast for a delivery day</button>
            <button aria-pressed={tab === 'acc'} onClick={() => setTab('acc')}>Forecast accuracy</button>
          </div>
        </header>

        <div className="wd-ctl">
          {tab === 'day' && (
            <div className="wd-step">
              <button aria-label="Previous day" disabled={date <= DATE_MIN} onClick={() => setDate(addDays(date, -1))}>‹</button>
              <label>Delivery day
                <input type="date" min={DATE_MIN} max={DATE_MAX} value={date} onChange={(e) => e.target.value && setDate(e.target.value)} />
              </label>
              <button aria-label="Next day" disabled={date >= DATE_MAX} onClick={() => setDate(addDays(date, 1))}>›</button>
            </div>
          )}
          <label>Buying decision cutoff (UK time, day before)
            <select value={cutoff} onChange={(e) => setCutoff(e.target.value)}>
              {CUTOFFS.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </label>
        </div>

        <p className="wd-note">
          {tab === 'day'
            ? <>For <b>{fmtDate(date)}</b>, showing the latest forecast published before <b>{cutoff} on {fmtDate(addDays(date, -1))}</b>, which is what you could use when buying.</>
            : <>Every figure compares actual generation with the latest forecast available at <b>{cutoff} the day before</b>, for each delivery day from 2 January to 1 February 2026.</>}
        </p>

        {tab === 'day'
          ? <DayView date={date} cutoff={cutoff} p90={p90} />
          : <AccuracyView s={acc} retry={retryAcc} picked={date} onPick={(d) => { setDate(d); setTab('day'); }} />}
      </div>
    </div>
  );
}