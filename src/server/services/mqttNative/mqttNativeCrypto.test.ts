/**
 * #4305: every packet MQTT-native send builds must open with the repo's OWN
 * decrypt code — channel packets through `channelDecryptionService.tryDecrypt`
 * (what MQTT ingest calls), PKI DMs through
 * `pkiDecryptionService.tryDecryptDirectMessage` — and the envelope must
 * decode with the ServiceEnvelope decoder MQTT ingest uses.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import crypto from 'node:crypto';
import databaseService from '../../../services/database.js';
import { loadProtobufDefinitions } from '../../protobufLoader.js';
import meshtasticProtobufService from '../../meshtasticProtobufService.js';
import { channelDecryptionService, computeChannelHash } from '../channelDecryptionService.js';
import { pkiDecryptionService } from '../pkiDecryptionService.js';
import { nodeNumFromPublicKey } from '../../../services/lowEntropyKeyService.js';
import {
  encryptChannelPayload,
  encryptPkiPayload,
  generateMqttNativeIdentity,
  isUsableNodeNum,
  randomPacketId,
  x25519PublicFromPrivate,
} from './mqttNativeCrypto.js';
import {
  buildMqttNativeTopic,
  deriveRootTopicFromSubscriptions,
  encodeDataMessage,
  encodeMqttNativeEnvelope,
  encodeUserMessage,
  nodeIdFromNum,
  normalizeRootTopic,
} from './mqttNativePacket.js';
import { BROADCAST_NODE_NUM, PortNum, expandShorthandPsk } from '../../constants/meshtastic.js';

beforeAll(async () => {
  await loadProtobufDefinitions();
});

describe('MQTT-native identity', () => {
  it('derives the node number as crc32(publicKey), like firmware 2.8', () => {
    for (let i = 0; i < 5; i++) {
      const id = generateMqttNativeIdentity();
      expect(id.privateKey).toHaveLength(32);
      expect(id.publicKey).toHaveLength(32);
      expect(id.nodeNum).toBe(nodeNumFromPublicKey(id.publicKey.toString('base64')));
      expect(isUsableNodeNum(id.nodeNum)).toBe(true);
      expect(x25519PublicFromPrivate(id.privateKey).equals(id.publicKey)).toBe(true);
    }
  });

  it('refuses reserved and broadcast node numbers', () => {
    expect(isUsableNodeNum(0)).toBe(false);
    expect(isUsableNodeNum(3)).toBe(false);
    expect(isUsableNodeNum(BROADCAST_NODE_NUM)).toBe(false);
    expect(isUsableNodeNum(4)).toBe(true);
  });

  it('makes non-zero 32-bit packet ids', () => {
    for (let i = 0; i < 50; i++) {
      const id = randomPacketId();
      expect(id).toBeGreaterThan(0);
      expect(id).toBeLessThanOrEqual(0xffffffff);
    }
  });
});

describe('channel encryption round-trips through channelDecryptionService', () => {
  const pskB64 = crypto.randomBytes(32).toString('base64');
  let aeadId = 0;

  beforeAll(async () => {
    await databaseService.channelDatabase.createAsync({
      name: 'NativeCtr', psk: pskB64, pskLength: 32, isEnabled: true, enforceNameValidation: true,
    });
    aeadId = await databaseService.channelDatabase.createAsync({
      name: 'NativeAead', psk: crypto.randomBytes(16).toString('base64'), pskLength: 16,
      isEnabled: true, enforceNameValidation: true, useAead: true,
    });
    await channelDecryptionService.refreshChannelCache();
  });

  it('AES-CTR channel text decrypts with the MQTT ingest decrypt', async () => {
    const from = 0x11223344;
    const id = randomPacketId();
    const psk = expandShorthandPsk(Buffer.from(pskB64, 'base64'))!;
    const data = encodeDataMessage({ portnum: PortNum.TEXT_MESSAGE_APP, payload: Buffer.from('hello mesh') });
    const encrypted = encryptChannelPayload(data, { psk, useAead: false, packetId: id, fromNode: from, toNode: BROADCAST_NODE_NUM });
    const hash = computeChannelHash('NativeCtr', psk, false);
    const r = await channelDecryptionService.tryDecrypt(encrypted, id, from, hash, BROADCAST_NODE_NUM);
    expect(r.success).toBe(true);
    expect(r.channelName).toBe('NativeCtr');
    expect(r.portnum).toBe(PortNum.TEXT_MESSAGE_APP);
    expect(Buffer.from(r.payload!).toString('utf8')).toBe('hello mesh');
    // ok_to_mqtt is set: we originate on MQTT.
    expect((r.bitfield ?? 0) & 1).toBe(1);
  });

  it('AES-CCM (AEAD) channel text decrypts with the MQTT ingest decrypt, hash ^ 0xAE', async () => {
    const row = await databaseService.channelDatabase.getByIdAsync(aeadId);
    const psk = Buffer.from(row!.psk, 'base64');
    const from = 0x0a0b0c0d;
    const id = randomPacketId();
    const data = encodeDataMessage({ portnum: PortNum.TEXT_MESSAGE_APP, payload: Buffer.from('aead hi'), replyId: 77, emoji: 1 });
    const encrypted = encryptChannelPayload(data, { psk, useAead: true, packetId: id, fromNode: from, toNode: BROADCAST_NODE_NUM });
    const hash = computeChannelHash('NativeAead', psk, true);
    expect(hash).toBe(computeChannelHash('NativeAead', psk, false) ^ 0xae);
    const r = await channelDecryptionService.tryDecrypt(encrypted, id, from, hash, BROADCAST_NODE_NUM);
    expect(r.success).toBe(true);
    expect(r.channelName).toBe('NativeAead');
    expect(Buffer.from(r.payload!).toString('utf8')).toBe('aead hi');
    expect(r.replyId).toBe(77);
    expect(r.emoji).toBe(1);
  });
});

describe('PKI DM encryption round-trips through pkiDecryptionService', () => {
  it('the recipient opens it with its private key and our public key', () => {
    const us = generateMqttNativeIdentity();
    const them = generateMqttNativeIdentity();
    const id = randomPacketId();
    const data = encodeDataMessage({ portnum: PortNum.TEXT_MESSAGE_APP, payload: Buffer.from('secret dm') });
    const blob = encryptPkiPayload(data, {
      localPrivateKey: us.privateKey, remotePublicKey: them.publicKey, packetId: id, fromNode: us.nodeNum,
    });
    // ciphertext | 8-byte tag | 4-byte extra nonce
    expect(blob.length).toBe(data.length + 12);
    const r = pkiDecryptionService.tryDecryptDirectMessage(them.privateKey, us.publicKey, id, us.nodeNum, blob);
    expect(r.success).toBe(true);
    expect(r.portnum).toBe(PortNum.TEXT_MESSAGE_APP);
    expect(Buffer.from(r.payload!).toString('utf8')).toBe('secret dm');
  });

  it('uses the firmware CCM nonce layout [id][extraNonce][from][0] (CryptoEngine::initNonce)', async () => {
    const { derivePkiAesKey } = await import('../pkiDecryptionService.js');
    const us = generateMqttNativeIdentity();
    const them = generateMqttNativeIdentity();
    const id = 0x11223344;
    const extra = 0xa1b2c3d4;
    const data = encodeDataMessage({ portnum: PortNum.TEXT_MESSAGE_APP, payload: Buffer.from('kat') });
    const blob = encryptPkiPayload(data, {
      localPrivateKey: us.privateKey, remotePublicKey: them.publicKey, packetId: id, fromNode: us.nodeNum, extraNonce: extra,
    });
    expect(blob.readUInt32LE(blob.length - 4)).toBe(extra);
    // Rebuild the nonce by hand, independently of buildPkiNonce.
    const nonce = Buffer.alloc(13);
    nonce.writeUInt32LE(id, 0);
    nonce.writeUInt32LE(extra, 4);
    nonce.writeUInt32LE(us.nodeNum, 8);
    const decipher = crypto.createDecipheriv('aes-256-ccm', derivePkiAesKey(them.privateKey, us.publicKey), nonce, { authTagLength: 8 });
    decipher.setAuthTag(blob.subarray(blob.length - 12, blob.length - 4));
    const plain = Buffer.concat([decipher.update(blob.subarray(0, blob.length - 12)), decipher.final()]);
    expect(plain.equals(Buffer.from(data))).toBe(true);
  });

  it('a third party cannot open it', () => {
    const us = generateMqttNativeIdentity();
    const them = generateMqttNativeIdentity();
    const eve = generateMqttNativeIdentity();
    const id = randomPacketId();
    const data = encodeDataMessage({ portnum: PortNum.TEXT_MESSAGE_APP, payload: Buffer.from('x') });
    const blob = encryptPkiPayload(data, {
      localPrivateKey: us.privateKey, remotePublicKey: them.publicKey, packetId: id, fromNode: us.nodeNum,
    });
    expect(pkiDecryptionService.tryDecryptDirectMessage(eve.privateKey, us.publicKey, id, us.nodeNum, blob).success).toBe(false);
  });
});

describe('envelope and topic shape', () => {
  it('encodes the ServiceEnvelope MQTT ingest decodes', () => {
    const payload = encodeMqttNativeEnvelope({
      from: 0xdeadbeef, to: BROADCAST_NODE_NUM, id: 0x01020304, channel: 8, hopLimit: 3,
      encrypted: Buffer.from([1, 2, 3]), pkiEncrypted: false, channelId: 'LongFast', gatewayId: '!deadbeef',
    });
    const env = meshtasticProtobufService.decodeServiceEnvelope(payload)!;
    expect(env.channelId).toBe('LongFast');
    expect(env.gatewayId).toBe('!deadbeef');
    expect(env.packet.from >>> 0).toBe(0xdeadbeef);
    expect(env.packet.to >>> 0).toBe(BROADCAST_NODE_NUM);
    expect(env.packet.id >>> 0).toBe(0x01020304);
    expect(env.packet.channel).toBe(8);
    expect(env.packet.hopLimit).toBe(3);
    expect(env.packet.hopStart).toBe(3);
    expect(env.packet.wantAck).toBeFalsy();
    expect(env.packet.viaMqtt).toBeFalsy();
    expect(env.packet.pkiEncrypted).toBeFalsy();
    expect(Buffer.from(env.packet.encrypted)).toEqual(Buffer.from([1, 2, 3]));
  });

  it('marks PKI DMs with channel 0 and pki_encrypted', () => {
    const payload = encodeMqttNativeEnvelope({
      from: 5, to: 6, id: 7, channel: 0, hopLimit: 0,
      encrypted: Buffer.from([9]), pkiEncrypted: true, channelId: 'PKI', gatewayId: '!00000005',
    });
    const env = meshtasticProtobufService.decodeServiceEnvelope(payload)!;
    expect(env.channelId).toBe('PKI');
    expect(env.packet.pkiEncrypted).toBe(true);
    expect(env.packet.channel ?? 0).toBe(0);
  });

  it('NodeInfo carries our id, names, PRIVATE_HW, CLIENT_MUTE and public key', () => {
    const us = generateMqttNativeIdentity();
    const bytes = encodeUserMessage({ nodeNum: us.nodeNum, longName: 'MeshMonitor ab12', shortName: 'ab12', publicKey: us.publicKey });
    const user = meshtasticProtobufService.processPayload(PortNum.NODEINFO_APP, bytes);
    expect(user.id).toBe(nodeIdFromNum(us.nodeNum));
    expect(user.longName).toBe('MeshMonitor ab12');
    expect(user.shortName).toBe('ab12');
    expect(user.hwModel).toBe(255);
    expect(user.role).toBe(1);
    expect(Buffer.from(user.publicKey).equals(us.publicKey)).toBe(true);
  });

  it('builds {root}/2/e/{channel}/{gatewayId}', () => {
    expect(buildMqttNativeTopic('msh/US/FL', 'LongFast', '!0000abcd')).toBe('msh/US/FL/2/e/LongFast/!0000abcd');
    expect(buildMqttNativeTopic('msh/US', 'PKI', '!0000abcd')).toBe('msh/US/2/e/PKI/!0000abcd');
  });

  it('normalizes and derives root topics', () => {
    expect(normalizeRootTopic(' msh/US/FL/ ')).toBe('msh/US/FL');
    expect(normalizeRootTopic('msh/US/FL/2/e')).toBe('msh/US/FL');
    expect(normalizeRootTopic('msh/US/FL/2/e/LongFast')).toBe('msh/US/FL');
    expect(normalizeRootTopic('msh/+/FL')).toBeNull();
    expect(normalizeRootTopic('msh/#')).toBeNull();
    expect(normalizeRootTopic('')).toBeNull();
    expect(normalizeRootTopic(42)).toBeNull();
    expect(deriveRootTopicFromSubscriptions(['msh/US/FL/#'])).toBe('msh/US/FL');
    expect(deriveRootTopicFromSubscriptions(['msh/US/FL/2/e/#'])).toBe('msh/US/FL');
    expect(deriveRootTopicFromSubscriptions(['msh/+/2/e/#'])).toBe('msh');
    expect(deriveRootTopicFromSubscriptions(['#'])).toBeNull();
    expect(deriveRootTopicFromSubscriptions([])).toBeNull();
  });
});
