/**
 * Remote-admin fetch flows + module-config bookkeeping (#3962 Phase 4.2a PR5
 * §4e, optional split half — see `deviceAdminService.ts`'s header comment for
 * the full split rationale).
 *
 * Extracted from MeshtasticManager: session-passkey acquisition, the
 * request/poll flows that pull config/channel/owner/device-metadata off a
 * remote node over the mesh, reboot/set-time admin commands, and the
 * module-config request/refresh/reset trio.
 *
 * Hazard (mirrors `adminTransactionService.ts`'s `pendingAdminAcks` split):
 * `remoteNodeConfigs`/`remoteNodeChannels`/`remoteNodeOwners`/
 * `remoteNodeDeviceMetadata`/`pendingModuleConfigRequests` are written by
 * `processAdminMessage` (protobuf dispatch, stays on the manager — out of
 * scope per spec §10) when a response packet arrives, and read/cleared here
 * by the outbound request/poll methods on the *opposite side* of
 * `meshtasticManager.ts`. Rather than adding a large set of narrow
 * single-operation accessors for every read/delete/has call, the bridge
 * methods below return the SAME live Map (or Map entry) reference the
 * manager holds — exactly the pattern the pre-existing `getRemoteNodeConfig`
 * accessor already established (it returns `this.remoteNodeConfigs.get(...)`
 * directly, so mutating the returned object mutates the map in place). This
 * keeps in-place mutation (e.g. `delete nodeConfig.moduleConfig[configKey]`)
 * working identically to the pre-extraction code, without widening the
 * fields themselves to public.
 *
 * `LOCAL_MODULE_CONFIG_TYPE_KEYS` moved here verbatim (it was a module-level
 * const in meshtasticManager.ts used only by `requestModuleConfig`, which
 * moved here — no other reference existed, so it becomes dead weight left on
 * the manager if not relocated).
 *
 * Import-cycle discipline (task42a_spec.md §3): constructor-injected
 * `import type` reference to MeshtasticManager, never a static value import.
 */
import type { MeshtasticManager } from '../meshtasticManager.js';
import protobufService from '../protobufService.js';
import { getProtobufRoot } from '../protobufLoader.js';
import { getEnvironmentConfig } from '../config/environment.js';
import { logger } from '../../utils/logger.js';

// Maps AdminMessage.ModuleConfigType enum values to the ModuleConfig oneof key
// used in decoded responses. Covers the module types MeshMonitor surfaces a
// config UI for; used to map empty (all-default, Proto3-omitted) responses back
// to the correct key via pendingModuleConfigRequests.
const LOCAL_MODULE_CONFIG_TYPE_KEYS: { [key: number]: string } = {
  0: 'mqtt',
  5: 'telemetry',
  9: 'neighborInfo',
  13: 'statusmessage',
  14: 'trafficManagement'
};

export class RemoteAdminService {
  constructor(private readonly mgr: MeshtasticManager) {}

