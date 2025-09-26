import { useState, useEffect } from 'react'
import './App.css'

interface DeviceInfo {
  nodeNum: number;
  user?: {
    id: string;
    longName: string;
    shortName: string;
    hwModel?: number;
  };
  position?: {
    latitude: number;
    longitude: number;
    altitude?: number;
  };
  deviceMetrics?: {
    batteryLevel?: number;
    voltage?: number;
    channelUtilization?: number;
    airUtilTx?: number;
  };
  lastHeard?: number;
  snr?: number;
  rssi?: number;
}

interface MeshMessage {
  id: string;
  from: string;
  to: string;
  text: string;
  channel: number;
  portnum?: number;
  timestamp: Date;
  acknowledged?: boolean;
  isLocalMessage?: boolean;
}

interface Channel {
  id: number;
  name: string;
  psk?: string;
  uplinkEnabled: boolean;
  downlinkEnabled: boolean;
  createdAt: number;
  updatedAt: number;
}

type TabType = 'nodes' | 'channels' | 'messages' | 'info' | 'settings';

type SortField = 'longName' | 'shortName' | 'id' | 'lastHeard' | 'snr' | 'battery' | 'hwModel' | 'location';
type SortDirection = 'asc' | 'desc';

function App() {
  const [activeTab, setActiveTab] = useState<TabType>('nodes')
  const [nodes, setNodes] = useState<DeviceInfo[]>([])
  const [channels, setChannels] = useState<Channel[]>([])
  const [connectionStatus, setConnectionStatus] = useState<'disconnected' | 'connecting' | 'connected'>('disconnected')
  const [messages, setMessages] = useState<MeshMessage[]>([])
  const [selectedDMNode, setSelectedDMNode] = useState<string>('')
  const [channelMessages, setChannelMessages] = useState<{[key: number]: MeshMessage[]}>({})
  const [selectedChannel, setSelectedChannel] = useState<number>(0)
  const [newMessage, setNewMessage] = useState<string>('')
  const [error, setError] = useState<string | null>(null)
  const [nodeAddress, setNodeAddress] = useState<string>('Loading...')
  const [deviceInfo, setDeviceInfo] = useState<any>(null)
  const [deviceConfig, setDeviceConfig] = useState<any>(null)
  const [currentNodeId, setCurrentNodeId] = useState<string>('')
  const [pendingMessages, setPendingMessages] = useState<Map<string, MeshMessage>>(new Map())

  // New state for node list features
  const [nodeFilter, setNodeFilter] = useState<string>('')
  const [sortField, setSortField] = useState<SortField>('longName')
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc')

  // Load configuration and check connection status on startup
  useEffect(() => {
    const initializeApp = async () => {
      try {
        // Load configuration from server
        const configResponse = await fetch('/api/config');
        if (configResponse.ok) {
          const config = await configResponse.json();
          setNodeAddress(config.meshtasticNodeIp);
        } else {
          setNodeAddress('192.168.1.100');
        }

        // Check connection status
        await checkConnectionStatus();
      } catch (error) {
        setNodeAddress('192.168.1.100');
        setError('Failed to load configuration');
      }
    };

    initializeApp();
  }, []);

  useEffect(() => {
    const updateInterval = setInterval(() => {
      if (connectionStatus === 'connected') {
        updateDataFromBackend();
      } else {
        checkConnectionStatus();
      }
    }, 2000);

    return () => clearInterval(updateInterval);
  }, [connectionStatus]);

  const checkConnectionStatus = async () => {
    try {
      const response = await fetch('/api/connection');
      if (response.ok) {
        const status = await response.json();
        if (status.connected) {
          setConnectionStatus('connected');
          setError(null);
          await updateDataFromBackend();
        } else {
          setConnectionStatus('disconnected');
          setError(`Cannot connect to Meshtastic node at ${nodeAddress}. Please ensure the node is reachable and has HTTP API enabled.`);
        }
      } else {
        setConnectionStatus('disconnected');
        setError('Failed to get connection status from server');
      }
    } catch (err) {
      setConnectionStatus('disconnected');
      const errorMessage = err instanceof Error ? err.message : 'Unknown error';
      setError(`Server connection error: ${errorMessage}`);
    }
  };

  const updateDataFromBackend = async () => {
    try {
      // Fetch nodes
      const nodesResponse = await fetch('/api/nodes');
      if (nodesResponse.ok) {
        const nodesData = await nodesResponse.json();
        setNodes(nodesData);
      }

      // Fetch channels
      const channelsResponse = await fetch('/api/channels');
      if (channelsResponse.ok) {
        const channelsData = await channelsResponse.json();
        setChannels(channelsData);
      }

      // Fetch messages
      const messagesResponse = await fetch('/api/messages?limit=100');
      if (messagesResponse.ok) {
        const messagesData = await messagesResponse.json();
        // Convert timestamp strings back to Date objects
        const processedMessages = messagesData.map((msg: any) => ({
          ...msg,
          timestamp: new Date(msg.timestamp)
        }));
        setMessages(processedMessages);

        // Group messages by channel
        const channelGroups: {[key: number]: MeshMessage[]} = {};
        processedMessages.forEach((msg: MeshMessage) => {
          if (!channelGroups[msg.channel]) {
            channelGroups[msg.channel] = [];
          }
          channelGroups[msg.channel].push(msg);
        });
        setChannelMessages(channelGroups);

        // Check for message acknowledgments
        if (pendingMessages.size > 0) {
          const updatedPending = new Map(pendingMessages);
          let hasUpdates = false;

          // For each pending message, check if a matching message appears in recent messages
          // Match by text content, channel, and approximate timestamp (within 30 seconds)
          updatedPending.forEach((pendingMsg, tempId) => {
            const matchingMessage = processedMessages.find((msg: MeshMessage) =>
              msg.text === pendingMsg.text &&
              msg.channel === pendingMsg.channel &&
              Math.abs(msg.timestamp.getTime() - pendingMsg.timestamp.getTime()) < 30000 &&
              msg.from === currentNodeId
            );

            if (matchingMessage) {
              // Found a matching message from server, so this message was acknowledged
              updatedPending.delete(tempId);
              hasUpdates = true;

              // Update the messages list to replace the temporary message with the server one
              setMessages(prev => prev.map(m => m.id === tempId ? matchingMessage : m));
              setChannelMessages(prev => ({
                ...prev,
                [pendingMsg.channel]: prev[pendingMsg.channel]?.map(m => m.id === tempId ? matchingMessage : m) || []
              }));
            }
          });

          if (hasUpdates) {
            setPendingMessages(updatedPending);
          }
        }
      }

      // Fetch device info
      const configResponse = await fetch('/api/config');
      if (configResponse.ok) {
        const configData = await configResponse.json();
        setDeviceInfo(configData);
      }

      // Fetch device configuration
      const deviceConfigResponse = await fetch('/api/device-config');
      if (deviceConfigResponse.ok) {
        const deviceConfigData = await deviceConfigResponse.json();
        setDeviceConfig(deviceConfigData);

        // Extract current node ID from device config
        if (deviceConfigData.basic?.nodeId) {
          setCurrentNodeId(deviceConfigData.basic.nodeId);
        }
      }
    } catch (error) {
      console.error('Failed to update data from backend:', error);
    }
  };

  const handleSendMessage = async (channel: number = 0) => {
    if (!newMessage.trim() || connectionStatus !== 'connected') {
      return;
    }

    // Create a temporary message ID for immediate display
    const tempId = `temp_${Date.now()}_${Math.random()}`;
    const sentMessage: MeshMessage = {
      id: tempId,
      from: currentNodeId || 'me',
      to: '!ffffffff', // Broadcast
      text: newMessage,
      channel: channel,
      timestamp: new Date(),
      isLocalMessage: true,
      acknowledged: false
    };

    // Add message to local state immediately
    setMessages(prev => [...prev, sentMessage]);
    setChannelMessages(prev => ({
      ...prev,
      [channel]: [...(prev[channel] || []), sentMessage]
    }));

    // Add to pending acknowledgments
    setPendingMessages(prev => new Map(prev).set(tempId, sentMessage));

    // Clear the input
    const messageText = newMessage;
    setNewMessage('');

    try {
      const response = await fetch('/api/messages/send', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          text: messageText,
          channel: channel
        })
      });

      if (response.ok) {
        // The message was sent successfully
        // We'll wait for it to appear in the backend data to confirm acknowledgment
        setTimeout(() => updateDataFromBackend(), 1000);
      } else {
        const errorData = await response.json();
        setError(`Failed to send message: ${errorData.error}`);

        // Remove the message from local state if sending failed
        setMessages(prev => prev.filter(msg => msg.id !== tempId));
        setChannelMessages(prev => ({
          ...prev,
          [channel]: prev[channel]?.filter(msg => msg.id !== tempId) || []
        }));
        setPendingMessages(prev => {
          const updated = new Map(prev);
          updated.delete(tempId);
          return updated;
        });
      }
    } catch (err) {
      setError(`Failed to send message: ${err instanceof Error ? err.message : 'Unknown error'}`);

      // Remove the message from local state if sending failed
      setMessages(prev => prev.filter(msg => msg.id !== tempId));
      setChannelMessages(prev => ({
        ...prev,
        [channel]: prev[channel]?.filter(msg => msg.id !== tempId) || []
      }));
      setPendingMessages(prev => {
        const updated = new Map(prev);
        updated.delete(tempId);
        return updated;
      });
    }
  };

  const formatHardwareModel = (model?: number): string => {
    if (!model) return 'Unknown';
    const models: Record<number, string> = {
      1: 'TLORA_V2',
      2: 'TLORA_V1',
      3: 'TLORA_V2_1_1P6',
      4: 'TBEAM',
      5: 'HELTEC_V2_0',
      6: 'TBEAM_V0P7',
      7: 'T_ECHO',
      8: 'TLORA_V1_1P3',
      9: 'RAK4631',
      10: 'HELTEC_V2_1',
      11: 'HELTEC_V1',
      12: 'LILYGO_TBEAM_S3_CORE',
      13: 'RAK11200',
      14: 'NANO_G1',
      15: 'STATION_G1',
      39: 'DIY_V1',
      43: 'HELTEC_V3',
    };
    return models[model] || `Model ${model}`;
  };

  const getNodeName = (nodeId: string): string => {
    const node = nodes.find(n => n.user?.id === nodeId);
    return node?.user?.longName || node?.user?.shortName || nodeId;
  };

  const getNodeShortName = (nodeId: string): string => {
    const node = nodes.find(n => n.user?.id === nodeId);
    // Prefer the actual shortName field, fallback to truncated ID only if shortName is empty/null
    return (node?.user?.shortName && node.user.shortName.trim()) || nodeId.substring(1, 5);
  };

  const isMyMessage = (msg: MeshMessage): boolean => {
    return msg.from === currentNodeId || (msg.isLocalMessage === true);
  };

  const getChannelName = (channelNum: number): string => {
    // Look for a channel configuration with this ID
    const channel = channels.find(ch => ch.id === channelNum);
    if (channel) {
      return channel.name;
    }

    // Fallback to generic channel names
    if (channelNum === 0) return 'Primary';
    return `Channel ${channelNum}`;
  };

  const getAvailableChannels = (): number[] => {
    const channelSet = new Set<number>();

    // Add channels from messages (if any)
    messages.forEach(msg => channelSet.add(msg.channel));

    // Add channels from channel configurations (use their IDs)
    channels.forEach(ch => channelSet.add(ch.id));

    // If no channels are available, add Primary (0) as fallback
    if (channelSet.size === 0) {
      channelSet.add(0);
    }

    return Array.from(channelSet).sort((a, b) => a - b);
  };

  const getDMMessages = (nodeId: string): MeshMessage[] => {
    return messages.filter(msg =>
      (msg.from === nodeId || msg.to === nodeId) &&
      msg.to !== '!ffffffff' // Exclude broadcasts
    );
  };

  // Helper function to sort nodes
  const sortNodes = (nodes: DeviceInfo[], field: SortField, direction: SortDirection): DeviceInfo[] => {
    return [...nodes].sort((a, b) => {
      let aVal: any, bVal: any;

      switch (field) {
        case 'longName':
          aVal = a.user?.longName || `Node ${a.nodeNum}`;
          bVal = b.user?.longName || `Node ${b.nodeNum}`;
          break;
        case 'shortName':
          aVal = a.user?.shortName || '';
          bVal = b.user?.shortName || '';
          break;
        case 'id':
          aVal = a.user?.id || a.nodeNum;
          bVal = b.user?.id || b.nodeNum;
          break;
        case 'lastHeard':
          aVal = a.lastHeard || 0;
          bVal = b.lastHeard || 0;
          break;
        case 'snr':
          aVal = a.snr || -999;
          bVal = b.snr || -999;
          break;
        case 'battery':
          aVal = a.deviceMetrics?.batteryLevel || -1;
          bVal = b.deviceMetrics?.batteryLevel || -1;
          break;
        case 'hwModel':
          aVal = a.user?.hwModel || 0;
          bVal = b.user?.hwModel || 0;
          break;
        case 'location':
          aVal = a.position ? `${a.position.latitude},${a.position.longitude}` : '';
          bVal = b.position ? `${b.position.latitude},${b.position.longitude}` : '';
          break;
        default:
          return 0;
      }

      if (typeof aVal === 'string' && typeof bVal === 'string') {
        const comparison = aVal.toLowerCase().localeCompare(bVal.toLowerCase());
        return direction === 'asc' ? comparison : -comparison;
      } else {
        const comparison = aVal < bVal ? -1 : aVal > bVal ? 1 : 0;
        return direction === 'asc' ? comparison : -comparison;
      }
    });
  };

  // Helper function to filter nodes
  const filterNodes = (nodes: DeviceInfo[], filter: string): DeviceInfo[] => {
    if (!filter.trim()) return nodes;

    const lowerFilter = filter.toLowerCase();
    return nodes.filter(node => {
      const longName = (node.user?.longName || '').toLowerCase();
      const shortName = (node.user?.shortName || '').toLowerCase();
      const id = (node.user?.id || '').toLowerCase();

      return longName.includes(lowerFilter) ||
             shortName.includes(lowerFilter) ||
             id.includes(lowerFilter);
    });
  };

  // Handle column header click for sorting
  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDirection('asc');
    }
  };

  // Get processed (filtered and sorted) nodes
  const getProcessedNodes = (): DeviceInfo[] => {
    const filtered = filterNodes(nodes, nodeFilter);
    return sortNodes(filtered, sortField, sortDirection);
  };

  const renderNodesTab = () => {
    const processedNodes = getProcessedNodes();

    return (
      <div className="tab-content">
        <h2>Mesh Nodes ({processedNodes.length}{nodeFilter ? ` of ${nodes.length}` : ''})</h2>

        {/* Filter input */}
        <div className="node-filter">
          <input
            type="text"
            placeholder="Filter nodes by name or ID..."
            value={nodeFilter}
            onChange={(e) => setNodeFilter(e.target.value)}
            className="filter-input"
          />
        </div>

        {connectionStatus === 'connected' ? (
          processedNodes.length > 0 ? (
            <div className="nodes-table">
              <table>
                <thead>
                  <tr>
                    <th className="sortable" onClick={() => handleSort('longName')}>
                      Node {sortField === 'longName' && (sortDirection === 'asc' ? '↑' : '↓')}
                    </th>
                    <th className="sortable" onClick={() => handleSort('shortName')}>
                      Short Name {sortField === 'shortName' && (sortDirection === 'asc' ? '↑' : '↓')}
                    </th>
                    <th className="sortable" onClick={() => handleSort('id')}>
                      ID {sortField === 'id' && (sortDirection === 'asc' ? '↑' : '↓')}
                    </th>
                    <th className="sortable" onClick={() => handleSort('lastHeard')}>
                      Last Seen {sortField === 'lastHeard' && (sortDirection === 'asc' ? '↑' : '↓')}
                    </th>
                    <th className="sortable" onClick={() => handleSort('snr')}>
                      SNR {sortField === 'snr' && (sortDirection === 'asc' ? '↑' : '↓')}
                    </th>
                    <th className="sortable" onClick={() => handleSort('battery')}>
                      Battery {sortField === 'battery' && (sortDirection === 'asc' ? '↑' : '↓')}
                    </th>
                    <th className="sortable" onClick={() => handleSort('hwModel')}>
                      Hardware {sortField === 'hwModel' && (sortDirection === 'asc' ? '↑' : '↓')}
                    </th>
                    <th className="sortable" onClick={() => handleSort('location')}>
                      Location {sortField === 'location' && (sortDirection === 'asc' ? '↑' : '↓')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {processedNodes.map(node => (
                    <tr key={node.nodeNum}>
                      <td>{node.user?.longName || `Node ${node.nodeNum}`}</td>
                      <td>{node.user?.shortName || '-'}</td>
                      <td>{node.user?.id || node.nodeNum}</td>
                      <td>
                        {node.lastHeard ? new Date(node.lastHeard * 1000).toLocaleString() : 'Never'}
                      </td>
                      <td>{node.snr !== undefined ? `${node.snr} dB` : '-'}</td>
                      <td>{node.deviceMetrics?.batteryLevel !== undefined ? `${node.deviceMetrics.batteryLevel}%` : '-'}</td>
                      <td>{node.user?.hwModel ? formatHardwareModel(node.user.hwModel) : '-'}</td>
                      <td>
                        {node.position ?
                          `${node.position.latitude.toFixed(4)}, ${node.position.longitude.toFixed(4)}` :
                          '-'
                        }
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="no-data">
              {nodeFilter ? 'No nodes match the current filter.' : 'No nodes detected yet. Waiting for mesh updates...'}
            </p>
          )
        ) : (
          <p className="no-data">Connect to a Meshtastic node to view mesh network</p>
        )}
      </div>
    );
  };

  const renderChannelsTab = () => (
    <div className="tab-content">
      <h2>Channels ({channels.length})</h2>
      {connectionStatus === 'connected' ? (
        channels.length > 0 ? (
          <>
            {/* Channel Buttons */}
            <div className="channels-grid">
              {channels.map(channel => (
                <button
                  key={channel.id}
                  className={`channel-button ${selectedChannel === channel.id ? 'selected' : ''}`}
                  onClick={() => setSelectedChannel(channel.id)}
                >
                  <div className="channel-button-header">
                    <span className="channel-name">{channel.name}</span>
                    <span className="channel-id">#{channel.id}</span>
                  </div>
                  <div className="channel-button-status">
                    <span className={`arrow-icon uplink ${channel.uplinkEnabled ? 'enabled' : 'disabled'}`} title="Uplink">
                      ↑
                    </span>
                    <span className={`arrow-icon downlink ${channel.downlinkEnabled ? 'enabled' : 'disabled'}`} title="Downlink">
                      ↓
                    </span>
                  </div>
                </button>
              ))}
            </div>

            {/* Selected Channel Messaging */}
            {selectedChannel && (
              <div className="channel-conversation-section">
                <h3>
                  {getChannelName(selectedChannel)}
                  <span className="channel-id-label">#{selectedChannel}</span>
                </h3>

                <div className="channel-conversation">
                  <div className="messages-container">
                    {channelMessages[selectedChannel] && channelMessages[selectedChannel].length > 0 ? (
                      channelMessages[selectedChannel].map(msg => {
                        const isMine = isMyMessage(msg);
                        const isPending = pendingMessages.has(msg.id);
                        return (
                          <div key={msg.id} className={`message-bubble-container ${isMine ? 'mine' : 'theirs'}`}>
                            {!isMine && (
                              <div
                                className="sender-dot"
                                title={getNodeName(msg.from)}
                              >
                                {getNodeShortName(msg.from)}
                              </div>
                            )}
                            <div className={`message-bubble ${isMine ? 'mine' : 'theirs'}`}>
                              <div className="message-text">{msg.text}</div>
                              <div className="message-time">
                                {msg.timestamp.toLocaleTimeString([], {
                                  hour: '2-digit',
                                  minute: '2-digit'
                                })}
                              </div>
                            </div>
                            {isMine && (
                              <div className="message-status">
                                {isPending ? (
                                  <span className="status-pending" title="Sending...">⏳</span>
                                ) : (
                                  <span className="status-delivered" title="Delivered">✓</span>
                                )}
                              </div>
                            )}
                          </div>
                        );
                      })
                    ) : (
                      <p className="no-messages">No messages in this channel yet</p>
                    )}
                  </div>

                  {/* Send message form */}
                  {connectionStatus === 'connected' && (
                    <div className="send-message-form">
                      <div className="message-input-container">
                        <input
                          type="text"
                          value={newMessage}
                          onChange={(e) => setNewMessage(e.target.value)}
                          placeholder={`Send message to ${getChannelName(selectedChannel)}...`}
                          className="message-input"
                          onKeyPress={(e) => {
                            if (e.key === 'Enter') {
                              handleSendMessage(selectedChannel);
                            }
                          }}
                        />
                        <button
                          onClick={() => handleSendMessage(selectedChannel)}
                          disabled={!newMessage.trim()}
                          className="send-btn"
                        >
                          Send
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}

            {!selectedChannel && (
              <p className="no-data">Select a channel above to view messages and send messages</p>
            )}
          </>
        ) : (
          <p className="no-data">No channel configurations discovered yet. Waiting for mesh updates...</p>
        )
      ) : (
        <p className="no-data">Connect to a Meshtastic node to view channel configurations</p>
      )}
    </div>
  );

  const renderMessagesTab = () => (
    <div className="tab-content">
      <h2>Direct Messages</h2>

      {/* Direct Messages Section */}
      <div className="dm-section">
        <div className="dm-selector">
          <select
            value={selectedDMNode}
            onChange={(e) => setSelectedDMNode(e.target.value)}
            className="node-select"
          >
            <option value="">Select a node...</option>
            {nodes.map(node => (
              <option key={node.nodeNum} value={node.user?.id || node.nodeNum.toString()}>
                {node.user?.longName || node.user?.shortName || `Node ${node.nodeNum}`}
              </option>
            ))}
          </select>
        </div>

        {selectedDMNode ? (
          <div className="dm-conversation">
            <h3>Conversation with {getNodeName(selectedDMNode)}</h3>
            <div className="messages-container">
              {getDMMessages(selectedDMNode).length > 0 ? (
                getDMMessages(selectedDMNode).map(msg => (
                  <div key={msg.id} className={`message-item ${msg.from === selectedDMNode ? 'received' : 'sent'}`}>
                    <div className="message-header">
                      <span className="message-from">{getNodeName(msg.from)}</span>
                      <span className="message-time">{msg.timestamp.toLocaleTimeString()}</span>
                    </div>
                    <div className="message-text">{msg.text}</div>
                  </div>
                ))
              ) : (
                <p className="no-messages">No direct messages with this node yet</p>
              )}
            </div>

            {/* Send DM form */}
            {connectionStatus === 'connected' && (
              <div className="send-message-form">
                <div className="message-input-container">
                  <input
                    type="text"
                    value={newMessage}
                    onChange={(e) => setNewMessage(e.target.value)}
                    placeholder={`Send direct message to ${getNodeName(selectedDMNode)}...`}
                    className="message-input"
                    onKeyPress={(e) => {
                      if (e.key === 'Enter') {
                        // Note: Direct messaging may need different API endpoint
                        handleSendMessage(0); // For now, use channel 0
                      }
                    }}
                  />
                  <button
                    onClick={() => handleSendMessage(0)} // For now, use channel 0
                    disabled={!newMessage.trim()}
                    className="send-btn"
                  >
                    Send
                  </button>
                </div>
              </div>
            )}
          </div>
        ) : (
          <p className="no-data">Select a node above to view and send direct messages</p>
        )}

        {connectionStatus !== 'connected' && (
          <p className="no-data">Connect to a Meshtastic node to view direct messages</p>
        )}
      </div>
    </div>
  );

  const renderInfoTab = () => (
    <div className="tab-content">
      <h2>Device Information & Configuration</h2>
      <div className="device-info">
        <div className="info-section">
          <h3>Connection Status</h3>
          <p><strong>Node Address:</strong> {nodeAddress}</p>
          <p><strong>Connection Status:</strong> <span className={`status-text ${connectionStatus}`}>{connectionStatus}</span></p>
          <p><strong>Uses TLS:</strong> {deviceInfo?.meshtasticUseTls ? 'Yes' : 'No'}</p>
        </div>

        {deviceConfig && (
          <>
            <div className="info-section">
              <h3>LoRa Radio Configuration</h3>
              <p><strong>Region:</strong> {deviceConfig.radio?.region || 'Unknown'}</p>
              <p><strong>Modem Preset:</strong> {deviceConfig.radio?.modemPreset || 'Unknown'}</p>
              <p><strong>Hop Limit:</strong> {deviceConfig.radio?.hopLimit || 'Unknown'}</p>
              <p><strong>TX Power:</strong> {deviceConfig.radio?.txPower ? `${deviceConfig.radio.txPower} dBm` : 'Unknown'}</p>
              <p><strong>Bandwidth:</strong> {deviceConfig.radio?.bandwidth ? `${deviceConfig.radio.bandwidth} kHz` : 'Unknown'}</p>
              <p><strong>Spread Factor:</strong> {deviceConfig.radio?.spreadFactor || 'Unknown'}</p>
              <p><strong>Coding Rate:</strong> {deviceConfig.radio?.codingRate || 'Unknown'}</p>
            </div>

            <div className="info-section">
              <h3>MQTT Configuration</h3>
              <p><strong>Enabled:</strong> {deviceConfig.mqtt?.enabled ? 'Yes' : 'No'}</p>
              <p><strong>Server:</strong> {deviceConfig.mqtt?.server || 'Not configured'}</p>
              <p><strong>Username:</strong> {deviceConfig.mqtt?.username || 'Not set'}</p>
              <p><strong>Encryption:</strong> {deviceConfig.mqtt?.encryption ? 'Enabled' : 'Disabled'}</p>
              <p><strong>JSON Format:</strong> {deviceConfig.mqtt?.json ? 'Enabled' : 'Disabled'}</p>
              <p><strong>TLS:</strong> {deviceConfig.mqtt?.tls ? 'Enabled' : 'Disabled'}</p>
              <p><strong>Root Topic:</strong> {deviceConfig.mqtt?.rootTopic || 'msh'}</p>
            </div>

            <div className="info-section">
              <h3>Channel Configuration</h3>
              {deviceConfig.channels && deviceConfig.channels.length > 0 ? (
                <div className="channel-config">
                  {deviceConfig.channels.map((channel: any, index: number) => (
                    <div key={index} className="channel-item">
                      <p><strong>Channel {channel.index}:</strong> {channel.name}</p>
                      <p><strong>Uplink:</strong> {channel.uplinkEnabled ? 'Enabled' : 'Disabled'}</p>
                      <p><strong>Downlink:</strong> {channel.downlinkEnabled ? 'Enabled' : 'Disabled'}</p>
                      {index < deviceConfig.channels.length - 1 && <hr />}
                    </div>
                  ))}
                </div>
              ) : (
                <p>No channels configured</p>
              )}
            </div>
          </>
        )}

        <div className="info-section">
          <h3>Network Statistics</h3>
          <p><strong>Total Nodes:</strong> {nodes.length}</p>
          <p><strong>Total Channels:</strong> {channels.length}</p>
          <p><strong>Total Messages:</strong> {messages.length}</p>
          <p><strong>Active Message Channels:</strong> {getAvailableChannels().length}</p>
        </div>

        <div className="info-section">
          <h3>Recent Activity</h3>
          <p><strong>Last Message:</strong> {messages.length > 0 ? messages[0].timestamp.toLocaleString() : 'None'}</p>
          <p><strong>Most Active Node:</strong> {
            nodes.length > 0 ?
            nodes.reduce((prev, current) =>
              (prev.lastHeard || 0) > (current.lastHeard || 0) ? prev : current
            ).user?.longName || 'Unknown' : 'None'
          }</p>
        </div>

        {!deviceConfig && (
          <div className="info-section">
            <p className="no-data">Device configuration not available. Ensure connection is established.</p>
          </div>
        )}
      </div>
    </div>
  );

  const renderSettingsTab = () => (
    <div className="tab-content">
      <h2>Settings</h2>
      <p className="no-data">Settings coming soon...</p>
    </div>
  );

  return (
    <div className="app">
      <header className="app-header">
        <div className="header-left">
          <h1>MeshMonitor</h1>
          <div className="node-info">
            <span className="node-address">{nodeAddress}</span>
          </div>
        </div>
        <div className="connection-status">
          <span className={`status-indicator ${connectionStatus}`}></span>
          <span>{connectionStatus}</span>
        </div>
      </header>

      <nav className="tab-nav">
        <button
          className={`tab-btn ${activeTab === 'nodes' ? 'active' : ''}`}
          onClick={() => setActiveTab('nodes')}
        >
          Nodes
        </button>
        <button
          className={`tab-btn ${activeTab === 'channels' ? 'active' : ''}`}
          onClick={() => setActiveTab('channels')}
        >
          Channels
        </button>
        <button
          className={`tab-btn ${activeTab === 'messages' ? 'active' : ''}`}
          onClick={() => setActiveTab('messages')}
        >
          Messages
        </button>
        <button
          className={`tab-btn ${activeTab === 'info' ? 'active' : ''}`}
          onClick={() => setActiveTab('info')}
        >
          Info
        </button>
        <button
          className={`tab-btn ${activeTab === 'settings' ? 'active' : ''}`}
          onClick={() => setActiveTab('settings')}
        >
          Settings
        </button>
      </nav>

      <main className="app-main">
        {error && (
          <div className="error-panel">
            <h3>Connection Error</h3>
            <p>{error}</p>
            <div className="error-actions">
              <button onClick={checkConnectionStatus} className="retry-btn">
                Retry Connection
              </button>
              <button onClick={() => setError(null)} className="dismiss-error">
                Dismiss
              </button>
            </div>
          </div>
        )}

        {activeTab === 'nodes' && renderNodesTab()}
        {activeTab === 'channels' && renderChannelsTab()}
        {activeTab === 'messages' && renderMessagesTab()}
        {activeTab === 'info' && renderInfoTab()}
        {activeTab === 'settings' && renderSettingsTab()}
      </main>
    </div>
  )
}

export default App