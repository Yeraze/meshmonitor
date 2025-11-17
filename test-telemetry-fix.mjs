import Database from 'better-sqlite3';

const db = new Database('./dev-data/meshmonitor.db', { readonly: true });

const nodeId = '!3369d264';
const maxHours = 96; // 4 days
const actualIntervalMinutes = 30; // For 96 hours, we use 30-minute intervals

console.log('\n=== Testing Telemetry Fix ===\n');
console.log(`Node: ${nodeId}`);
console.log(`Requested: ${maxHours} hours (${(maxHours/24).toFixed(1)} days)`);
console.log(`Interval: ${actualIntervalMinutes} minutes\n`);

// Step 1: Count telemetry types
const typeCountQuery = `
  SELECT COUNT(DISTINCT telemetryType) as typeCount
  FROM telemetry
  WHERE nodeId = ?
`;
const result = db.prepare(typeCountQuery).get(nodeId);
const telemetryTypeCount = result.typeCount;

console.log(`📊 Telemetry Types: ${telemetryTypeCount}`);

// Step 2: Calculate LIMIT
const pointsPerHour = 60 / actualIntervalMinutes;
const expectedPointsPerType = (maxHours + 1) * pointsPerHour;
const limit = Math.ceil(expectedPointsPerType * telemetryTypeCount * 1.5);

console.log(`\n💡 LIMIT Calculation:`);
console.log(`   Points per hour: ${pointsPerHour}`);
console.log(`   Expected points per type: ${expectedPointsPerType}`);
console.log(`   Telemetry types: ${telemetryTypeCount}`);
console.log(`   Safety multiplier: 1.5x`);
console.log(`   => LIMIT: ${limit} rows\n`);

// Step 3: Get actual data time range
const timeRangeQuery = `
  SELECT MIN(timestamp) as minTs, MAX(timestamp) as maxTs
  FROM telemetry
  WHERE nodeId = ?
`;
const timeRange = db.prepare(timeRangeQuery).get(nodeId);
const cutoffTime = timeRange.maxTs - (maxHours * 60 * 60 * 1000);

console.log(`🕐 Data Time Range:`);
console.log(`   Earliest: ${new Date(timeRange.minTs).toISOString()}`);
console.log(`   Latest:   ${new Date(timeRange.maxTs).toISOString()}`);
console.log(`   Cutoff:   ${new Date(cutoffTime).toISOString()}\n`);

// Step 4: Query with LIMIT
const intervalMs = actualIntervalMinutes * 60 * 1000;

const telemetryQuery = `
  SELECT
    nodeId,
    telemetryType,
    CAST((timestamp / ${intervalMs}) * ${intervalMs} AS INTEGER) as timestamp,
    AVG(value) as value
  FROM telemetry
  WHERE nodeId = ? AND timestamp >= ?
  GROUP BY
    nodeId,
    telemetryType,
    CAST(timestamp / ${intervalMs} AS INTEGER)
  ORDER BY timestamp DESC
  LIMIT ?
`;

const telemetryData = db.prepare(telemetryQuery).all(nodeId, cutoffTime, limit);

console.log(`📈 Query Results:`);
console.log(`   Total rows returned: ${telemetryData.length}`);

// Group by type and analyze
const byType = {};
telemetryData.forEach(row => {
  if (!byType[row.telemetryType]) {
    byType[row.telemetryType] = {
      count: 0,
      minTs: Infinity,
      maxTs: -Infinity
    };
  }
  byType[row.telemetryType].count++;
  byType[row.telemetryType].minTs = Math.min(byType[row.telemetryType].minTs, row.timestamp);
  byType[row.telemetryType].maxTs = Math.max(byType[row.telemetryType].maxTs, row.timestamp);
});

console.log(`\n📋 Data Coverage by Type:\n`);
Object.entries(byType)
  .sort((a, b) => a[0].localeCompare(b[0]))
  .forEach(([type, stats]) => {
    const hoursSpan = ((stats.maxTs - stats.minTs) / 1000 / 3600).toFixed(1);
    const daysSpan = (hoursSpan / 24).toFixed(1);
    const coverage = ((hoursSpan / maxHours) * 100).toFixed(0);
    const status = coverage >= 95 ? '✅' : coverage >= 50 ? '⚠️ ' : '❌';
    console.log(`   ${status} ${type.padEnd(20)} ${stats.count.toString().padStart(3)} points, ${hoursSpan.padStart(5)}h (${daysSpan}d) - ${coverage}% coverage`);
  });

// Overall stats
const allTimestamps = telemetryData.map(r => r.timestamp);
const overallMin = Math.min(...allTimestamps);
const overallMax = Math.max(...allTimestamps);
const overallHours = ((overallMax - overallMin) / 1000 / 3600).toFixed(1);
const overallDays = (overallHours / 24).toFixed(1);

console.log(`\n📊 Overall Coverage:`);
console.log(`   Time span: ${overallHours}h (${overallDays} days)`);
console.log(`   Requested: ${maxHours}h (${(maxHours/24).toFixed(1)} days)`);
console.log(`   Coverage: ${((overallHours / maxHours) * 100).toFixed(0)}%`);

if (overallHours >= maxHours * 0.95) {
  console.log(`\n✅ SUCCESS: Full data coverage achieved!`);
} else {
  console.log(`\n❌ PROBLEM: Only ${((overallHours / maxHours) * 100).toFixed(0)}% coverage`);
}

db.close();