  /**
   * Request session passkey from a remote node
   * Uses getDeviceMetadataRequest (per research findings - Android pattern)
   * @param destinationNodeNum The node number to request session passkey from
   * @returns Session passkey if received, null otherwise
   */
  async requestRemoteSessionPasskey(destinationNodeNum: number): Promise<Uint8Array | null> {
    if (!this.mgr.isTransportReady()) {
      throw new Error('Not connected to Meshtastic node');
    }

    if (!this.mgr.getLocalNodeInfo()?.nodeNum) {
      throw new Error('Local node number not available');
    }

    try {
      // Use getDeviceMetadataRequest (per research - Android pattern uses this for SESSIONKEY_CONFIG)
      // We'll need to create this message directly using protobufService
      const root = getProtobufRoot();
      if (!root) {
        throw new Error('Protobuf definitions not loaded. Please ensure protobuf definitions are initialized.');
      }
      const AdminMessage = root.lookupType('meshtastic.AdminMessage');
      if (!AdminMessage) {
        throw new Error('AdminMessage type not found');
      }

      const adminMsg = AdminMessage.create({
        getDeviceMetadataRequest: true
      });
      const encoded = AdminMessage.encode(adminMsg).finish();

      const adminPacket = protobufService.createAdminPacket(encoded, destinationNodeNum, this.mgr.getLocalNodeInfo()!.nodeNum);

      await this.mgr.sendLocalAdminPacket(adminPacket);
      logger.debug(`🔑 Requested session passkey from remote node ${destinationNodeNum} (via getDeviceMetadataRequest)`);

      // Poll for the response instead of fixed wait
      // This allows early exit if response arrives quickly, and longer total wait time
      const maxWaitTime = 45000; // 45 seconds total
      const pollInterval = 500; // Check every 500ms
      const maxPolls = maxWaitTime / pollInterval;

      for (let i = 0; i < maxPolls; i++) {
        await new Promise(resolve => setTimeout(resolve, pollInterval));

        // Check if we received the passkey
        const passkey = this.mgr.getSessionPasskey(destinationNodeNum);
        if (passkey) {
          logger.debug(`✅ Session passkey received from remote node ${destinationNodeNum} after ${((i + 1) * pollInterval / 1000).toFixed(1)}s`);
          return passkey;
        }
      }

      logger.warn(`⚠️ No session passkey response received from remote node ${destinationNodeNum} after ${maxWaitTime / 1000}s`);
      return null;
    } catch (error) {
      logger.error(`❌ Error requesting session passkey from remote node ${destinationNodeNum}:`, error);
      throw error;
    }
  }

  /**
   * Request specific module config from the device
   * @param configType Module config type to request (0=MQTT_CONFIG, 9=NEIGHBORINFO_CONFIG, etc.)
   */
  async requestModuleConfig(configType: number): Promise<void> {
    if (!this.mgr.isTransportReady()) {
      throw new Error('Not connected to Meshtastic node');
    }

    try {
      logger.debug(`⚙️ Requesting module config type ${configType} from device`);
      const getModuleConfigMsg = protobufService.createGetModuleConfigRequest(configType);
      const adminPacket = protobufService.createAdminPacket(getModuleConfigMsg, this.mgr.getLocalNodeInfo()?.nodeNum || 0, this.mgr.getLocalNodeInfo()?.nodeNum);

      // Track the pending request so an empty (all-default) Proto3 response can be
      // mapped back to the right key in processAdminMessage. Keyed by the local
      // node number, matching how the response's `from` field is interpreted.
      const pendingKey = LOCAL_MODULE_CONFIG_TYPE_KEYS[configType];
      const localNodeNum = this.mgr.getLocalNodeInfo()?.nodeNum;
      if (pendingKey && localNodeNum) {
        this.mgr.setPendingModuleConfigRequest(localNodeNum, pendingKey);
      }

      await this.mgr.sendLocalAdminPacket(adminPacket);
      logger.debug(`⚙️ Sent get_module_config_request for config type ${configType}`);
    } catch (error) {
      logger.error('❌ Error requesting module config:', error);
      throw error;
    }
  }

