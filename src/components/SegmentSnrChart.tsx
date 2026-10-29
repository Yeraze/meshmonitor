/**
 * Route segment SNR chart with a time-of-day / chronological toggle, shown in
 * a traceroute segment's map popup. Split from `useTraceroutePaths` so
 * recharts loads with the first popup that draws a chart, not with the map.
 */
import { useMemo, useState } from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';

export default function SegmentSnrChart({ chartData }: {
  chartData: Array<{ timeDecimal: number; timeLabel: string; snr: number; fullTimestamp: number }>;
}) {
  const [mode, setMode] = useState<'timeOfDay' | 'chronological'>('timeOfDay');

  const chronoData = useMemo(() =>
    [...chartData].sort((a, b) => a.fullTimestamp - b.fullTimestamp).map(d => {
      const date = new Date(d.fullTimestamp);
      const month = (date.getMonth() + 1).toString().padStart(2, '0');
      const day = date.getDate().toString().padStart(2, '0');
      const hours = date.getHours().toString().padStart(2, '0');
      const minutes = date.getMinutes().toString().padStart(2, '0');
      return { ...d, chronoLabel: `${month}/${day} ${hours}:${minutes}`, chronoTime: d.fullTimestamp };
    }), [chartData]);

  return (
    <div className="snr-timeline-chart">
      <div style={{ display: 'flex', gap: '4px', marginBottom: '6px' }}>
        <button
          className={`node-popup-tab ${mode === 'timeOfDay' ? 'active' : ''}`}
          style={{ fontSize: '10px', padding: '2px 8px', border: '1px solid var(--color-surface-active)', borderRadius: '4px', cursor: 'pointer', background: mode === 'timeOfDay' ? 'var(--color-accent)' : 'var(--color-surface)', color: mode === 'timeOfDay' ? 'var(--color-bg)' : 'var(--color-text-muted)' }}
          onClick={e => { e.stopPropagation(); setMode('timeOfDay'); }}
        >
          Time of Day
        </button>
        <button
          className={`node-popup-tab ${mode === 'chronological' ? 'active' : ''}`}
          style={{ fontSize: '10px', padding: '2px 8px', border: '1px solid var(--color-surface-active)', borderRadius: '4px', cursor: 'pointer', background: mode === 'chronological' ? 'var(--color-accent)' : 'var(--color-surface)', color: mode === 'chronological' ? 'var(--color-bg)' : 'var(--color-text-muted)' }}
          onClick={e => { e.stopPropagation(); setMode('chronological'); }}
        >
          Over Time
        </button>
      </div>
      <ResponsiveContainer width="100%" height={150}>
        {mode === 'timeOfDay' ? (
          <LineChart data={chartData} margin={{ top: 10, right: 10, left: -20, bottom: 5 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--color-surface-active)" />
            <XAxis
              dataKey="timeDecimal"
              type="number"
              domain={[0, 24]}
              ticks={[0, 6, 12, 18, 24]}
              tickFormatter={value => {
                const hours = Math.floor(value);
                const minutes = Math.round((value - hours) * 60);
                return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;
              }}
              tick={{ fill: 'var(--color-text-muted)', fontSize: 10 }}
              stroke="var(--color-surface-active)"
            />
            <YAxis
              tick={{ fill: 'var(--color-text-muted)', fontSize: 10 }}
              stroke="var(--color-surface-active)"
              label={{ value: 'SNR (dB)', angle: -90, position: 'insideLeft', style: { fill: 'var(--color-text-muted)', fontSize: 10 } }}
            />
            <Tooltip
              contentStyle={{ backgroundColor: 'var(--color-surface)', border: '1px solid var(--color-surface-active)', borderRadius: '4px', fontSize: '12px' }}
              labelStyle={{ color: 'var(--color-text)' }}
              labelFormatter={value => {
                const item = chartData.find(d => d.timeDecimal === value);
                return item ? item.timeLabel : String(value);
              }}
            />
            <Line type="monotone" dataKey="snr" stroke="var(--color-accent-alt)" strokeWidth={2} dot={{ fill: 'var(--color-accent-alt)', r: 3 }} />
          </LineChart>
        ) : (
          <LineChart data={chronoData} margin={{ top: 10, right: 10, left: -20, bottom: 5 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--color-surface-active)" />
            <XAxis
              dataKey="chronoTime"
              type="number"
              domain={['dataMin', 'dataMax']}
              tickFormatter={value => {
                const date = new Date(value);
                return `${(date.getMonth() + 1).toString().padStart(2, '0')}/${date.getDate().toString().padStart(2, '0')}`;
              }}
              tick={{ fill: 'var(--color-text-muted)', fontSize: 10 }}
              stroke="var(--color-surface-active)"
            />
            <YAxis
              tick={{ fill: 'var(--color-text-muted)', fontSize: 10 }}
              stroke="var(--color-surface-active)"
              label={{ value: 'SNR (dB)', angle: -90, position: 'insideLeft', style: { fill: 'var(--color-text-muted)', fontSize: 10 } }}
            />
            <Tooltip
              contentStyle={{ backgroundColor: 'var(--color-surface)', border: '1px solid var(--color-surface-active)', borderRadius: '4px', fontSize: '12px' }}
              labelStyle={{ color: 'var(--color-text)' }}
              labelFormatter={value => {
                const item = chronoData.find(d => d.chronoTime === value);
                return item ? item.chronoLabel : String(value);
              }}
            />
            <Line type="monotone" dataKey="snr" stroke="var(--color-accent-alt)" strokeWidth={2} dot={{ fill: 'var(--color-accent-alt)', r: 3 }} />
          </LineChart>
        )}
      </ResponsiveContainer>
    </div>
  );
}
