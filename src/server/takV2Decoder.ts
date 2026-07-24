/**
 * ATAK V2 wire decoder (PortNum 78 / ATAK_PLUGIN_V2) — issue #4317.
 *
 * Wire format (see takpacket-sdk/WIRE_FORMAT.md):
 *   [1 flags byte][body]
 * Flags bits 0–5 select a shared zstd dictionary (bits 6–7 reserved, ignored).
 * The body is a zstd frame whose 4-byte magic (28 B5 2F FD) was stripped on
 * encode — it must be re-prepended before decompression. Flags 0xFF means the
 * body is a raw, uncompressed TAKPacketV2 protobuf (skip-compress path /
 * TAK_TRACKER devices that cannot compress).
 *
 * The dictionaries are consumed as runtime data files from the
 * `takpacket-sdk/` git submodule (meshtastic/TAKPacket-SDK, GPL-3.0) — the
 * same posture as the GPL-3.0 `protobufs/` submodule whose .proto files are
 * loaded at runtime. No SDK code is compiled into MeshMonitor; this decoder
 * is written against the public wire spec.
 *
 * Firmware never touches V2 (no transcode, no zstd) — the raw wire payload
 * arrives at TCP clients as-is, so decompression happens here.
 *
 * All failure modes (missing/unbuildable zstd-napi native module, missing
 * dictionary files, corrupt frames, oversized output) degrade to `null`,
 * which callers surface as the pre-#4317 "not decoded" behavior.
 */
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import type * as protobuf from 'protobufjs';
import { logger } from '../utils/logger.js';

/** Flags value meaning "body is raw TAKPacketV2 protobuf, no zstd". */
export const TAK_V2_UNCOMPRESSED = 0xff;

/** Decompression-bomb guard, matching the TAKPacket-SDK decoder limit. */
const MAX_DECOMPRESSED_SIZE = 4096;

/** 4-byte zstd frame magic, stripped on the wire and re-prepended here. */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

const DICT_FILES: Record<number, string> = {
  0: 'dict_non_aircraft.zstd',
  1: 'dict_aircraft.zstd',
};

const DICT_NAMES: Record<number, string> = {
  0: 'non-aircraft',
  1: 'aircraft',
};

/** Human label for a dict ID, for Packet Monitor previews. */
export function takV2DictName(dictId: number): string {
  return DICT_NAMES[dictId] ?? `unknown dict ${dictId}`;
}

// Minimal structural type for zstd-napi's Decompressor — the module is
// loaded lazily via createRequire (native addon; load failure must degrade,
// not crash the receive path), so its types can't be imported statically.
interface ZstdDecompressor {
  decompress(buffer: Uint8Array): Buffer;
  loadDictionary(data: Uint8Array): void;
  setParameters(params: { windowLogMax?: number }): void;
}

let zstdModuleFailed = false;
const decompressors = new Map<number, ZstdDecompressor | null>();

/** Base directory of the TAKPacket-SDK submodule (dictionaries live below it). */
function dictionaryDir(): string {
  // cwd-relative like protobufLoader.ts resolves the protobufs submodule.
  return path.join(process.cwd(), 'takpacket-sdk', 'dictionaries');
}

/**
 * Lazily construct (and cache) the dictionary-loaded decompressor for a dict
 * ID. Returns null (cached) when the native module or dictionary file is
 * unavailable — each failure is warned once, not per-packet.
 */
