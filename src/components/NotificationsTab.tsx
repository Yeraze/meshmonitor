import React, { useState, useEffect, useRef } from 'react';
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
  whitelist: string[];
  blacklist: string[];
}

interface NotificationsTabProps {
  isAdmin: boolean;
}

const NotificationsTab: React.FC<NotificationsTabProps> = ({ isAdmin }) => {
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
    whitelist: ['Hi', 'Help'],
    blacklist: ['Test', 'Copy']
  });
  const [whitelistText, setWhitelistText] = useState('Hi\nHelp');
  const [blacklistText, setBlacklistText] = useState('Test\nCopy');
  const [isSavingPreferences, setIsSavingPreferences] = useState(false);

  // Apprise configuration
  const [appriseUrls, setAppriseUrls] = useState('');
  const [isSavingApprise, setIsSavingApprise] = useState(false);
  const [appriseTestStatus, setAppriseTestStatus] = useState('');

  // Track timeouts for cleanup on unmount
  const timeoutsRef = useRef<NodeJS.Timeout[]>([]);

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
  }, []);

  // Load preferences after channels are loaded
  useEffect(() => {
    if (channels.length > 0) {
      loadPreferences();
    }
  }, [channels.length]);

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

      // Load Apprise URLs if Apprise is enabled
      if (response.enableApprise) {
        loadAppriseUrls();
      }
    } catch (error) {
      logger.debug('No saved preferences, using defaults');
    }
  };

  const loadAppriseUrls = async () => {
    try {
      const response = await api.get<{ urls: string[] }>('/api/apprise/urls');
      setAppriseUrls(response.urls.join('\n'));
    } catch (error) {
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
      alert('Failed to save notification preferences');
    } finally {
      setIsSavingPreferences(false);
    }
  };

  const requestNotificationPermission = async () => {
    if (!('Notification' in window)) {
      alert('Push notifications are not supported in your browser');
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
      alert('Failed to request notification permission. Please try again.');
    }
  };

  const subscribeToNotifications = async () => {
    if (notificationPermission !== 'granted') {
      alert('Please grant notification permission first');
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
      alert(`Failed to subscribe to push notifications: ${error.message}`);
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
      alert('Failed to unsubscribe from push notifications');
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
      alert('Failed to update contact email');
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
    setAppriseTestStatus('Testing connection...');
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
      <h2>Notifications</h2>

      {/* ========================================
          SECTION 1: Notification Services & Filtering (Top)
          ======================================== */}
      <div className="settings-section">
        <h3>🔔 Notification Services</h3>
        <p style={{ marginBottom: '24px', color: '#666' }}>
          Enable or disable notification services. Both services use the same filtering preferences below.
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
                  📱 Web Push Notifications
                </div>
                <div style={{ fontSize: '12px', color: '#9ca3af', marginTop: '4px' }}>
                  Browser push notifications (requires HTTPS)
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
                  🔔 Apprise Notifications
                </div>
                <div style={{ fontSize: '12px', color: '#9ca3af', marginTop: '4px' }}>
                  Discord, Slack, Email, SMS, etc. (no HTTPS required)
                </div>
              </div>
            </label>
          </div>
        </div>

        {/* Filtering Section */}
        <h4 style={{ marginTop: '32px', marginBottom: '16px' }}>⚙️ Notification Filtering</h4>
        <p style={{ marginBottom: '24px', color: '#666', fontSize: '14px' }}>
          These filters apply to <strong>both Web Push and Apprise</strong> notifications.
        </p>

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
                <span>📢</span> Notification Sources
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
                  <span style={{ fontWeight: '500' }}>💬 Direct Messages</span>
                </label>
              </div>

              {/* Channel Selection */}
              <div style={{
                backgroundColor: '#252535',
                borderRadius: '6px',
                padding: '12px'
              }}>
                <div style={{ fontWeight: '600', marginBottom: '8px' }}>Channels:</div>
                {channels.length === 0 ? (
                  <p style={{ fontSize: '14px', color: '#999', margin: 0 }}>No channels available</p>
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
                        <span style={{ fontSize: '14px' }}>{channel.name || `Channel ${channel.id}`}</span>
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
                <span>🔤</span> Keyword Filtering
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
                  <span>✅</span> Whitelist (Always Notify)
                </label>
                <p style={{ fontSize: '13px', color: '#9ca3af', marginBottom: '8px', marginTop: 0 }}>
                  Messages with these words will <strong>always</strong> send a notification (one per line):
                </p>
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
                  <span>🚫</span> Blacklist (Silence)
                </label>
                <p style={{ fontSize: '13px', color: '#9ca3af', marginBottom: '8px', marginTop: 0 }}>
                  Messages with these words will <strong>never</strong> send a notification (one per line):
                </p>
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
          <strong>ℹ️ Filter Priority:</strong> Whitelist (highest) → Blacklist → Channel/DM settings.
          All matching is case-insensitive and checks for substrings.
        </div>

        {/* Save Button */}
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button
            className="button button-primary"
            onClick={savePreferences}
            disabled={isSavingPreferences}
            style={{ minWidth: '150px' }}
          >
            {isSavingPreferences ? 'Saving...' : '💾 Save Preferences'}
          </button>
        </div>
      </div>

      {/* ========================================
          SECTION 2: Web Push Configuration (only shown if enabled)
          ======================================== */}
      {preferences.enableWebPush && (
      <div className="settings-section">
        <h3>📱 Web Push Configuration</h3>

        {/* HTTPS Warning */}
        {!isSecureContext && !isLocalhost && (
          <div style={{ backgroundColor: '#f8d7da', color: '#721c24', padding: '15px', borderRadius: '8px', border: '1px solid #f5c6cb', marginBottom: '20px' }}>
            <h4 style={{ color: '#721c24', marginTop: 0 }}>⚠️ HTTPS Required</h4>
            <p>
              <strong>Push notifications are not available over HTTP.</strong>
            </p>
            <p>To enable push notifications, you must access MeshMonitor via:</p>
            <ul style={{ paddingLeft: '20px', marginLeft: '0' }}>
              <li><strong>HTTPS:</strong> Set up SSL certificates (recommended for production)</li>
              <li><strong>Localhost:</strong> Access via <code>http://localhost</code> for local testing</li>
            </ul>
            <p>
              Current connection: <strong>{window.location.protocol}//{window.location.host}</strong>
            </p>
            <p style={{ marginTop: '12px', paddingTop: '12px', borderTop: '1px solid #f5c6cb' }}>
              <strong>Need help setting up HTTPS?</strong><br />
              Check out our <a
                href="https://github.com/Yeraze/meshmonitor/blob/main/docs/configuration/duckdns-https.md"
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: '#721c24', textDecoration: 'underline' }}
              >
                beginner-friendly guide to setting up free HTTPS with DuckDNS
              </a>.
            </p>
          </div>
        )}

        {/* Browser Support */}
        <div style={{ marginBottom: '20px' }}>
          <h4>Browser Support</h4>
          <div className="info-grid">
            <div className="info-item">
              <strong>Notifications API:</strong> {('Notification' in window) ? '✅ Supported' : '❌ Not Supported'}
            </div>
            <div className="info-item">
              <strong>Service Workers:</strong> {('serviceWorker' in navigator) ? '✅ Supported' : '❌ Not Supported'}
            </div>
            <div className="info-item">
              <strong>Push API:</strong> {('PushManager' in window) ? '✅ Supported' : '❌ Not Supported'}
            </div>
            <div className="info-item">
              <strong>PWA Installed:</strong> {isPWAInstalled ? '✅ Yes' : '⚠️ No (add to home screen for iOS)'}
            </div>
            <div className="info-item">
              <strong>Permission:</strong> {
                notificationPermission === 'granted' ? '✅ Granted' :
                notificationPermission === 'denied' ? '❌ Denied' :
                '⚠️ Not Requested'
              }
            </div>
            <div className="info-item">
              <strong>Subscription:</strong> {isSubscribed ? '✅ Subscribed' : '⚠️ Not Subscribed'}
            </div>
          </div>
        </div>

        {/* iOS Instructions */}
        {!isPWAInstalled && (
          <div style={{ backgroundColor: '#fff3cd', color: '#856404', padding: '15px', borderRadius: '8px', border: '1px solid #ffc107', marginBottom: '20px' }}>
            <h4 style={{ color: '#856404', marginTop: 0 }}>📱 iOS Users: Installation Required</h4>
            <p>On iOS (iPhone/iPad), push notifications require HTTPS and PWA installation:</p>
            <ol style={{ paddingLeft: '20px', marginLeft: '0' }}>
              <li><strong>HTTPS Required:</strong> Access MeshMonitor via HTTPS (e.g., https://your-server.com)</li>
              <li>Open MeshMonitor in Safari</li>
              <li>Tap the Share button (square with arrow)</li>
              <li>Scroll down and tap "Add to Home Screen"</li>
              <li>Open MeshMonitor from your home screen</li>
              <li>Return here to enable notifications</li>
            </ol>
          </div>
        )}

        {/* Setup Notifications */}
        {isSupported && (
          <div>
            <h4>Setup Notifications</h4>
            <p>Follow these steps to enable push notifications:</p>

            {/* Step 1: Request Permission */}
            <div style={{ marginBottom: '20px' }}>
              <h5>Step 1: Enable Notifications</h5>
              {notificationPermission === 'default' && (
                <div>
                  <p>Grant permission for this site to show notifications.</p>
                  <button
                    className="button button-primary"
                    onClick={requestNotificationPermission}
                  >
                    🔔 Enable Notifications
                  </button>
                </div>
              )}
              {notificationPermission === 'granted' && (
                <p>✅ Notification permission granted</p>
              )}
              {notificationPermission === 'denied' && (
                <div className="error-message">
                  <p>❌ Notification permission denied. Please enable notifications in your browser settings.</p>
                  <p><strong>Chrome/Edge:</strong> Click the lock icon in the address bar → Site settings → Notifications</p>
                  <p><strong>Safari:</strong> Safari → Settings → Websites → Notifications</p>
                </div>
              )}
            </div>

            {/* Step 2: Subscribe */}
            {notificationPermission === 'granted' && (
              <div style={{ marginBottom: '20px' }}>
                <h5>Step 2: Subscribe to Notifications</h5>
                {!isSubscribed && (
                  <div>
                    <p>Subscribe to receive push notifications for new messages.</p>
                    <button
                      className="button button-primary"
                      onClick={subscribeToNotifications}
                      disabled={isSubscribing}
                    >
                      {isSubscribing ? 'Subscribing...' : '📥 Subscribe to Notifications'}
                    </button>
                    {debugInfo && (
                      <div style={{ marginTop: '10px', padding: '10px', backgroundColor: '#f0f0f0', borderRadius: '4px' }}>
                        <strong>Debug:</strong> {debugInfo}
                      </div>
                    )}
                  </div>
                )}
                {isSubscribed && (
                  <div>
                    <p>✅ You are subscribed to push notifications!</p>
                    <button
                      className="button button-secondary"
                      onClick={unsubscribeFromNotifications}
                      disabled={isSubscribing}
                    >
                      {isSubscribing ? 'Unsubscribing...' : '📤 Unsubscribe'}
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
            <h4>Test Notifications</h4>
            <p>Send a test notification to verify everything is working.</p>
            <button
              className="button button-secondary"
              onClick={sendTestNotification}
              disabled={!!testStatus}
            >
              🧪 Send Test Notification
            </button>
            {testStatus && <div style={{ marginTop: '10px', fontWeight: 'bold' }}>{testStatus}</div>}
          </div>
        )}

        {/* VAPID Configuration (Admin Only) */}
        {isAdmin && vapidStatus && (
          <div style={{ marginTop: '32px', paddingTop: '32px', borderTop: '1px solid #3a3a3a' }}>
            <h4>VAPID Configuration (Admin)</h4>
            <div className="info-grid">
              <div className="info-item">
                <strong>Status:</strong> {vapidStatus.configured ? '✅ Configured' : '❌ Not Configured'}
              </div>
              <div className="info-item">
                <strong>Active Subscriptions:</strong> {vapidStatus.subscriptionCount}
              </div>
              <div className="info-item">
                <strong>Public Key:</strong>
                <code style={{ fontSize: '10px', wordBreak: 'break-all' }}>
                  {vapidStatus.publicKey ? vapidStatus.publicKey.substring(0, 50) + '...' : 'Not set'}
                </code>
              </div>
            </div>

            <div style={{ marginTop: '20px' }}>
              <label>
                <strong>Contact Email (VAPID Subject):</strong>
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
                {isUpdatingSubject ? 'Updating...' : 'Update Contact Email'}
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
        <h3>🔔 Apprise Configuration</h3>
        <p style={{ marginBottom: '20px', color: '#666' }}>
          Configure Apprise to send notifications to external services like Discord, Slack, Email, SMS, and more.
          Apprise works over HTTP, so <strong>no HTTPS required</strong>!
        </p>

        <div style={{
          backgroundColor: '#1e3a5f',
          border: '1px solid #2a5a8a',
          borderRadius: '8px',
          padding: '16px',
          marginBottom: '20px',
          fontSize: '14px',
          color: '#93c5fd'
        }}>
          <strong>ℹ️ About Apprise:</strong> Apprise supports 100+ notification services including Discord, Slack, Telegram,
          Microsoft Teams, Email (SMTP), SMS, and many more. Enter one service URL per line below.
        </div>

        <div>
          <label style={{ display: 'block', marginBottom: '8px', fontWeight: '600' }}>
            Notification Service URLs
          </label>
          <p style={{ fontSize: '13px', color: '#9ca3af', marginBottom: '12px' }}>
            Enter Apprise notification URLs (one per line). Examples:
          </p>
          <ul style={{ fontSize: '13px', color: '#9ca3af', marginBottom: '12px', paddingLeft: '20px' }}>
            <li><code>discord://webhook_id/webhook_token</code> - Discord webhook</li>
            <li><code>slack://token_a/token_b/token_c</code> - Slack webhook</li>
            <li><code>mailto://user:pass@gmail.com</code> - Email via Gmail</li>
            <li><code>tgram://bot_token/chat_id</code> - Telegram</li>
          </ul>
          <p style={{ fontSize: '13px', color: '#9ca3af', marginBottom: '12px' }}>
            See <a
              href="https://github.com/caronc/apprise#supported-notifications"
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: '#60a5fa', textDecoration: 'underline' }}
            >
              Apprise documentation
            </a> for full list of supported services.
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
            {isSavingApprise ? 'Saving...' : '💾 Save Configuration'}
          </button>
          <button
            className="button button-secondary"
            onClick={testAppriseConnection}
            disabled={!!appriseTestStatus}
          >
            🧪 Test Connection
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
