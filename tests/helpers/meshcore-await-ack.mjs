#!/usr/bin/env node
// Phase 2 helper: subscribe to Socket.IO and resolve when a MeshCore DM
// firmware auto-ack (meshcore:send-confirmed) arrives for a given source.
// The actual DM send is performed by the calling bash script (session+CSRF);
// this process only listens. Coordination: prints "READY" once connected+
// listening so bash knows it is safe to start sending.
//
// Env:
//   BASE_URL      e.g. http://localhost:8089
//   TOKEN         API bearer token (mm_v1_...) for the socket handshake
//   SOURCE_ID     source id to match on the ack event (the sender, = SRC_A_ID)
//   TIMEOUT_MS    overall wait budget after connect (default 90000)
// Output (stdout): "READY" once listening; "ACK sourceId=.. ackCode=.. rttMs=.."
// on success. Diagnostics go to stderr.
// Exit: 0 = ack seen; 1 = timeout; 2 = connect/setup error.
import { io } from 'socket.io-client';

const { BASE_URL, TOKEN, SOURCE_ID } = process.env;
const TIMEOUT_MS = parseInt(process.env.TIMEOUT_MS || '90000', 10);
if (!BASE_URL || !TOKEN || !SOURCE_ID) {
  console.error('missing env (BASE_URL, TOKEN, SOURCE_ID)');
  process.exit(2);
}

const socket = io(BASE_URL, {
  path: '/socket.io',
  auth: { token: TOKEN },
  transports: ['websocket', 'polling'],
  reconnection: true,
  timeout: 10000,
});

let done = false;
const finish = (code) => { if (done) return; done = true; try { socket.close(); } catch { /* socket already closed */ } process.exit(code); };

socket.on('meshcore:send-confirmed', (data) => {
  // No join-source => all events arrive globally. Correlate by sourceId.
  // String()-coerce in case sourceId is ever emitted as a non-string.
  if (data && data.sourceId && String(data.sourceId) !== SOURCE_ID) return;
  console.log(`ACK sourceId=${data?.sourceId} ackCode=${data?.ackCode} rttMs=${data?.roundTripMs}`);
  finish(0);
});

socket.on('connect_error', (e) => { console.error('connect_error:', e?.message || e); });

const connectDeadline = setTimeout(() => {
  if (!socket.connected) { console.error('socket did not connect within 12s'); finish(2); }
}, 12000);

// `connect` can fire again on reconnect (reconnection is enabled). Guard so we
// print READY exactly once and start the ack-wait budget from the first connect
// (not from process start), so the effective timeout is a stable TIMEOUT_MS.
let connectedOnce = false;
socket.on('connect', () => {
  if (connectedOnce) return;
  connectedOnce = true;
  console.log('READY');
  clearTimeout(connectDeadline);
  setTimeout(() => { console.error(`no ack within ${TIMEOUT_MS}ms`); finish(1); }, TIMEOUT_MS);
});