  /**
   * Request config from a remote node
   * @param destinationNodeNum The remote node number
   * @param configType The config type to request (DEVICE_CONFIG=0, LORA_CONFIG=5, etc.)
   * @param isModuleConfig Whether this is a module config request (false for device configs)
   * @returns The config data if received, null otherwise
   */
  async requestRemoteConfig(destinationNodeNum: number, configType: number, isModuleConfig: boolean = false): Promise<any> {
    if (!this.mgr.isTransportReady()) {
      throw new Error('Not connected to Meshtastic node');
    }

    if (!this.mgr.getLocalNodeInfo()?.nodeNum) {
      throw new Error('Local node number not available');
    }

    try {
      // Get or request session passkey
      let sessionPasskey = this.mgr.getSessionPasskey(destinationNodeNum);
      if (sessionPasskey) {
        logger.debug(`🔑 Using cached session passkey for remote node ${destinationNodeNum}`);
      } else {
        logger.debug(`🔑 No cached passkey for remote node ${destinationNodeNum}, requesting new one...`);
        sessionPasskey = await this.requestRemoteSessionPasskey(destinationNodeNum);
        if (!sessionPasskey) {
          throw new Error(`Failed to obtain session passkey for remote node ${destinationNodeNum}`);
        }
      }

      // Create the config request message with session passkey
      const root = getProtobufRoot();
      if (!root) {
        throw new Error('Protobuf definitions not loaded. Please ensure protobuf definitions are initialized.');
      }
      const AdminMessage = root.lookupType('meshtastic.AdminMessage');
      if (!AdminMessage) {
        throw new Error('AdminMessage type not found');
      }

      const adminMsgData: any = {
        sessionPasskey: sessionPasskey
      };

      if (isModuleConfig) {
        adminMsgData.getModuleConfigRequest = configType;
      } else {
        adminMsgData.getConfigRequest = configType;
      }

      const adminMsg = AdminMessage.create(adminMsgData);
      const encoded = AdminMessage.encode(adminMsg).finish();

      // Clear any existing config for this type before requesting (to ensure fresh data)
      // This must happen BEFORE sending to prevent race conditions where responses arrive
      // and get immediately deleted, causing polling loops to timeout
      // Map config types to their keys
      if (isModuleConfig) {
        const moduleConfigMap: { [key: number]: string } = {
          0: 'mqtt',
          5: 'telemetry',
          9: 'neighborInfo',
          13: 'statusmessage',
          14: 'trafficManagement'
        };
        const configKey = moduleConfigMap[configType];
        if (configKey) {
          const nodeConfig = this.mgr.getRemoteNodeConfig(destinationNodeNum);
          if (nodeConfig?.moduleConfig) {
            delete nodeConfig.moduleConfig[configKey];
          }
        }
      } else {
        const deviceConfigMap: { [key: number]: string } = {
          0: 'device',
          1: 'position',  // POSITION_CONFIG (was incorrectly 6)
          5: 'lora',
          6: 'bluetooth',  // BLUETOOTH_CONFIG (for completeness)
          7: 'security'  // SECURITY_CONFIG
        };
        const configKey = deviceConfigMap[configType];
        if (configKey) {
          const nodeConfig = this.mgr.getRemoteNodeConfig(destinationNodeNum);
          if (nodeConfig?.deviceConfig) {
            delete nodeConfig.deviceConfig[configKey];
          }
        }
      }

      // Track pending module config request so empty Proto3 responses can be mapped
      if (isModuleConfig) {
        const moduleConfigMap: { [key: number]: string } = {
          0: 'mqtt', 5: 'telemetry', 9: 'neighborInfo',
          13: 'statusmessage', 14: 'trafficManagement'
        };
        const pendingKey = moduleConfigMap[configType];
        if (pendingKey) {
          this.mgr.setPendingModuleConfigRequest(destinationNodeNum, pendingKey);
        }
      }

      // Send the request
      const adminPacket = protobufService.createAdminPacket(encoded, destinationNodeNum, this.mgr.getLocalNodeInfo()!.nodeNum);
      await this.mgr.sendLocalAdminPacket(adminPacket);
      logger.debug(`📡 Requested ${isModuleConfig ? 'module' : 'device'} config type ${configType} from remote node ${destinationNodeNum}`);

      // Wait for the response (config responses can take time, especially over mesh)
      // Remote nodes may take longer due to mesh routing
      // Poll for the response up to 20 seconds (increased from 10s for multi-hop mesh)
      const maxWaitTime = 20000; // 20 seconds
      const pollInterval = 250; // Check every 250ms
      const maxPolls = maxWaitTime / pollInterval;

      for (let i = 0; i < maxPolls; i++) {
        await new Promise(resolve => setTimeout(resolve, pollInterval));

        // Check if we have the config for this remote node
        const nodeConfig = this.mgr.getRemoteNodeConfig(destinationNodeNum);
        if (nodeConfig) {
          if (isModuleConfig) {
            // Map module config types to their keys
            const moduleConfigMap: { [key: number]: string } = {
              0: 'mqtt',
              5: 'telemetry',
              9: 'neighborInfo',
              13: 'statusmessage',
              14: 'trafficManagement'
            };
            const configKey = moduleConfigMap[configType];
            if (configKey && nodeConfig.moduleConfig?.[configKey]) {
              logger.debug(`✅ Received ${configKey} config from remote node ${destinationNodeNum}`);
              return nodeConfig.moduleConfig[configKey];
            }
          } else {
            // Map device config types to their keys
            const deviceConfigMap: { [key: number]: string } = {
              0: 'device',
              1: 'position',  // POSITION_CONFIG
              2: 'power',     // POWER_CONFIG
              3: 'network',   // NETWORK_CONFIG
              4: 'display',   // DISPLAY_CONFIG
              5: 'lora',      // LORA_CONFIG
              6: 'bluetooth', // BLUETOOTH_CONFIG
              7: 'security'   // SECURITY_CONFIG
            };
            const configKey = deviceConfigMap[configType];
            if (configKey && nodeConfig.deviceConfig?.[configKey]) {
              logger.debug(`✅ Received ${configKey} config from remote node ${destinationNodeNum}`);
              return nodeConfig.deviceConfig[configKey];
            }
          }
        }
      }

      logger.warn(`⚠️ Config type ${configType} not found in response from remote node ${destinationNodeNum} after waiting ${maxWaitTime}ms`);
      return null;
    } catch (error) {
      logger.error(`❌ Error requesting config from remote node ${destinationNodeNum}:`, error);
      throw error;
    }
  }

