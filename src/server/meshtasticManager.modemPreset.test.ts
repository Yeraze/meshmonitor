/**
 * Regression test for #3644: the per-source modem preset (used as the slot-0
 * channel display-name fallback) must only be persisted when the node actually
 * runs on a preset (usePreset=true). With a custom LoRa config (usePreset=false)
 * the modemPreset field sits at its proto3 default of 0 (=LONG_FAST), so
 * persisting it would mislabel a blank-named primary channel as "LongFast".
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const setSetting = vi.fn().mockResolvedValue(undefined);
const deleteSetting = vi.fn().mockResolvedValue(undefined);

vi.mock('../services/database.js', () => ({
  default: {
    settings: {
      getSetting: vi.fn().mockResolvedValue(null),
      setSetting: (...a: unknown[]) => setSetting(...a),
      deleteSetting: (...a: unknown[]) => deleteSetting(...a),
      getSettingForSource: vi.fn().mockResolvedValue(null),
      setSourceSetting: vi.fn().mockResolvedValue(undefined),
      getAllSettings: vi.fn().mockResolvedValue({}),
    },
    channels: {
      getChannelById: vi.fn().mockResolvedValue(null),
      getAllChannels: vi.fn().mockResolvedValue([]),
      upsertChannel: vi.fn().mockResolvedValue(undefined),
      getChannelCount: vi.fn().mockResolvedValue(0),
    },
  },
}));

vi.mock('./meshtasticProtobufService.js', () => ({ default: { initialize: vi.fn(), createMeshPacket: vi.fn() } }));
vi.mock('./protobufService.js', () => ({ default: { encode: vi.fn(), decode: vi.fn() }, convertIpv4ConfigToStrings: vi.fn() }));
vi.mock('./protobufLoader.js', () => ({ getProtobufRoot: vi.fn() }));
vi.mock('./tcpTransport.js', () => ({ TcpTransport: vi.fn() }));
vi.mock('../utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('./services/notificationService.js', () => ({ notificationService: { checkAndSendNotifications: vi.fn() } }));
vi.mock('./services/serverEventNotificationService.js', () => ({ serverEventNotificationService: { notifyNodeConnected: vi.fn(), notifyNodeDisconnected: vi.fn() } }));
vi.mock('./services/packetLogService.js', () => ({ default: { logPacket: vi.fn() } }));
vi.mock('./services/channelDecryptionService.js', () => ({ channelDecryptionService: { tryDecrypt: vi.fn() } }));
vi.mock('./services/dataEventEmitter.js', () => ({ dataEventEmitter: { emit: vi.fn(), on: vi.fn() } }));
vi.mock('./messageQueueService.js', () => {
  const mockInstance = { enqueue: vi.fn(), setSendCallback: vi.fn(), handleAck: vi.fn(), handleFailure: vi.fn(), recordExternalSend: vi.fn(), clear: vi.fn(), getStatus: vi.fn(() => ({ queueLength: 0, pendingAcks: 0, processing: false })) };
  function MessageQueueService() { return mockInstance as any; }
  return { messageQueueService: mockInstance, MessageQueueService };
});
vi.mock('./utils/cronScheduler.js', () => ({ validateCron: vi.fn(() => true), scheduleCron: vi.fn(() => ({ stop: vi.fn() })) }));
vi.mock('./config/environment.js', () => ({ getEnvironmentConfig: vi.fn(() => ({ NODE_IP: '127.0.0.1', TCP_PORT: 4403, LOG_LEVEL: 'info' })) }));
vi.mock('../utils/autoResponderUtils.js', () => ({ normalizeTriggerPatterns: vi.fn() }));
vi.mock('../utils/nodeHelpers.js', () => ({ isNodeComplete: vi.fn() }));

const SOURCE = 'default';

describe('MeshtasticManager - persistModemPreset (#3644)', () => {
  let manager: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    const module = await import('./meshtasticManager.js');
    manager = module.fallbackManager;
    manager.sourceId = SOURCE;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('persists the preset when the node runs on a preset (usePreset=true)', async () => {
    await manager.persistModemPreset({ usePreset: true, modemPreset: 3 });
    expect(setSetting).toHaveBeenCalledWith(`lora.preset.${SOURCE}`, '3');
    expect(deleteSetting).not.toHaveBeenCalled();
  });

  it('CLEARS the preset for a custom config (usePreset=false), even with modemPreset=0', async () => {
    // The reported case: custom LoRa config, modemPreset defaulted to 0.
    await manager.persistModemPreset({ usePreset: false, modemPreset: 0 });
    expect(deleteSetting).toHaveBeenCalledWith(`lora.preset.${SOURCE}`);
    expect(setSetting).not.toHaveBeenCalled();
  });

  it('clears the preset when usePreset is absent (treated as non-preset)', async () => {
    await manager.persistModemPreset({ modemPreset: 5 });
    expect(deleteSetting).toHaveBeenCalledWith(`lora.preset.${SOURCE}`);
    expect(setSetting).not.toHaveBeenCalled();
  });

  it('persists the LONG_FAST preset (0) when usePreset is genuinely true', async () => {
    await manager.persistModemPreset({ usePreset: true, modemPreset: 0 });
    expect(setSetting).toHaveBeenCalledWith(`lora.preset.${SOURCE}`, '0');
    expect(deleteSetting).not.toHaveBeenCalled();
  });

  it('no-ops when there is no sourceId', async () => {
    manager.sourceId = null;
    await manager.persistModemPreset({ usePreset: true, modemPreset: 2 });
    expect(setSetting).not.toHaveBeenCalled();
    expect(deleteSetting).not.toHaveBeenCalled();
  });
});
