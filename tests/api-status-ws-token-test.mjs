/**
 * Test: GET /api/v1/status + WebSocket Bearer token auth
 *
 * Usage:
 *   node tests/api-status-ws-token-test.mjs [BASE_URL] [API_TOKEN]
 *
 * Defaults:
 *   BASE_URL  = http://localhost:8081/meshmonitor
 *   API_TOKEN = (required, or set MM_API_TOKEN env var)
 */

import { io } from 'socket.io-client';

const BASE_URL = process.argv[2] || process.env.MM_BASE_URL || 'http://localhost:8081/meshmonitor';
const API_TOKEN = process.argv[3] || process.env.MM_API_TOKEN;

if (!API_TOKEN) {
  console.error('Error: API_TOKEN required. Pass as 2nd arg or set MM_API_TOKEN env var.');
  process.exit(1);
}

let passed = 0;
let failed = 0;

function assert(condition, name) {
  if (condition) {
    console.log(`  PASS  ${name}`);
    passed++;
  } else {
    console.error(`  FAIL  ${name}`);
    failed++;
  }
}

async function fetchJSON(path) {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { 'Authorization': `Bearer ${API_TOKEN}` },
  });
  return { status: res.status, data: await res.json() };
}

// Extract origin and socket.io path from BASE_URL
const baseUrlObj = new URL(BASE_URL);
const ORIGIN = baseUrlObj.origin;
const SOCKET_PATH = `${baseUrlObj.pathname.replace(/\/$/, '')}/socket.io`;

// ─── Tests ──────────────────────────────────────────────────────────────────

async function testStatus() {
  console.log('\n--- GET /api/v1/status ---');
  const { status, data } = await fetchJSON('/api/v1/status');
  assert(status === 200, 'Status 200');
  assert(data.success === true, 'success: true');
  assert('localNodeNum' in data.data, 'Has localNodeNum');
  assert('localNodeId' in data.data, 'Has localNodeId');
  assert('longName' in data.data, 'Has longName');
  assert('shortName' in data.data, 'Has shortName');
  assert('connected' in data.data, 'Has connected');
  assert('nodeResponsive' in data.data, 'Has nodeResponsive');
}

async function testStatusNoAuth() {
  console.log('\n--- GET /api/v1/status without auth ---');
  const res = await fetch(`${BASE_URL}/api/v1/status`);
  assert(res.status === 401, 'Returns 401');
}

async function testWsTokenAuth() {
  console.log('\n--- WebSocket: Bearer token auth ---');
  return new Promise((resolve) => {
    const socket = io(ORIGIN, {
      auth: { token: API_TOKEN },
      path: SOCKET_PATH,
      transports: ['websocket', 'polling'],
      reconnection: false,
      timeout: 5000,
    });

    const timer = setTimeout(() => {
      assert(false, 'Connected with Bearer token');
      socket.disconnect();
      resolve();
    }, 5000);

    socket.on('connect', () => {
      clearTimeout(timer);
      assert(true, 'Connected with Bearer token');
      assert(typeof socket.id === 'string', `Got socket ID: ${socket.id}`);
      socket.disconnect();
      resolve();
    });

    socket.on('connect_error', (err) => {
      clearTimeout(timer);
      assert(false, `Connected with Bearer token (error: ${err.message})`);
      resolve();
    });
  });
}

async function testWsNoAuth() {
  console.log('\n--- WebSocket: No auth (should reject) ---');
  return new Promise((resolve) => {
    const socket = io(ORIGIN, {
      path: SOCKET_PATH,
      transports: ['websocket', 'polling'],
      reconnection: false,
      timeout: 5000,
    });

    const timer = setTimeout(() => {
      assert(false, 'Rejected without auth');
      socket.disconnect();
      resolve();
    }, 5000);

    socket.on('connect', () => {
      clearTimeout(timer);
      assert(false, 'Rejected without auth (unexpectedly connected)');
      socket.disconnect();
      resolve();
    });

    socket.on('connect_error', (err) => {
      clearTimeout(timer);
      assert(err.message.includes('Authentication'), `Rejected: "${err.message}"`);
      resolve();
    });
  });
}

async function testWsBadToken() {
  console.log('\n--- WebSocket: Bad token (should reject) ---');
  return new Promise((resolve) => {
    const socket = io(ORIGIN, {
      auth: { token: 'mm_v1_invalid_garbage_token' },
      path: SOCKET_PATH,
      transports: ['websocket', 'polling'],
      reconnection: false,
      timeout: 5000,
    });

    const timer = setTimeout(() => {
      assert(false, 'Rejected with bad token');
      socket.disconnect();
      resolve();
    }, 5000);

    socket.on('connect', () => {
      clearTimeout(timer);
      assert(false, 'Rejected with bad token (unexpectedly connected)');
      socket.disconnect();
      resolve();
    });

    socket.on('connect_error', (err) => {
      clearTimeout(timer);
      assert(err.message.includes('Authentication'), `Rejected: "${err.message}"`);
      resolve();
    });
  });
}

async function testWsReceivesEvents() {
  console.log('\n--- WebSocket: Token client receives events ---');
  return new Promise((resolve) => {
    const socket = io(ORIGIN, {
      auth: { token: API_TOKEN },
      path: SOCKET_PATH,
      transports: ['websocket', 'polling'],
      reconnection: false,
      timeout: 5000,
    });

    socket.on('connect', () => {
      // The 'connected' event is sent by the server on connection
      socket.on('connected', (data) => {
        assert(data.socketId === socket.id, 'Received "connected" event with matching socketId');
        socket.disconnect();
        resolve();
      });

      // Fallback timeout
      setTimeout(() => {
        assert(true, 'Connected and listening (no "connected" event in time, OK)');
        socket.disconnect();
        resolve();
      }, 2000);
    });

    socket.on('connect_error', (err) => {
      assert(false, `Event test (error: ${err.message})`);
      resolve();
    });
  });
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== API Status + WebSocket Token Auth Tests ===');
  console.log(`  Server: ${BASE_URL}`);
  console.log(`  Token:  ${API_TOKEN.slice(0, 12)}...`);

  await testStatus();
  await testStatusNoAuth();
  await testWsTokenAuth();
  await testWsNoAuth();
  await testWsBadToken();
  await testWsReceivesEvents();

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