  /**
   * Request a specific channel from a remote node
   * @param destinationNodeNum The remote node number
   * @param channelIndex The channel index (0-7)
   * @returns The channel data if received, null otherwise
   */
  async requestRemoteChannel(destinationNodeNum: number, channelIndex: number): Promise<any> {
    if (!this.mgr.isTransportReady()) {
      throw new Error('Not connected to Meshtastic node');
    }

    if (!this.mgr.getLocalNodeInfo()?.nodeNum) {
      throw new Error('Local node number not available');
    }

    try {
      // Get or request session passkey
      let sessionPasskey = this.mgr.getSessionPasskey(destinationNodeNum);
      if (sessionPasskey) {
        logger.debug(`🔑 Using cached session passkey for remote node ${destinationNodeNum}`);
      } else {
        logger.debug(`🔑 No cached passkey for remote node ${destinationNodeNum}, requesting new one...`);
        sessionPasskey = await this.requestRemoteSessionPasskey(destinationNodeNum);
        if (!sessionPasskey) {
          throw new Error(`Failed to obtain session passkey for remote node ${destinationNodeNum}`);
        }
      }

      // Create the channel request message with session passkey
      // Note: getChannelRequest uses channelIndex + 1 (per protobuf spec)
      const root = getProtobufRoot();
      if (!root) {
        throw new Error('Protobuf definitions not loaded. Please ensure protobuf definitions are initialized.');
      }
      const AdminMessage = root.lookupType('meshtastic.AdminMessage');
      if (!AdminMessage) {
        throw new Error('AdminMessage type not found');
      }

      const adminMsg = AdminMessage.create({
        sessionPasskey: sessionPasskey,
        getChannelRequest: channelIndex + 1  // Protobuf uses index + 1
      });
      const encoded = AdminMessage.encode(adminMsg).finish();

      // Clear any existing channel for this index before requesting (to ensure fresh data)
      // This must happen BEFORE sending to prevent race conditions where responses arrive
      // and get immediately deleted, causing polling loops to timeout
      const nodeChannels = this.mgr.getRemoteNodeChannelsMap(destinationNodeNum);
      if (nodeChannels) {
        nodeChannels.delete(channelIndex);
      }

      // Send the request
      const adminPacket = protobufService.createAdminPacket(encoded, destinationNodeNum, this.mgr.getLocalNodeInfo()!.nodeNum);
      await this.mgr.sendLocalAdminPacket(adminPacket);
      logger.debug(`📡 Requested channel ${channelIndex} from remote node ${destinationNodeNum}`);

      // Wait for the response
      // Use longer timeout for mesh routing - responses can take longer over mesh
      // Increased from 8s to 16s for multi-hop mesh routing
      const maxWaitTime = 16000; // 16 seconds
      const pollInterval = 300; // Check every 300ms
      const maxPolls = maxWaitTime / pollInterval;

      for (let i = 0; i < maxPolls; i++) {
        await new Promise(resolve => setTimeout(resolve, pollInterval));

        // Check if we have the channel for this remote node
        const nodeChannelsCheck = this.mgr.getRemoteNodeChannelsMap(destinationNodeNum);
        if (nodeChannelsCheck && nodeChannelsCheck.has(channelIndex)) {
          const channel = nodeChannelsCheck.get(channelIndex);
          logger.debug(`✅ Received channel ${channelIndex} from remote node ${destinationNodeNum}`, {
            hasSettings: !!channel.settings,
            name: channel.settings?.name,
            role: channel.role
          });
          return channel;
        }
      }

      logger.warn(`⚠️ Channel ${channelIndex} not found in response from remote node ${destinationNodeNum} after waiting ${maxWaitTime}ms`);
      // Log what channels we did receive for debugging
      const receivedChannels = this.mgr.getRemoteNodeChannelsMap(destinationNodeNum);
      if (receivedChannels) {
        logger.debug(`📊 Received channels for node ${destinationNodeNum}:`, Array.from(receivedChannels.keys()));
      }
      return null;
    } catch (error) {
      logger.error(`❌ Error requesting channel from remote node ${destinationNodeNum}:`, error);
      throw error;
    }
  }