function getDecompressor(dictId: number): ZstdDecompressor | null {
  if (decompressors.has(dictId)) return decompressors.get(dictId) ?? null;
  if (zstdModuleFailed) return null;

  const dictFile = DICT_FILES[dictId];
  if (!dictFile) {
    // Reserved/unknown dictionary ID — cache the miss so we don't re-log.
    logger.warn(`⚠️ ATAK V2: unknown zstd dictionary ID ${dictId}; packets with this ID will not be decoded`);
    decompressors.set(dictId, null);
    return null;
  }

  let DecompressorCtor: new () => ZstdDecompressor;
  try {
    const require = createRequire(import.meta.url);
    DecompressorCtor = require('zstd-napi').Decompressor;
  } catch (error) {
    zstdModuleFailed = true;
    logger.warn('⚠️ ATAK V2: zstd-napi native module unavailable; V2 packets will not be decoded:', (error as Error).message);
    return null;
  }

  try {
    const dictPath = path.join(dictionaryDir(), dictFile);
    const dict = fs.readFileSync(dictPath);
    const dec = new DecompressorCtor();
    // Parameters MUST be set before loadDictionary — zstd digests the dict
    // under the current parameters, and setting them afterwards silently
    // resets the digested dictionary (see TAKPacket-SDK TakCompressor).
    // windowLogMax 27 covers frames from peer bindings that auto-size their
    // window to the 512 KB dictionary.
    dec.setParameters({ windowLogMax: 27 });
    dec.loadDictionary(dict);
    decompressors.set(dictId, dec);
    return dec;
  } catch (error) {
    logger.warn(`⚠️ ATAK V2: failed to load zstd dictionary '${dictFile}' (is the takpacket-sdk submodule initialized?):`, (error as Error).message);
    decompressors.set(dictId, null);
    return null;
  }
}

/**
 * Decode an ATAK V2 wire payload into a TAKPacketV2 protobuf message.
 * Returns null on any failure (caller falls back to the raw payload,
 * matching processPayload's convention for undecodable ports).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- #4317 protobufjs decode() output has no generated TS type, matching the port-72 convention
export function decodeTakV2Payload(payload: Uint8Array, root: protobuf.Root): any | null {
  if (!payload || payload.length < 2) return null;

  const flags = payload[0];
  const body = payload.subarray(1);

  let protobufBytes: Uint8Array;
  if (flags === TAK_V2_UNCOMPRESSED) {
    protobufBytes = body;
  } else {
    const dictId = flags & 0x3f; // bits 6–7 reserved — receivers ignore them
    const dec = getDecompressor(dictId);
    if (!dec) return null;
    try {
      protobufBytes = dec.decompress(Buffer.concat([ZSTD_MAGIC, Buffer.from(body)]));
    } catch (error) {
      logger.debug(`⚠️ ATAK V2: zstd decompression failed (dict ${dictId}, ${body.length} bytes):`, (error as Error).message);
      return null;
    }
  }

  if (protobufBytes.length > MAX_DECOMPRESSED_SIZE) {
    logger.warn(`⚠️ ATAK V2: decompressed size ${protobufBytes.length} exceeds ${MAX_DECOMPRESSED_SIZE}-byte limit; dropping`);
    return null;
  }

  try {
    const TAKPacketV2 = root.lookupType('meshtastic.TAKPacketV2');
    return TAKPacketV2.decode(protobufBytes);
  } catch (error) {
    logger.debug('⚠️ ATAK V2: TAKPacketV2 protobuf decode failed:', (error as Error).message);
    return null;
  }
}

/**
 * Names the payload_variant oneof member set on a decoded TAKPacketV2, or
 * undefined for the implicit-PLI case (no variant set = position report).
 *
 * Prefers protobufjs's virtual oneof getter (`payloadVariant`); falls back
 * to OWN-property checks for plain-object shapes (tests, toObject output).
 * Own-property semantics matter: protobufjs message prototypes carry field
 * defaults (empty Buffer for `raw_detail`, etc.), so a plain `tak[v]`
 * truthiness read through the prototype chain would misreport every packet
 * as `rawDetail`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- #4317 untyped protobufjs decode() output, matching the port-72 convention
export function takV2Variant(tak: any): string | undefined {
  if (!tak || typeof tak !== 'object') return undefined;
  if (typeof tak.payloadVariant === 'string') return tak.payloadVariant;
  const variants = [
    'chat', 'aircraft', 'rawDetail', 'raw_detail', 'shape', 'marker', 'rab',
    'route', 'casevac', 'emergency', 'task', 'taktalk', 'taktalkRoom', 'taktalk_room',
  ];
  for (const v of variants) {
    if (Object.prototype.hasOwnProperty.call(tak, v) && tak[v] !== undefined && tak[v] !== null) {
      if (v === 'raw_detail') return 'rawDetail';
      if (v === 'taktalk_room') return 'taktalkRoom';
      return v;
    }
  }
  return undefined;
}

/** Test seam: clears cached decompressors / module-failure latch. */
export function resetTakV2DecoderForTests(): void {
  decompressors.clear();
  zstdModuleFailed = false;
}
