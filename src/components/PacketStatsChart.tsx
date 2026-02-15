import React, { useMemo } from 'react';
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from 'recharts';

// Color palette for distribution charts (Catppuccin-compatible)
export const DISTRIBUTION_COLORS = [
  '#89b4fa', '#a6e3a1', '#fab387', '#f5c2e7', '#cba6f7',
  '#94e2d5', '#f9e2af', '#f38ba8', '#89dceb', '#b4befe', '#9399b2'
];

// Chart data entry interface
export interface ChartDataEntry {
  name: string;
  value: number;
  color: string;
  [key: string]: string | number;  // Index signature for Recharts compatibility
}

// Reusable packet statistics chart component
export interface PacketStatsChartProps {
  title: string;
  data: ChartDataEntry[];
  total: number;
  chartId: string;
  wide?: boolean;
  bare?: boolean;
  stacked?: boolean;
  headerExtra?: React.ReactNode;
}

const PacketStatsChart: React.FC<PacketStatsChartProps> = React.memo(({ title, data, total, chartId, wide = false, bare = false, stacked = false, headerExtra }) => {
  const filteredData = useMemo(() => data.filter(d => d.value > 0), [data]);

  if (filteredData.length === 0) return null;

  const chartSize = 140;
  const innerRadius = 30;
  const outerRadius = 55;

  const pieChart = (
    <div style={{ width: `${chartSize}px`, height: `${chartSize}px`, flexShrink: 0 }}>
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie
            data={filteredData}
            cx="50%"
            cy="50%"
            innerRadius={innerRadius}
            outerRadius={outerRadius}
            paddingAngle={2}
            dataKey="value"
          >
            {filteredData.map((entry, index) => (
              <Cell key={`${chartId}-cell-${index}`} fill={entry.color} />
            ))}
          </Pie>
          <Tooltip
            formatter={(value, _name, props) => {
              if (value === null || value === undefined) return ['-', ''];
              const numValue = typeof value === 'number' ? value : parseFloat(String(value));
              if (isNaN(numValue)) return ['-', ''];
              const pct = total > 0 ? ((numValue / total) * 100).toFixed(1) : '0';
              const entryName = props?.payload?.name || '';
              return [`${numValue.toLocaleString()} (${pct}%)`, entryName];
            }}
            contentStyle={{
              backgroundColor: 'var(--ctp-surface0)',
              border: '1px solid var(--ctp-surface2)',
              borderRadius: '4px',
              fontSize: '0.85em',
            }}
            itemStyle={{
              color: 'var(--ctp-text)',
            }}
          />
        </PieChart>
      </ResponsiveContainer>
    </div>
  );

  const legend = (
    <div style={{ fontSize: '0.85em', minWidth: 0, overflow: 'hidden' }}>
      {filteredData.map((entry, index) => {
        const pct = total > 0 ? ((entry.value / total) * 100).toFixed(1) : '0';
        return (
          <p key={`${chartId}-legend-${index}`} style={{ margin: '0.25rem 0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            <span style={{
              display: 'inline-block',
              width: '10px',
              height: '10px',
              backgroundColor: entry.color,
              marginRight: '0.5rem',
              borderRadius: '2px',
              flexShrink: 0,
            }}></span>
            {entry.name}: {pct}% ({entry.value.toLocaleString()})
          </p>
        );
      })}
    </div>
  );

  // Bare mode: no wrapper div, used inside a parent combined section
  if (bare) {
    // Stacked: chart above legend (for distribution charts in side-by-side grid)
    if (stacked) {
      return (
        <div style={{ overflow: 'hidden' }}>
          <h3 style={{ fontSize: '1rem', marginBottom: '0.5rem' }}>{title}</h3>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.5rem' }}>
            {pieChart}
            {legend}
          </div>
        </div>
      );
    }
    // Horizontal: chart left, legend right (for RX/TX in stacked box)
    return (
      <div style={{ overflow: 'hidden' }}>
        <h3 style={{ fontSize: '1rem', marginBottom: '0.5rem' }}>{title}</h3>
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
          {pieChart}
          {legend}
        </div>
      </div>
    );
  }

  // Standalone mode: horizontal layout (chart left, legend right)
  const content = (
    <>
      <h3>{title}</h3>
      {headerExtra}
      <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
        {pieChart}
        {legend}
      </div>
    </>
  );

  // When used standalone, wrap in info-section
  if (wide) {
    return <div className="info-section-wide">{content}</div>;
  }

  return <div className="info-section">{content}</div>;
});

PacketStatsChart.displayName = 'PacketStatsChart';

export default PacketStatsChart;