  /**
   * Request owner information from a remote node
   * @param destinationNodeNum The remote node number
   * @returns The owner data if received, null otherwise
   */
  async requestRemoteOwner(destinationNodeNum: number): Promise<any> {
    if (!this.mgr.isTransportReady()) {
      throw new Error('Not connected to Meshtastic node');
    }

    if (!this.mgr.getLocalNodeInfo()?.nodeNum) {
      throw new Error('Local node number not available');
    }

    try {
      // Get or request session passkey
      let sessionPasskey = this.mgr.getSessionPasskey(destinationNodeNum);
      if (sessionPasskey) {
        logger.debug(`🔑 Using cached session passkey for remote node ${destinationNodeNum}`);
      } else {
        logger.debug(`🔑 No cached passkey for remote node ${destinationNodeNum}, requesting new one...`);
        sessionPasskey = await this.requestRemoteSessionPasskey(destinationNodeNum);
        if (!sessionPasskey) {
          throw new Error(`Failed to obtain session passkey for remote node ${destinationNodeNum}`);
        }
      }

      // Create the owner request message with session passkey
      const root = getProtobufRoot();
      if (!root) {
        throw new Error('Protobuf definitions not loaded. Please ensure protobuf definitions are initialized.');
      }
      const AdminMessage = root.lookupType('meshtastic.AdminMessage');
      if (!AdminMessage) {
        throw new Error('AdminMessage type not found');
      }

      const adminMsg = AdminMessage.create({
        sessionPasskey: sessionPasskey,
        getOwnerRequest: true  // getOwnerRequest is a bool
      });
      const encoded = AdminMessage.encode(adminMsg).finish();

      // Clear any existing owner for this node before requesting (to ensure fresh data)
      // This must happen BEFORE sending to prevent race conditions where responses arrive
      // and get immediately deleted, causing polling loops to timeout
      this.mgr.getRemoteNodeOwnersMap().delete(destinationNodeNum);

      // Send the request
      const adminPacket = protobufService.createAdminPacket(encoded, destinationNodeNum, this.mgr.getLocalNodeInfo()!.nodeNum);
      await this.mgr.sendLocalAdminPacket(adminPacket);
      logger.debug(`📡 Requested owner info from remote node ${destinationNodeNum}`);

      // Wait for the response
      // Increased from 3s to 10s for multi-hop mesh routing
      const maxWaitTime = 10000; // 10 seconds
      const pollInterval = 250; // Check every 250ms
      const maxPolls = maxWaitTime / pollInterval;

      for (let i = 0; i < maxPolls; i++) {
        await new Promise(resolve => setTimeout(resolve, pollInterval));

        // Check if we have the owner for this remote node
        const ownersMap = this.mgr.getRemoteNodeOwnersMap();
        if (ownersMap.has(destinationNodeNum)) {
          const owner = ownersMap.get(destinationNodeNum);
          logger.debug(`✅ Received owner info from remote node ${destinationNodeNum}`);
          return owner;
        }
      }

      logger.warn(`⚠️ Owner info not found in response from remote node ${destinationNodeNum} after waiting ${maxWaitTime / 1000}s`);
      return null;
    } catch (error) {
      logger.error(`❌ Error requesting owner info from remote node ${destinationNodeNum}:`, error);
      throw error;
    }
  }

