import Database from 'better-sqlite3';

const prodDb = new Database('./prod.db', { readonly: true });
const devDbPath = process.argv[2] || './dev-data/meshmonitor.db';
const devDb = new Database(devDbPath);

// Disable foreign keys temporarily
devDb.pragma('foreign_keys = OFF');

console.log('Clearing existing telemetry data from dev database...');
devDb.prepare('DELETE FROM telemetry').run();

console.log('Copying telemetry data from production...');
const telemetryData = prodDb.prepare('SELECT * FROM telemetry').all();

console.log(`Found ${telemetryData.length} telemetry records`);

const insert = devDb.prepare(`
  INSERT INTO telemetry (nodeId, nodeNum, telemetryType, timestamp, value, unit, createdAt)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);

const insertMany = devDb.transaction((records) => {
  for (const record of records) {
    insert.run(
      record.nodeId,
      record.nodeNum,
      record.telemetryType,
      record.timestamp,
      record.value,
      record.unit,
      record.createdAt
    );
  }
});

insertMany(telemetryData);

const count = devDb.prepare('SELECT COUNT(*) as count FROM telemetry').get();
console.log(`Successfully copied ${count.count} telemetry records to dev database`);

// Show stats on nodes with most telemetry types
const stats = devDb.prepare(`
  SELECT nodeId, COUNT(DISTINCT telemetryType) as type_count, COUNT(*) as total_records
  FROM telemetry
  GROUP BY nodeId
  ORDER BY type_count DESC
  LIMIT 5
`).all();

console.log('\nTop nodes by telemetry type count:');
stats.forEach(node => {
  console.log(`  ${node.nodeId}: ${node.type_count} types, ${node.total_records} records`);
});

// Re-enable foreign keys
devDb.pragma('foreign_keys = ON');

prodDb.close();
devDb.close();
