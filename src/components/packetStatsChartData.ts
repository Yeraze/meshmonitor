/**
 * Data shapes for `PacketStatsChart`, kept free of recharts so a component can
 * build chart data (and colour its legend) while the chart itself is a lazy
 * chunk.
 */

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