  /**
   * Request device metadata from a remote node
   * Returns firmware version, hardware model, capabilities, role, etc.
   */
  async requestRemoteDeviceMetadata(destinationNodeNum: number): Promise<any> {
    if (!this.mgr.isTransportReady()) {
      throw new Error('Not connected to Meshtastic node');
    }

    if (!this.mgr.getLocalNodeInfo()?.nodeNum) {
      throw new Error('Local node number not available');
    }

    try {
      // Get or request session passkey
      let sessionPasskey = this.mgr.getSessionPasskey(destinationNodeNum);
      if (sessionPasskey) {
        logger.debug(`🔑 Using cached session passkey for remote node ${destinationNodeNum}`);
      } else {
        logger.debug(`🔑 No cached passkey for remote node ${destinationNodeNum}, requesting new one...`);
        sessionPasskey = await this.requestRemoteSessionPasskey(destinationNodeNum);
        if (!sessionPasskey) {
          throw new Error(`Failed to obtain session passkey for remote node ${destinationNodeNum}`);
        }
      }

      // Create the device metadata request message with session passkey
      const root = getProtobufRoot();
      if (!root) {
        throw new Error('Protobuf definitions not loaded. Please ensure protobuf definitions are initialized.');
      }
      const AdminMessage = root.lookupType('meshtastic.AdminMessage');
      if (!AdminMessage) {
        throw new Error('AdminMessage type not found');
      }

      const adminMsg = AdminMessage.create({
        sessionPasskey: sessionPasskey,
        getDeviceMetadataRequest: true
      });
      const encoded = AdminMessage.encode(adminMsg).finish();

      // Clear any existing metadata for this node before requesting (to ensure fresh data)
      this.mgr.getRemoteNodeDeviceMetadataMap().delete(destinationNodeNum);

      // Send the request
      const adminPacket = protobufService.createAdminPacket(encoded, destinationNodeNum, this.mgr.getLocalNodeInfo()!.nodeNum);
      await this.mgr.sendLocalAdminPacket(adminPacket);
      logger.debug(`📡 Requested device metadata from remote node ${destinationNodeNum}`);

      // Wait for the response
      const maxWaitTime = 10000; // 10 seconds
      const pollInterval = 250; // Check every 250ms
      const maxPolls = maxWaitTime / pollInterval;

      for (let i = 0; i < maxPolls; i++) {
        await new Promise(resolve => setTimeout(resolve, pollInterval));

        // Check if we have the device metadata for this remote node
        const metadataMap = this.mgr.getRemoteNodeDeviceMetadataMap();
        if (metadataMap.has(destinationNodeNum)) {
          const metadata = metadataMap.get(destinationNodeNum);
          logger.debug(`✅ Received device metadata from remote node ${destinationNodeNum}`);
          return metadata;
        }
      }

      logger.warn(`⚠️ Device metadata not received from remote node ${destinationNodeNum} after waiting ${maxWaitTime / 1000}s`);
      return null;
    } catch (error) {
      logger.error(`❌ Error requesting device metadata from remote node ${destinationNodeNum}:`, error);
      throw error;
    }
  }

