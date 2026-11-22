/**
 * Pure gate for Meshtastic passive clock samples (#6341 Phase 5, D2).
 *
 * A packet may feed `recordClockSample` only when it is a live LoRa reception
 * from another node, the local radio's clock agrees with the server (two-sided
 * `rxTime` check), and the sender's own stamp is a real wall-clock time.
 */
import {
  MIN_PLAUSIBLE_UNIX_SEC,
  LIVE_RECEPTION_WINDOW_SEC,
  isFirmwareReplayPacket,
} from './replayGuard.js';

export interface ClockSampleGateInput {
  /** Packet `rx_time` (unix seconds) stamped by the local radio. */
  rxTimeSec: number | null | undefined;
  nowMs: number;
  fromNum: number;
  localNodeNum: number | null | undefined;
  packetId: number | null | undefined;
  /** Result of `resolveRadioPacketTransport` (1-4 = LoRa). */
  transport: number;
  viaMqtt: boolean | null | undefined;
  viaStoreForward: boolean | null | undefined;
  fromMqttProxy: boolean | null | undefined;
  virtualNodeRequestId: number | null | undefined;
  /** The sender's own time (`Telemetry.time` / `Position.time`), unix seconds. */
  senderSec: number | null | undefined;
}

export function isClockSampleEligible(i: ClockSampleGateInput): boolean {
  const { rxTimeSec, senderSec } = i;
  if (typeof senderSec !== 'number' || !Number.isFinite(senderSec) || senderSec < MIN_PLAUSIBLE_UNIX_SEC) return false;
  if (typeof rxTimeSec !== 'number' || !Number.isFinite(rxTimeSec) || rxTimeSec < MIN_PLAUSIBLE_UNIX_SEC) return false;
  if (Math.abs(i.nowMs / 1000 - rxTimeSec) > LIVE_RECEPTION_WINDOW_SEC) return false;
  if (i.viaMqtt === true || i.viaStoreForward || i.fromMqttProxy || i.virtualNodeRequestId != null) return false;
  if (!(i.transport >= 1 && i.transport <= 4)) return false;
  if (i.localNodeNum != null && i.fromNum === i.localNodeNum) return false;
  if (isFirmwareReplayPacket(i.fromNum, i.packetId, rxTimeSec)) return false;
  return true;
}
