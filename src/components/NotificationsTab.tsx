import React, { useState, useEffect, useRef, useMemo } from 'react';
import { useTranslation, Trans } from 'react-i18next';
import api from '../services/api';
import { logger } from '../utils/logger';
import { Channel } from '../types/device';

interface VapidStatus {
  configured: boolean;
  publicKey: string | null;
  subject: string | null;
  subscriptionCount: number;
}

interface NotificationPreferences {
  enableWebPush: boolean;
  enableApprise: boolean;
  enabledChannels: number[];
  enableDirectMessages: boolean;
  notifyOnEmoji: boolean;
  notifyOnNewNode: boolean;
  notifyOnTraceroute: boolean;
  notifyOnInactiveNode: boolean;
  notifyOnServerEvents: boolean;
  monitoredNodes: string[];
  whitelist: string[];
  blacklist: string[];
}

interface NotificationsTabProps {
  isAdmin: boolean;
}

const NotificationsTab: React.FC<NotificationsTabProps> = ({ isAdmin }) => {
  const { t } = useTranslation();
  const [vapidStatus, setVapidStatus] = useState<VapidStatus | null>(null);
  const [isSubscribed, setIsSubscribed] = useState(false);
  const [isSubscribing, setIsSubscribing] = useState(false);
  const [notificationPermission, setNotificationPermission] = useState<NotificationPermission>('default');
  const [vapidSubject, setVapidSubject] = useState('');
  const [isUpdatingSubject, setIsUpdatingSubject] = useState(false);
  const [testStatus, setTestStatus] = useState<string>('');
  const [debugInfo, setDebugInfo] = useState<string>('');

  // Notification preferences
  const [channels, setChannels] = useState<Channel[]>([]);
  const [preferences, setPreferences] = useState<NotificationPreferences>({
    enableWebPush: false,
    enableApprise: false,
    enabledChannels: [],
    enableDirectMessages: true,
    notifyOnEmoji: true,
    notifyOnNewNode: true,
    notifyOnTraceroute: true,
    notifyOnInactiveNode: false,
    notifyOnServerEvents: false,
    monitoredNodes: [],
    whitelist: ['Hi', 'Help'],
    blacklist: ['Test', 'Copy']
  });
  const [whitelistText, setWhitelistText] = useState('Hi\nHelp');
  const [blacklistText, setBlacklistText] = useState('Test\nCopy');
  const [isSavingPreferences, setIsSavingPreferences] = useState(false);
  
  // Inactive node monitoring
  const [selectedMonitoredNodes, setSelectedMonitoredNodes] = useState<string[]>([]);
  const [availableNodes, setAvailableNodes] = useState<any[]>([]);
  const [nodeSearchTerm, setNodeSearchTerm] = useState('');

  // Apprise configuration
  const [appriseUrls, setAppriseUrls] = useState('');
  const [isSavingApprise, setIsSavingApprise] = useState(false);
  const [appriseTestStatus, setAppriseTestStatus] = useState('');

  // Track timeouts for cleanup on unmount
  const timeoutsRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  // Cleanup timeouts on unmount to prevent memory leaks
  useEffect(() => {
    return () => {
      timeoutsRef.current.forEach(timeout => clearTimeout(timeout));
      timeoutsRef.current = [];
    };
  }, []);

  // Check notification permission and subscription status
  useEffect(() => {
    checkNotificationStatus();
    loadVapidStatus();
    loadChannels();
    loadNodes();
  }, []);

  // Fetch available nodes
  const loadNodes = async () => {
    try {
      const response = await api.get('/api/nodes');
      const nodeList = Array.isArray(response) ? response : [];
      setAvailableNodes(nodeList);
    } catch (error) {
      logger.error('Failed to fetch nodes:', error);
    }
  };

  // Load preferences after channels are loaded
  useEffect(() => {
    if (channels.length > 0) {
      loadPreferences();
    }
  }, [channels.length]);

  // Filter nodes based on search term
  const filteredNodes = useMemo(() => {
    if (!nodeSearchTerm.trim()) {
      return availableNodes;
    }
    const lowerSearch = nodeSearchTerm.toLowerCase().trim();
    return availableNodes.filter(node => {
      const longName = (node.user?.longName || node.longName || '').toLowerCase();
      const shortName = (node.user?.shortName || node.shortName || '').toLowerCase();
      const nodeId = (node.user?.id || node.nodeId || '').toLowerCase();
      return longName.includes(lowerSearch) ||
             shortName.includes(lowerSearch) ||
             nodeId.includes(lowerSearch);
    });
  }, [availableNodes, nodeSearchTerm]);

  const checkNotificationStatus = async () => {
    if (!('Notification' in window) || !('serviceWorker' in navigator) || !('PushManager' in window)) {
      logger.warn('Push notifications not fully supported');
      return;
    }

    setNotificationPermission(Notification.permission);

    try {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      setIsSubscribed(!!subscription);
    } catch (error) {
      logger.error('Failed to check subscription status:', error);
    }
  };

  const loadVapidStatus = async () => {
    try {
      const response = await api.get<VapidStatus>('/api/push/status');
      setVapidStatus(response);
      if (response.subject) {
        setVapidSubject(response.subject);
      }
    } catch (error) {
      logger.error('Failed to load VAPID status:', error);
    }
  };

  const loadChannels = async () => {
    try {
      const response = await api.get<Channel[]>('/api/channels');
      const channelList = Array.isArray(response) ? response : [];
      setChannels(channelList);

      if (preferences.enabledChannels.length === 0 && channelList.length > 0) {
        setPreferences(prev => ({
          ...prev,
          enabledChannels: channelList.map(c => c.id)
        }));
      }
    } catch (error) {
      logger.error('Failed to load channels:', error);
    }
  };

  const loadPreferences = async () => {
    try {
      const response = await api.get<NotificationPreferences>('/api/push/preferences');

      if (response.enabledChannels.length === 0 && channels.length > 0) {
        response.enabledChannels = channels.map(c => c.id);
      }

      setPreferences(response);
      setWhitelistText(response.whitelist.join('\n'));
      setBlacklistText(response.blacklist.join('\n'));
      setSelectedMonitoredNodes(response.monitoredNodes || []);

      // Load Apprise URLs if Apprise is enabled
      if (response.enableApprise) {
        loadAppriseUrls();
      }
    } catch (_error) {
      logger.debug('No saved preferences, using defaults');
    }
  };

  const loadAppriseUrls = async () => {
    try {
      const response = await api.get<{ urls: string[] }>('/api/apprise/urls');
      setAppriseUrls(response.urls.join('\n'));
    } catch (_error) {
      logger.debug('No saved Apprise URLs, using empty');
    }
  };

  const sanitizeKeyword = (keyword: string): string => {
    const htmlEntities: Record<string, string> = {
      '<': '&lt;',
      '>': '&gt;',
      '&': '&amp;',
      '"': '&quot;',
      "'": '&#39;'
    };

    return keyword
      .trim()
      .slice(0, 100)
      .replace(/[<>&"']/g, char => htmlEntities[char]);
  };

  const savePreferences = async () => {
    setIsSavingPreferences(true);
    try {
      const whitelist = whitelistText
        .split('\n')
        .map(w => sanitizeKeyword(w))
        .filter(w => w.length > 0)
        .slice(0, 100);

      const blacklist = blacklistText
        .split('\n')
        .map(w => sanitizeKeyword(w))
        .filter(w => w.length > 0)
        .slice(0, 100);

      const prefs: NotificationPreferences = {
        ...preferences,
        notifyOnInactiveNode: preferences.notifyOnInactiveNode,
        monitoredNodes: selectedMonitoredNodes,
        whitelist,
        blacklist
      };

      await api.post('/api/push/preferences', prefs);
      setPreferences(prefs);
      logger.info('Notification preferences saved');

      // Load Apprise URLs if Apprise was just enabled
      if (prefs.enableApprise) {
        loadAppriseUrls();
      }
    } catch (error) {
      logger.error('Failed to save preferences:', error);
      alert(t('notifications.alert_save_failed'));
    } finally {
      setIsSavingPreferences(false);
    }
  };

  const requestNotificationPermission = async () => {
    if (!('Notification' in window)) {
      alert(t('notifications.alert_not_supported'));
      return;
    }

    try {
      const permission = await Notification.requestPermission();
      setNotificationPermission(permission);

      if (permission !== 'granted') {
        logger.warn('Notification permission not granted:', permission);
      }
    } catch (error) {
      logger.error('Failed to request notification permission:', error);
      alert(t('notifications.alert_permission_failed'));
    }
  };

  const subscribeToNotifications = async () => {
    if (notificationPermission !== 'granted') {
      alert(t('notifications.alert_grant_permission'));
      return;
    }

    setIsSubscribing(true);
    setDebugInfo('Starting subscription...');

    try {
      setDebugInfo('Fetching VAPID public key...');
      logger.info('Fetching VAPID public key...');

      const response = await api.get<{ publicKey: string }>('/api/push/vapid-key');
      logger.info('VAPID key response:', response);
      setDebugInfo(`Got VAPID key: ${response.publicKey ? 'Yes' : 'No'}`);

      const publicKey = response.publicKey;

      if (!publicKey) {
        throw new Error('VAPID public key not available');
      }

      setDebugInfo('Creating push subscription...');
      logger.info('Subscribing to push notifications...');
      logger.info('VAPID public key (first 20 chars):', publicKey.substring(0, 20));
      logger.info('Converted key length:', urlBase64ToUint8Array(publicKey).length);

      const registration = await navigator.serviceWorker.ready;
      logger.info('Service worker ready, attempting subscription...');

      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey)
      });

      logger.info('Push subscription created:', subscription);
      setDebugInfo('Saving subscription to server...');

      const subscriptionData = {
        subscription: {
          endpoint: subscription.endpoint,
          keys: {
            p256dh: arrayBufferToBase64(subscription.getKey('p256dh')!),
            auth: arrayBufferToBase64(subscription.getKey('auth')!)
          }
        }
      };

      await api.post('/api/push/subscribe', subscriptionData);

      setIsSubscribed(true);
      setDebugInfo('✅ Successfully subscribed!');
      logger.info('Successfully subscribed to push notifications');

      const timeout = setTimeout(() => setDebugInfo(''), 5000);
      timeoutsRef.current.push(timeout);
    } catch (error: any) {
      logger.error('Failed to subscribe to push notifications:', error);
      setDebugInfo(`❌ Error: ${error.message}`);
      alert(t('notifications.alert_subscribe_failed', { error: error.message }));
    } finally {
      setIsSubscribing(false);
    }
  };

  const unsubscribeFromNotifications = async () => {
    setIsSubscribing(true);
    try {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();

      if (subscription) {
        await subscription.unsubscribe();
        await api.post('/api/push/unsubscribe', {
          endpoint: subscription.endpoint
        });
      }

      setIsSubscribed(false);
      logger.info('Unsubscribed from push notifications');
    } catch (error) {
      logger.error('Failed to unsubscribe:', error);
      alert(t('notifications.alert_unsubscribe_failed'));
    } finally {
      setIsSubscribing(false);
    }
  };

  const updateVapidSubject = async () => {
    setIsUpdatingSubject(true);
    try {
      await api.put('/api/push/vapid-subject', { subject: vapidSubject });
      logger.info('VAPID subject updated');
      await loadVapidStatus();
    } catch (error) {
      logger.error('Failed to update VAPID subject:', error);
      alert(t('notifications.alert_update_email_failed'));
    } finally {
      setIsUpdatingSubject(false);
    }
  };

  const sendTestNotification = async () => {
    setTestStatus('Sending...');

    try {
      const response = await api.post<{ sent: number; failed: number }>('/api/push/test', {});
      setTestStatus(`✅ Sent: ${response.sent}, Failed: ${response.failed}`);
      const timeout = setTimeout(() => setTestStatus(''), 5000);
      timeoutsRef.current.push(timeout);
    } catch (error) {
      logger.error('Failed to send test notification:', error);
      setTestStatus('❌ Failed to send test notification');
      const timeout = setTimeout(() => setTestStatus(''), 5000);
      timeoutsRef.current.push(timeout);
    }
  };

  const saveAppriseUrls = async () => {
    setIsSavingApprise(true);
    try {
      const urls = appriseUrls
        .split('\n')
        .map(url => url.trim())
        .filter(url => url.length > 0);

      await api.post('/api/apprise/configure', { urls });
      logger.info('Apprise URLs configured successfully');
      setAppriseTestStatus('✅ Configuration saved');
      const timeout = setTimeout(() => setAppriseTestStatus(''), 3000);
      timeoutsRef.current.push(timeout);
    } catch (error) {
      logger.error('Failed to configure Apprise URLs:', error);
      setAppriseTestStatus('❌ Failed to save configuration');
      const timeout = setTimeout(() => setAppriseTestStatus(''), 5000);
      timeoutsRef.current.push(timeout);
    } finally {
      setIsSavingApprise(false);
    }
  };

  const testAppriseConnection = async () => {
    setAppriseTestStatus('Sending test notification...');
    try {
      const response = await api.post<{ success: boolean; message: string }>('/api/apprise/test', {});
      if (response.success) {
        setAppriseTestStatus(`✅ ${response.message}`);
      } else {
        setAppriseTestStatus(`⚠️ ${response.message}`);
      }
      const timeout = setTimeout(() => setAppriseTestStatus(''), 5000);
      timeoutsRef.current.push(timeout);
    } catch (error) {
      logger.error('Failed to test Apprise connection:', error);
      setAppriseTestStatus('❌ Connection test failed');
      const timeout = setTimeout(() => setAppriseTestStatus(''), 5000);
      timeoutsRef.current.push(timeout);
    }
  };

  function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding)
      .replace(/\-/g, '+')
      .replace(/_/g, '/');

    const rawData = window.atob(base64);
    const outputArray = new Uint8Array(rawData.length);

    for (let i = 0; i < rawData.length; ++i) {
      outputArray[i] = rawData.charCodeAt(i);
    }
    return outputArray as Uint8Array<ArrayBuffer>;
  }

  function arrayBufferToBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return window.btoa(binary);
  }

  const isSupported = 'Notification' in window && 'serviceWorker' in navigator && 'PushManager' in window;
  const isPWAInstalled = window.matchMedia('(display-mode: standalone)').matches;
  const isSecureContext = window.isSecureContext;
  const isLocalhost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';

  return (
    <div className="tab-content">
      <h2>{t('notifications.title')}</h2>

      {/* ========================================
          SECTION 1: Notification Services & Filtering (Top)
          ======================================== */}
      <div className="settings-section">
        <h3>🔔 {t('notifications.services_title')}</h3>
        <p style={{ marginBottom: '24px', color: '#666' }}>
          {t('notifications.services_description')}
        </p>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))', gap: '16px', marginBottom: '32px' }}>
          {/* Web Push Toggle */}
          <div style={{
            padding: '16px',
            backgroundColor: '#252535',
            borderRadius: '6px',
            border: '2px solid ' + (preferences.enableWebPush ? '#10b981' : '#3a3a3a')
          }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '12px', cursor: 'pointer', margin: 0 }}>
              <input
                type="checkbox"
                checked={preferences.enableWebPush}
                onChange={(e) => {
                  setPreferences(prev => ({
                    ...prev,
                    enableWebPush: e.target.checked
                  }));
                }}
                style={{ width: '20px', height: '20px' }}
              />
              <div>
                <div style={{ fontWeight: '600', fontSize: '15px' }}>
                  📱 {t('notifications.webpush_title')}
                </div>
                <div style={{ fontSize: '12px', color: '#9ca3af', marginTop: '4px' }}>
                  {t('notifications.webpush_description')}
                </div>
              </div>
            </label>
          </div>

          {/* Apprise Toggle */}
          <div style={{
            padding: '16px',
            backgroundColor: '#252535',
            borderRadius: '6px',
            border: '2px solid ' + (preferences.enableApprise ? '#10b981' : '#3a3a3a')
          }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '12px', cursor: 'pointer', margin: 0 }}>
              <input
                type="checkbox"
                checked={preferences.enableApprise}
                onChange={(e) => {
                  setPreferences(prev => ({
                    ...prev,
                    enableApprise: e.target.checked
                  }));
                }}
                style={{ width: '20px', height: '20px' }}
              />
              <div>
                <div style={{ fontWeight: '600', fontSize: '15px' }}>
                  🔔 {t('notifications.apprise_title')}
                </div>
                <div style={{ fontSize: '12px', color: '#9ca3af', marginTop: '4px' }}>
                  {t('notifications.apprise_description')}
                </div>
              </div>
            </label>
          </div>
        </div>

        {/* Filtering Section */}
        <h4 style={{ marginTop: '32px', marginBottom: '16px' }}>⚙️ {t('notifications.filtering_title')}</h4>
        <p style={{ marginBottom: '24px', color: '#666', fontSize: '14px' }}><Trans i18nKey="notifications.filtering_description" components={{ strong: <strong /> }} /></p>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: '24px', marginBottom: '24px' }}>
          {/* Channel/DM Selection */}
          <div>
            <div style={{
              backgroundColor: '#1e1e2e',
              padding: '20px',
              borderRadius: '8px',
              border: '1px solid #3a3a3a'
            }}>
              <h4 style={{ marginTop: '0', marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span>📢</span> {t('notifications.sources_title')}
              </h4>

              {/* Direct Messages Toggle */}
              <div style={{
                padding: '12px',
                backgroundColor: '#252535',
                borderRadius: '6px',
                marginBottom: '16px',
                border: '2px solid #3a3a3a'
              }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer', margin: 0 }}>
                  <input
                    type="checkbox"
                    checked={preferences.enableDirectMessages}
                    onChange={(e) => {
                      setPreferences(prev => ({
                        ...prev,
                        enableDirectMessages: e.target.checked
                      }));
                    }}
                    style={{ width: '18px', height: '18px' }}
                  />
                  <span style={{ fontWeight: '500' }}>💬 {t('notifications.direct_messages')}</span>
                </label>
              </div>

              {/* Emoji Reactions Toggle */}
              <div style={{
                padding: '12px',
                backgroundColor: '#252535',
                borderRadius: '6px',
                marginBottom: '16px',
                border: '2px solid #3a3a3a'
              }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer', margin: 0 }}>
                  <input
                    type="checkbox"
                    checked={preferences.notifyOnEmoji}
                    onChange={(e) => {
                      setPreferences(prev => ({
                        ...prev,
                        notifyOnEmoji: e.target.checked
                      }));
                    }}
                    style={{ width: '18px', height: '18px' }}
                  />
                  <span style={{ fontWeight: '500' }}>😀 {t('notifications.emoji_reactions')}</span>
                </label>
              </div>

              {/* New Node Toggle */}
              <div style={{
                padding: '12px',
                backgroundColor: '#252535',
                borderRadius: '6px',
                marginBottom: '16px',
                border: '2px solid #3a3a3a'
              }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer', margin: 0 }}>
                  <input
                    type="checkbox"
                    checked={preferences.notifyOnNewNode}
                    onChange={(e) => {
                      setPreferences(prev => ({
                        ...prev,
                        notifyOnNewNode: e.target.checked
                      }));
                    }}
                    style={{ width: '18px', height: '18px' }}
                  />
                  <span style={{ fontWeight: '500' }}>🆕 {t('notifications.new_nodes')}</span>
                </label>
              </div>

              {/* Traceroute Success Toggle */}
              <div style={{
                padding: '12px',
                backgroundColor: '#252535',
                borderRadius: '6px',
                marginBottom: '16px',
                border: '2px solid #3a3a3a'
              }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer', margin: 0 }}>
                  <input
                    type="checkbox"
                    checked={preferences.notifyOnTraceroute}
                    onChange={(e) => {
                      setPreferences(prev => ({
                        ...prev,
                        notifyOnTraceroute: e.target.checked
                      }));
                    }}
                    style={{ width: '18px', height: '18px' }}
                  />
                  <span style={{ fontWeight: '500' }}>🗺️ {t('notifications.traceroutes')}</span>
                </label>
              </div>

              {/* Inactive Node Notifications */}
              <div style={{
                padding: '12px',
                backgroundColor: '#252535',
                borderRadius: '6px',
                marginBottom: '16px',
                border: '2px solid #3a3a3a'
              }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer', margin: 0 }}>
                  <input
                    type="checkbox"
                    checked={preferences.notifyOnInactiveNode}
                    onChange={(e) => {
                      setPreferences(prev => ({
                        ...prev,
                        notifyOnInactiveNode: e.target.checked
                      }));
                    }}
                    style={{ width: '18px', height: '18px' }}
                  />
                  <span style={{ fontWeight: '500' }}>⚠️ {t('notifications.notify_on_inactive_node')}</span>
                </label>
                
                {preferences.notifyOnInactiveNode && (
                  <div style={{ 
                    marginLeft: '28px', 
                    marginTop: '12px',
                    padding: '12px',
                    background: 'var(--ctp-surface0)',
                    border: '1px solid var(--ctp-surface2)',
                    borderRadius: '6px'
                  }}>
                    <p style={{ marginBottom: '0.75rem', fontSize: '0.9em', color: 'var(--ctp-subtext0)' }}>
                      {t('notifications.monitored_nodes_description')}
                    </p>
                    
                    {/* Search bar */}
                    <input
                      type="text"
                      placeholder={t('notifications.search_nodes')}
                      value={nodeSearchTerm}
                      onChange={(e) => setNodeSearchTerm(e.target.value)}
                      style={{
                        width: '100%',
                        padding: '0.5rem',
                        marginBottom: '0.75rem',
                        background: 'var(--ctp-base)',
                        border: '1px solid var(--ctp-surface2)',
                        borderRadius: '4px',
                        color: 'var(--ctp-text)'
                      }}
                    />
                    
                    {/* Select/Deselect buttons */}
                    <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.75rem' }}>
                      <button
                        onClick={() => {
                          const filtered = filteredNodes.map(n => n.user?.id || n.nodeId);
                          setSelectedMonitoredNodes([...new Set([...selectedMonitoredNodes, ...filtered])]);
                        }}
                        className="btn-secondary"
                        style={{ padding: '0.4rem 0.8rem', fontSize: '12px' }}
                      >
                        {t('common.select_all')}
                      </button>
                      <button
                        onClick={() => {
                          const filtered = filteredNodes.map(n => n.user?.id || n.nodeId);
                          setSelectedMonitoredNodes(selectedMonitoredNodes.filter(id => !filtered.includes(id)));
                        }}
                        className="btn-secondary"
                        style={{ padding: '0.4rem 0.8rem', fontSize: '12px' }}
                      >
                        {t('common.deselect_all')}
                      </button>
                    </div>
                    
                    {/* Node list */}
                    <div style={{
                      maxHeight: '300px',
                      overflowY: 'auto',
                      border: '1px solid var(--ctp-surface2)',
                      borderRadius: '4px',
                      background: 'var(--ctp-base)'
                    }}>
                      {filteredNodes.length === 0 ? (
                        <div style={{ padding: '1rem', textAlign: 'center', color: 'var(--ctp-subtext0)' }}>
                          {nodeSearchTerm ? t('notifications.no_nodes_match') : t('notifications.no_nodes_available')}
                        </div>
                      ) : (
                        filteredNodes.map(node => {
                          const nodeId = node.user?.id || node.nodeId;
                          return (
                            <div
                              key={nodeId}
                              style={{
                                padding: '0.5rem 0.75rem',
                                borderBottom: '1px solid var(--ctp-surface1)',
                                display: 'flex',
                                alignItems: 'center',
                                cursor: 'pointer',
                                transition: 'background 0.1s'
                              }}
                              onMouseEnter={(e) => e.currentTarget.style.background = 'var(--ctp-surface0)'}
                              onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                              onClick={() => {
                                setSelectedMonitoredNodes(prev =>
                                  prev.includes(nodeId)
                                    ? prev.filter(id => id !== nodeId)
                                    : [...prev, nodeId]
                                );
                              }}
                            >
                              <input
                                type="checkbox"
                                checked={selectedMonitoredNodes.includes(nodeId)}
                                onChange={() => {
                                  setSelectedMonitoredNodes(prev =>
                                    prev.includes(nodeId)
                                      ? prev.filter(id => id !== nodeId)
                                      : [...prev, nodeId]
                                  );
                                }}
                                onClick={(e) => e.stopPropagation()}
                                style={{ width: 'auto', margin: 0, marginRight: '0.75rem', cursor: 'pointer' }}
                              />
                              <div style={{ flex: 1 }}>
                                <div style={{ fontWeight: '500', color: 'var(--ctp-text)' }}>
                                  {node.user?.longName || node.longName || node.user?.shortName || node.shortName || nodeId || 'Unknown'}
                                </div>
                                {(node.user?.longName || node.longName || node.user?.shortName || node.shortName) && (
                                  <div style={{ fontSize: '12px', color: 'var(--ctp-subtext0)' }}>
                                    {nodeId}
                                  </div>
                                )}
                              </div>
                            </div>
                          );
                        })
                      )}
                    </div>
                    
                    {/* Selection count */}
                    <div style={{ marginTop: '0.75rem', fontSize: '13px', color: 'var(--ctp-subtext0)' }}>
                      {t('notifications.monitored_nodes_count', { count: selectedMonitoredNodes.length })}
                      {selectedMonitoredNodes.length === 0 && (
                        <span style={{ color: 'var(--ctp-yellow)', marginLeft: '0.5rem' }}>
                          ({t('notifications.no_nodes_selected_warning')})
                        </span>
                      )}
                    </div>
                  </div>
                )}
              </div>

              {/* Server Events Notifications */}
              <div style={{
                padding: '12px',
                backgroundColor: '#252535',
                borderRadius: '6px',
                marginBottom: '16px',
                border: '2px solid #3a3a3a'
              }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer', margin: 0 }}>
                  <input
                    type="checkbox"
                    checked={preferences.notifyOnServerEvents}
                    onChange={(e) => {
                      setPreferences(prev => ({
                        ...prev,
                        notifyOnServerEvents: e.target.checked
                      }));
                    }}
                    style={{ width: '18px', height: '18px' }}
                  />
                  <span style={{ fontWeight: '500' }}>{t('notifications.notify_on_server_events')}</span>
                </label>

                {preferences.notifyOnServerEvents && (
                  <div style={{
                    marginLeft: '28px',
                    marginTop: '12px',
                    padding: '12px',
                    background: 'var(--ctp-surface0)',
                    border: '1px solid var(--ctp-surface2)',
                    borderRadius: '6px'
                  }}>
                    <p style={{ marginBottom: '0.5rem', fontSize: '0.9em', color: 'var(--ctp-subtext0)' }}>
                      {t('notifications.server_events_description')}
                    </p>
                    <ul style={{
                      margin: '0.5rem 0 0 1.5rem',
                      padding: 0,
                      fontSize: '0.85em',
                      color: 'var(--ctp-subtext1)',
                      listStyleType: 'disc'
                    }}>
                      <li>{t('notifications.server_events_startup')}</li>
                      <li>{t('notifications.server_events_disconnect')}</li>
                      <li>{t('notifications.server_events_reconnect')}</li>
                    </ul>
                  </div>
                )}
              </div>

              {/* Channel Selection */}
              <div style={{
                backgroundColor: '#252535',
                borderRadius: '6px',
                padding: '12px'
              }}>
                <div style={{ fontWeight: '600', marginBottom: '8px' }}>{t('notifications.channels')}:</div>
                {channels.length === 0 ? (
                  <p style={{ fontSize: '14px', color: '#999', margin: 0 }}>{t('notifications.no_channels')}</p>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                    {channels.map(channel => (
                      <label
                        key={channel.id}
                        style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}
                      >
                        <input
                          type="checkbox"
                          checked={preferences.enabledChannels.includes(channel.id)}
                          onChange={(e) => {
                            setPreferences(prev => ({
                              ...prev,
                              enabledChannels: e.target.checked
                                ? [...prev.enabledChannels, channel.id]
                                : prev.enabledChannels.filter(id => id !== channel.id)
                            }));
                          }}
                          style={{ width: '16px', height: '16px' }}
                        />
                        <span style={{ fontSize: '14px' }}>{channel.name || t('notifications.channel_number', { id: channel.id })}</span>
                      </label>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Keyword Filtering */}
          <div>
            <div style={{
              backgroundColor: '#1e1e2e',
              padding: '20px',
              borderRadius: '8px',
              border: '1px solid #3a3a3a'
            }}>
              <h4 style={{ marginTop: '0', marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span>🔤</span> {t('notifications.keyword_filtering')}
              </h4>

              {/* Whitelist */}
              <div style={{ marginBottom: '16px' }}>
                <label style={{
                  display: 'flex',
                  fontWeight: '600',
                  marginBottom: '8px',
                  color: '#28a745',
                  alignItems: 'center',
                  gap: '6px'
                }}>
                  <span>✅</span> {t('notifications.whitelist_title')}
                </label>
                <p style={{ fontSize: '13px', color: '#9ca3af', marginBottom: '8px', marginTop: 0 }}><Trans i18nKey="notifications.whitelist_description" components={{ strong: <strong /> }} /></p>
                <textarea
                  value={whitelistText}
                  onChange={(e) => setWhitelistText(e.target.value)}
                  placeholder="Hi&#10;Help&#10;Emergency"
                  rows={4}
                  style={{
                    width: '100%',
                    padding: '10px',
                    fontFamily: 'monospace',
                    fontSize: '14px',
                    border: '2px solid #28a745',
                    borderRadius: '6px',
                    resize: 'vertical',
                    backgroundColor: '#252535',
                    color: '#e5e7eb'
                  }}
                />
              </div>

              {/* Blacklist */}
              <div>
                <label style={{
                  display: 'flex',
                  fontWeight: '600',
                  marginBottom: '8px',
                  color: '#dc3545',
                  alignItems: 'center',
                  gap: '6px'
                }}>
                  <span>🚫</span> {t('notifications.blacklist_title')}
                </label>
                <p style={{ fontSize: '13px', color: '#9ca3af', marginBottom: '8px', marginTop: 0 }}><Trans i18nKey="notifications.blacklist_description" components={{ strong: <strong /> }} /></p>
                <textarea
                  value={blacklistText}
                  onChange={(e) => setBlacklistText(e.target.value)}
                  placeholder="Test&#10;Copy&#10;Spam"
                  rows={4}
                  style={{
                    width: '100%',
                    padding: '10px',
                    fontFamily: 'monospace',
                    fontSize: '14px',
                    border: '2px solid #dc3545',
                    borderRadius: '6px',
                    resize: 'vertical',
                    backgroundColor: '#252535',
                    color: '#e5e7eb'
                  }}
                />
              </div>
            </div>
          </div>
        </div>

        {/* Filter Priority Info */}
        <div style={{
          backgroundColor: '#1e3a5f',
          border: '1px solid #2a5a8a',
          borderRadius: '8px',
          padding: '16px',
          marginBottom: '20px',
          fontSize: '14px',
          color: '#93c5fd'
        }}>
          <strong>ℹ️ {t('notifications.filter_priority')}:</strong> {t('notifications.filter_priority_order')}
        </div>

        {/* Save Button */}
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button
            className="button button-primary"
            onClick={savePreferences}
            disabled={isSavingPreferences}
            style={{ minWidth: '150px' }}
          >
            {isSavingPreferences ? t('common.saving') : `💾 ${t('notifications.save_preferences')}`}
          </button>
        </div>
      </div>

      {/* ========================================
          SECTION 2: Web Push Configuration (only shown if enabled)
          ======================================== */}
      {preferences.enableWebPush && (
      <div className="settings-section">
        <h3>📱 {t('notifications.webpush_config_title')}</h3>

        {/* HTTPS Warning */}
        {!isSecureContext && !isLocalhost && (
          <div style={{ backgroundColor: '#f8d7da', color: '#721c24', padding: '15px', borderRadius: '8px', border: '1px solid #f5c6cb', marginBottom: '20px' }}>
            <h4 style={{ color: '#721c24', marginTop: 0 }}>⚠️ {t('notifications.https_required')}</h4>
            <p>
              <strong>{t('notifications.https_required_text')}</strong>
            </p>
            <p>{t('notifications.https_enable_options')}</p>
            <ul style={{ paddingLeft: '20px', marginLeft: '0' }}>
              <li><strong>HTTPS:</strong> {t('notifications.https_option_ssl')}</li>
              <li><strong>Localhost:</strong> {t('notifications.https_option_localhost')}</li>
            </ul>
            <p>
              {t('notifications.current_connection')}: <strong>{window.location.protocol}//{window.location.host}</strong>
            </p>
            <p style={{ marginTop: '12px', paddingTop: '12px', borderTop: '1px solid #f5c6cb' }}>
              <strong>{t('notifications.https_help_title')}</strong><br />
              {t('notifications.https_help_text')} <a
                href="https://github.com/Yeraze/meshmonitor/blob/main/docs/configuration/duckdns-https.md"
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: '#721c24', textDecoration: 'underline' }}
              >
                {t('notifications.https_help_link')}
              </a>.
            </p>
          </div>
        )}

        {/* Browser Support */}
        <div style={{ marginBottom: '20px' }}>
          <h4>{t('notifications.browser_support')}</h4>
          <div className="info-grid">
            <div className="info-item">
              <strong>{t('notifications.notifications_api')}:</strong> {('Notification' in window) ? `✅ ${t('notifications.supported')}` : `❌ ${t('notifications.not_supported')}`}
            </div>
            <div className="info-item">
              <strong>{t('notifications.service_workers')}:</strong> {('serviceWorker' in navigator) ? `✅ ${t('notifications.supported')}` : `❌ ${t('notifications.not_supported')}`}
            </div>
            <div className="info-item">
              <strong>{t('notifications.push_api')}:</strong> {('PushManager' in window) ? `✅ ${t('notifications.supported')}` : `❌ ${t('notifications.not_supported')}`}
            </div>
            <div className="info-item">
              <strong>{t('notifications.pwa_installed')}:</strong> {isPWAInstalled ? `✅ ${t('common.yes')}` : `⚠️ ${t('notifications.pwa_not_installed')}`}
            </div>
            <div className="info-item">
              <strong>{t('notifications.permission')}:</strong> {
                notificationPermission === 'granted' ? `✅ ${t('notifications.permission_granted')}` :
                notificationPermission === 'denied' ? `❌ ${t('notifications.permission_denied')}` :
                `⚠️ ${t('notifications.permission_not_requested')}`
              }
            </div>
            <div className="info-item">
              <strong>{t('notifications.subscription')}:</strong> {isSubscribed ? `✅ ${t('notifications.subscribed')}` : `⚠️ ${t('notifications.not_subscribed')}`}
            </div>
          </div>
        </div>

        {/* iOS Instructions */}
        {!isPWAInstalled && (
          <div style={{ backgroundColor: '#fff3cd', color: '#856404', padding: '15px', borderRadius: '8px', border: '1px solid #ffc107', marginBottom: '20px' }}>
            <h4 style={{ color: '#856404', marginTop: 0 }}>📱 {t('notifications.ios_title')}</h4>
            <p>{t('notifications.ios_description')}</p>
            <ol style={{ paddingLeft: '20px', marginLeft: '0' }}>
              <li><strong>{t('notifications.https_required')}:</strong> {t('notifications.ios_step_https')}</li>
              <li>{t('notifications.ios_step_safari')}</li>
              <li>{t('notifications.ios_step_share')}</li>
              <li>{t('notifications.ios_step_add')}</li>
              <li>{t('notifications.ios_step_open')}</li>
              <li>{t('notifications.ios_step_return')}</li>
            </ol>
          </div>
        )}

        {/* Setup Notifications */}
        {isSupported && (
          <div>
            <h4>{t('notifications.setup_title')}</h4>
            <p>{t('notifications.setup_description')}</p>

            {/* Step 1: Request Permission */}
            <div style={{ marginBottom: '20px' }}>
              <h5>{t('notifications.step1_title')}</h5>
              {notificationPermission === 'default' && (
                <div>
                  <p>{t('notifications.step1_description')}</p>
                  <button
                    className="button button-primary"
                    onClick={requestNotificationPermission}
                  >
                    🔔 {t('notifications.enable_notifications')}
                  </button>
                </div>
              )}
              {notificationPermission === 'granted' && (
                <p>✅ {t('notifications.permission_granted')}</p>
              )}
              {notificationPermission === 'denied' && (
                <div className="error-message">
                  <p>❌ {t('notifications.permission_denied_message')}</p>
                  <p><strong>Chrome/Edge:</strong> {t('notifications.permission_fix_chrome')}</p>
                  <p><strong>Safari:</strong> {t('notifications.permission_fix_safari')}</p>
                </div>
              )}
            </div>

            {/* Step 2: Subscribe */}
            {notificationPermission === 'granted' && (
              <div style={{ marginBottom: '20px' }}>
                <h5>{t('notifications.step2_title')}</h5>
                {!isSubscribed && (
                  <div>
                    <p>{t('notifications.step2_description')}</p>
                    <button
                      className="button button-primary"
                      onClick={subscribeToNotifications}
                      disabled={isSubscribing}
                    >
                      {isSubscribing ? t('notifications.subscribing') : `📥 ${t('notifications.subscribe_button')}`}
                    </button>
                    {debugInfo && (
                      <div style={{ marginTop: '10px', padding: '10px', backgroundColor: '#f0f0f0', borderRadius: '4px' }}>
                        <strong>{t('notifications.debug')}:</strong> {debugInfo}
                      </div>
                    )}
                  </div>
                )}
                {isSubscribed && (
                  <div>
                    <p>✅ {t('notifications.subscribed_message')}</p>
                    <button
                      className="button button-secondary"
                      onClick={unsubscribeFromNotifications}
                      disabled={isSubscribing}
                    >
                      {isSubscribing ? t('notifications.unsubscribing') : `📤 ${t('notifications.unsubscribe_button')}`}
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Test Notifications */}
        {isAdmin && isSubscribed && (
          <div style={{ marginTop: '20px' }}>
            <h4>{t('notifications.test_title')}</h4>
            <p>{t('notifications.test_description')}</p>
            <button
              className="button button-secondary"
              onClick={sendTestNotification}
              disabled={!!testStatus}
            >
              🧪 {t('notifications.send_test')}
            </button>
            {testStatus && <div style={{ marginTop: '10px', fontWeight: 'bold' }}>{testStatus}</div>}
          </div>
        )}

        {/* VAPID Configuration (Admin Only) */}
        {isAdmin && vapidStatus && (
          <div style={{ marginTop: '32px', paddingTop: '32px', borderTop: '1px solid #3a3a3a' }}>
            <h4>{t('notifications.vapid_title')}</h4>
            <div className="info-grid">
              <div className="info-item">
                <strong>{t('common.status')}:</strong> {vapidStatus.configured ? `✅ ${t('notifications.configured')}` : `❌ ${t('notifications.not_configured')}`}
              </div>
              <div className="info-item">
                <strong>{t('notifications.active_subscriptions')}:</strong> {vapidStatus.subscriptionCount}
              </div>
              <div className="info-item">
                <strong>{t('notifications.public_key')}:</strong>
                <code style={{ fontSize: '10px', wordBreak: 'break-all' }}>
                  {vapidStatus.publicKey ? vapidStatus.publicKey.substring(0, 50) + '...' : t('notifications.not_set')}
                </code>
              </div>
            </div>

            <div style={{ marginTop: '20px' }}>
              <label>
                <strong>{t('notifications.contact_email')}:</strong>
                <input
                  type="text"
                  value={vapidSubject}
                  onChange={(e) => setVapidSubject(e.target.value)}
                  placeholder="mailto:admin@example.com"
                  style={{ width: '100%', padding: '8px', marginTop: '5px' }}
                />
              </label>
              <button
                className="button button-primary"
                onClick={updateVapidSubject}
                disabled={isUpdatingSubject}
                style={{ marginTop: '10px' }}
              >
                {isUpdatingSubject ? t('common.updating') : t('notifications.update_contact_email')}
              </button>
            </div>
          </div>
        )}
      </div>
      )}

      {/* ========================================
          SECTION 3: Apprise Configuration (only shown if enabled)
          ======================================== */}
      {preferences.enableApprise && (
      <div className="settings-section">
        <h3>🔔 {t('notifications.apprise_config_title')}</h3>
        <p style={{ marginBottom: '20px', color: '#666' }}><Trans i18nKey="notifications.apprise_config_description" components={{ strong: <strong /> }} /></p>

        <div style={{
          backgroundColor: '#1e3a5f',
          border: '1px solid #2a5a8a',
          borderRadius: '8px',
          padding: '16px',
          marginBottom: '20px',
          fontSize: '14px',
          color: '#93c5fd'
        }}>
          <strong>ℹ️ {t('notifications.about_apprise')}:</strong> {t('notifications.apprise_info')}
        </div>

        <div>
          <label style={{ display: 'block', marginBottom: '8px', fontWeight: '600' }}>
            {t('notifications.service_urls_label')}
          </label>
          <p style={{ fontSize: '13px', color: '#9ca3af', marginBottom: '12px' }}>
            {t('notifications.service_urls_description')}
          </p>
          <ul style={{ fontSize: '13px', color: '#9ca3af', marginBottom: '12px', paddingLeft: '20px' }}>
            <li><code>discord://webhook_id/webhook_token</code> - {t('notifications.example_discord')}</li>
            <li><code>slack://token_a/token_b/token_c</code> - {t('notifications.example_slack')}</li>
            <li><code>mailto://user:pass@gmail.com</code> - {t('notifications.example_email')}</li>
            <li><code>tgram://bot_token/chat_id</code> - {t('notifications.example_telegram')}</li>
          </ul>
          <p style={{ fontSize: '13px', color: '#9ca3af', marginBottom: '12px' }}>
            {t('notifications.see_docs')} <a
              href="https://github.com/caronc/apprise#supported-notifications"
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: '#60a5fa', textDecoration: 'underline' }}
            >
              {t('notifications.apprise_docs_link')}
            </a> {t('notifications.full_list')}.
          </p>
          <textarea
            value={appriseUrls}
            onChange={(e) => setAppriseUrls(e.target.value)}
            placeholder="discord://webhook_id/webhook_token&#10;slack://token_a/token_b/token_c&#10;mailto://user:pass@gmail.com"
            rows={8}
            style={{
              width: '100%',
              padding: '12px',
              fontFamily: 'monospace',
              fontSize: '14px',
              border: '2px solid #3a3a3a',
              borderRadius: '6px',
              resize: 'vertical',
              backgroundColor: '#252535',
              color: '#e5e7eb'
            }}
          />
        </div>

        <div style={{ display: 'flex', gap: '12px', marginTop: '16px', alignItems: 'center' }}>
          <button
            className="button button-primary"
            onClick={saveAppriseUrls}
            disabled={isSavingApprise}
            style={{ minWidth: '150px' }}
          >
            {isSavingApprise ? t('common.saving') : `💾 ${t('notifications.save_config')}`}
          </button>
          <button
            className="button button-secondary"
            onClick={testAppriseConnection}
            disabled={!!appriseTestStatus}
          >
            🧪 {t('notifications.send_test')}
          </button>
          {appriseTestStatus && (
            <div style={{ fontWeight: 'bold', marginLeft: '12px' }}>{appriseTestStatus}</div>
          )}
        </div>

      </div>
      )}
    </div>
  );
};

export default NotificationsTab;