  /**
   * Send reboot command to a node (local or remote)
   * @param destinationNodeNum The target node number (0 or local node num for local)
   * @param seconds Number of seconds before reboot (default: 5, use negative to cancel)
   */
  async sendRebootCommand(destinationNodeNum: number, seconds: number = 10): Promise<void> {
    if (!this.mgr.isTransportReady()) {
      throw new Error('Not connected to Meshtastic node');
    }

    if (!this.mgr.getLocalNodeInfo()?.nodeNum) {
      throw new Error('Local node number not available');
    }

    const localNodeNum = this.mgr.getLocalNodeInfo()!.nodeNum;
    const isLocalNode = destinationNodeNum === 0 || destinationNodeNum === localNodeNum;

    try {
      const root = getProtobufRoot();
      if (!root) {
        throw new Error('Protobuf definitions not loaded. Please ensure protobuf definitions are initialized.');
      }
      const AdminMessage = root.lookupType('meshtastic.AdminMessage');
      if (!AdminMessage) {
        throw new Error('AdminMessage type not found');
      }

      let sessionPasskey: Uint8Array | null = null;

      // For remote nodes, get the session passkey
      if (!isLocalNode) {
        sessionPasskey = this.mgr.getSessionPasskey(destinationNodeNum);
        if (!sessionPasskey) {
          logger.debug(`🔑 No cached passkey for remote node ${destinationNodeNum}, requesting new one...`);
          sessionPasskey = await this.requestRemoteSessionPasskey(destinationNodeNum);
          if (!sessionPasskey) {
            throw new Error(`Failed to obtain session passkey for remote node ${destinationNodeNum}`);
          }
        }
      }

      const adminMsg = AdminMessage.create({
        ...(sessionPasskey && { sessionPasskey }),
        rebootSeconds: seconds
      });
      const encoded = AdminMessage.encode(adminMsg).finish();

      const targetNodeNum = isLocalNode ? localNodeNum : destinationNodeNum;
      const adminPacket = protobufService.createAdminPacket(encoded, targetNodeNum, localNodeNum);
      await this.mgr.sendLocalAdminPacket(adminPacket);

      logger.info(`🔄 Sent reboot command to node ${targetNodeNum} (reboot in ${seconds} seconds)`);
    } catch (error) {
      logger.error(`❌ Error sending reboot command to node ${destinationNodeNum}:`, error);
      throw error;
    }
  }

  /**
   * Send set time command to a node (local or remote)
   * Sets the node's time to the current server time
   * @param destinationNodeNum The target node number (0 or local node num for local)
   */
  async sendSetTimeCommand(destinationNodeNum: number): Promise<void> {
    if (!this.mgr.isTransportReady()) {
      throw new Error('Not connected to Meshtastic node');
    }

    if (!this.mgr.getLocalNodeInfo()?.nodeNum) {
      throw new Error('Local node number not available');
    }

    const localNodeNum = this.mgr.getLocalNodeInfo()!.nodeNum;
    const isLocalNode = destinationNodeNum === 0 || destinationNodeNum === localNodeNum;

    try {
      const root = getProtobufRoot();
      if (!root) {
        throw new Error('Protobuf definitions not loaded. Please ensure protobuf definitions are initialized.');
      }
      const AdminMessage = root.lookupType('meshtastic.AdminMessage');
      if (!AdminMessage) {
        throw new Error('AdminMessage type not found');
      }

      let sessionPasskey: Uint8Array | null = null;

      // For remote nodes, get the session passkey
      if (!isLocalNode) {
        sessionPasskey = this.mgr.getSessionPasskey(destinationNodeNum);
        if (!sessionPasskey) {
          logger.debug(`🔑 No cached passkey for remote node ${destinationNodeNum}, requesting new one...`);
          sessionPasskey = await this.requestRemoteSessionPasskey(destinationNodeNum);
          if (!sessionPasskey) {
            throw new Error(`Failed to obtain session passkey for remote node ${destinationNodeNum}`);
          }
        }
      }

      // Get current Unix timestamp
      const currentTime = Math.floor(Date.now() / 1000);

      const adminMsg = AdminMessage.create({
        ...(sessionPasskey && { sessionPasskey }),
        setTimeOnly: currentTime
      });
      const encoded = AdminMessage.encode(adminMsg).finish();

      const targetNodeNum = isLocalNode ? localNodeNum : destinationNodeNum;
      const adminPacket = protobufService.createAdminPacket(encoded, targetNodeNum, localNodeNum);
      await this.mgr.sendLocalAdminPacket(adminPacket);

      logger.debug(`🕐 Sent set time command to node ${targetNodeNum} (time: ${currentTime} / ${new Date(currentTime * 1000).toISOString()})`);
    } catch (error) {
      logger.error(`❌ Error sending set time command to node ${destinationNodeNum}:`, error);
      throw error;
    }
  }

  /**
   * Request all module configurations from the device for complete backup
   * This requests all 13 module config types defined in the protobufs
   */
  async requestAllModuleConfigs(): Promise<void> {
    if (!this.mgr.isTransportReady()) {
      throw new Error('Not connected to Meshtastic node');
    }

    // All module config types from admin.proto ModuleConfigType enum
    const moduleConfigTypes = [
      0,  // MQTT_CONFIG
      1,  // SERIAL_CONFIG
      2,  // EXTNOTIF_CONFIG
      3,  // STOREFORWARD_CONFIG
      4,  // RANGETEST_CONFIG
      5,  // TELEMETRY_CONFIG
      6,  // CANNEDMSG_CONFIG
      7,  // AUDIO_CONFIG
      8,  // REMOTEHARDWARE_CONFIG
      9,  // NEIGHBORINFO_CONFIG
      10, // AMBIENTLIGHTING_CONFIG
      11, // DETECTIONSENSOR_CONFIG
      12, // PAXCOUNTER_CONFIG
      13, // STATUSMESSAGE_CONFIG
      14  // TRAFFICMANAGEMENT_CONFIG
    ];

    logger.debug('📦 Requesting all module configs for complete backup...');

    for (const configType of moduleConfigTypes) {
      // Abort early if we lost the connection mid-fetch (#3637). Propagating
      // the error prevents the caller from setting moduleConfigsEverFetched=true,
      // so the fetch is retried on the next reconnection rather than silently
      // skipped forever.
      if (!this.mgr.isTransportReady()) {
        logger.warn(`⚠️ Connection lost during module config fetch — aborting at type ${configType}, will retry on reconnect`);
        throw new Error('Not connected to Meshtastic node');
      }
      try {
        await this.requestModuleConfig(configType);
        // Configurable delay between requests to avoid overwhelming the device
        await new Promise(resolve => setTimeout(resolve, getEnvironmentConfig().meshtasticModuleConfigDelayMs));
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        if (errMsg === 'Not connected to Meshtastic node') {
          // Connectivity loss mid-send: propagate so caller doesn't mark fetch complete (#3637)
          logger.warn(`⚠️ Lost connection during module config fetch at type ${configType} — aborting, will retry on reconnect`);
          throw error;
        }
        logger.error(`❌ Failed to request module config type ${configType}:`, error);
        // Continue with other configs even if one type fails for non-connectivity reasons
      }
    }

    logger.debug('✅ All module config requests sent');
  }

  /**
   * Reset module config cache so the next connect() will re-fetch all configs.
   * Called after OTA firmware updates to ensure fresh config data.
   */
  resetModuleConfigCache(): void {
    this.mgr.resetModuleConfigState();
    logger.debug('📦 Module config cache reset — will re-fetch on next connect');
  }

  /**
   * Force refresh of module configs (resets the cache flag and re-fetches).
   * Useful for Configuration tab refresh button or API use.
   */
  async refreshModuleConfigs(): Promise<void> {
    this.mgr.resetModuleConfigState();
    logger.debug('📦 Force-refreshing module configs...');
    await this.requestAllModuleConfigs();
    this.mgr.setModuleConfigsEverFetched(true);
  }
}
