import React, { useState, useEffect } from 'react';
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
    enabledChannels: [],
    enableDirectMessages: true,
    whitelist: ['Hi', 'Help'],
    blacklist: ['Test', 'Copy']
  });
  const [whitelistText, setWhitelistText] = useState('Hi\nHelp');
  const [blacklistText, setBlacklistText] = useState('Test\nCopy');
  const [isSavingPreferences, setIsSavingPreferences] = useState(false);

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
    // Check browser support
    if (!('Notification' in window)) {
      logger.warn('Push notifications not supported in this browser');
      return;
    }

    if (!('serviceWorker' in navigator)) {
      logger.warn('Service Workers not supported in this browser');
      return;
    }

    if (!('PushManager' in window)) {
      logger.warn('Push API not supported in this browser');
      return;
    }

    // Check permission
    setNotificationPermission(Notification.permission);

    // Check if already subscribed
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

      // Initialize all channels as enabled by default
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

      // If enabledChannels is empty, initialize with all channels
      if (response.enabledChannels.length === 0 && channels.length > 0) {
        response.enabledChannels = channels.map(c => c.id);
      }

      setPreferences(response);
      setWhitelistText(response.whitelist.join('\n'));
      setBlacklistText(response.blacklist.join('\n'));
    } catch (error) {
      logger.debug('No saved preferences, using defaults');
    }
  };

  const savePreferences = async () => {
    setIsSavingPreferences(true);
    try {
      const prefs: NotificationPreferences = {
        ...preferences,
        whitelist: whitelistText.split('\n').map(w => w.trim()).filter(w => w.length > 0),
        blacklist: blacklistText.split('\n').map(w => w.trim()).filter(w => w.length > 0)
      };

      await api.post('/api/push/preferences', prefs);
      setPreferences(prefs);
      logger.info('Notification preferences saved');
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

      // Get VAPID public key
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

      // Subscribe to push notifications
      const registration = await navigator.serviceWorker.ready;
      logger.info('Service worker ready, attempting subscription...');

      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource
      });

      logger.info('Push subscription created successfully');

      setDebugInfo('Sending subscription to backend...');
      logger.info('Push subscription created, sending to backend...');

      // Send subscription to backend
      const subscribeResult = await api.post('/api/push/subscribe', {
        subscription: {
          endpoint: subscription.endpoint,
          keys: {
            p256dh: arrayBufferToBase64(subscription.getKey('p256dh')!),
            auth: arrayBufferToBase64(subscription.getKey('auth')!)
          }
        }
      });

      logger.info('Subscribe result:', subscribeResult);
      setDebugInfo('Subscription saved! Reloading status...');

      setIsSubscribed(true);
      await loadVapidStatus();

      setDebugInfo('✅ Successfully subscribed to push notifications!');
      logger.info('Successfully subscribed to push notifications');

      setTimeout(() => setDebugInfo(''), 5000);
    } catch (error: any) {
      logger.error('Failed to subscribe to push notifications:', error);
      let errorMessage = 'Unknown error';

      if (error.message) {
        errorMessage = error.message;
      } else if (typeof error === 'string') {
        errorMessage = error;
      }

      setDebugInfo(`❌ Error: ${errorMessage}`);
      alert(`Failed to subscribe: ${errorMessage}`);
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
        // Unsubscribe from backend
        await api.post('/api/push/unsubscribe', {
          endpoint: subscription.endpoint
        });

        // Unsubscribe from browser
        await subscription.unsubscribe();
        setIsSubscribed(false);
        await loadVapidStatus();
        logger.info('Successfully unsubscribed from push notifications');
      }
    } catch (error) {
      logger.error('Failed to unsubscribe from push notifications:', error);
      alert('Failed to unsubscribe. Please try again.');
    } finally {
      setIsSubscribing(false);
    }
  };

  const updateVapidSubject = async () => {
    if (!vapidSubject || !vapidSubject.startsWith('mailto:')) {
      alert('VAPID subject must be an email address starting with mailto:');
      return;
    }

    setIsUpdatingSubject(true);

    try {
      await api.put('/api/push/vapid-subject', { subject: vapidSubject });
      await loadVapidStatus();
      alert('VAPID subject updated successfully');
    } catch (error) {
      logger.error('Failed to update VAPID subject:', error);
      alert('Failed to update VAPID subject');
    } finally {
      setIsUpdatingSubject(false);
    }
  };

  const sendTestNotification = async () => {
    setTestStatus('Sending...');

    try {
      const response = await api.post<{ sent: number; failed: number }>('/api/push/test', {});
      setTestStatus(`✅ Sent: ${response.sent}, Failed: ${response.failed}`);
      setTimeout(() => setTestStatus(''), 5000);
    } catch (error) {
      logger.error('Failed to send test notification:', error);
      setTestStatus('❌ Failed to send test notification');
      setTimeout(() => setTestStatus(''), 5000);
    }
  };

  // Helper function to convert URL-safe base64 to Uint8Array
  function urlBase64ToUint8Array(base64String: string): Uint8Array {
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding)
      .replace(/\-/g, '+')
      .replace(/_/g, '/');

    const rawData = window.atob(base64);
    const outputArray = new Uint8Array(rawData.length);

    for (let i = 0; i < rawData.length; ++i) {
      outputArray[i] = rawData.charCodeAt(i);
    }
    return outputArray;
  }

  // Helper function to convert ArrayBuffer to base64
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
      <h2>Push Notifications</h2>

      {/* HTTPS Warning */}
      {!isSecureContext && !isLocalhost && (
        <div className="settings-section" style={{ backgroundColor: '#f8d7da', color: '#721c24', padding: '15px', borderRadius: '8px', border: '1px solid #f5c6cb', marginBottom: '20px' }}>
          <h3 style={{ color: '#721c24' }}>⚠️ HTTPS Required</h3>
          <p>
            <strong>Push notifications are not available over HTTP.</strong>
          </p>
          <p>
            To enable push notifications, you must access MeshMonitor via:
          </p>
          <ul style={{ paddingLeft: '20px', marginLeft: '0' }}>
            <li><strong>HTTPS:</strong> Set up SSL certificates (recommended for production)</li>
            <li><strong>Localhost:</strong> Access via <code>http://localhost</code> for local testing</li>
          </ul>
          <p>
            Current connection: <strong>{window.location.protocol}//{window.location.host}</strong>
          </p>
        </div>
      )}

      {/* Browser Support Status */}
      <div className="settings-section">
        <h3>Browser Support</h3>
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
        <div className="settings-section" style={{ backgroundColor: '#fff3cd', color: '#856404', padding: '15px', borderRadius: '8px', border: '1px solid #ffc107' }}>
          <h3 style={{ color: '#856404' }}>📱 iOS Users: Installation Required</h3>
          <p>
            On iOS (iPhone/iPad), push notifications require HTTPS and PWA installation:
          </p>
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

      {/* Enable Notifications */}
      {isSupported && (
        <div className="settings-section">
          <h3>Setup Notifications</h3>
          <p>Follow these steps to enable push notifications:</p>

          {/* Step 1: Request Permission */}
          <div style={{ marginBottom: '20px' }}>
            <h4>Step 1: Enable Notifications</h4>
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
              <h4>Step 2: Subscribe to Notifications</h4>
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
        <div className="settings-section">
          <h3>Test Notifications</h3>
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

      {/* Notification Filtering Preferences */}
      {isSubscribed && (
        <div className="settings-section">
          <h3>Notification Preferences</h3>
          <p>Control which notifications you receive by selecting channels and filtering by keywords.</p>

          {/* Channel Selection */}
          <div style={{ marginBottom: '20px' }}>
            <h4>Enabled Channels</h4>
            <p>Select which channels should send you notifications:</p>
            {channels.length > 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {channels.map(channel => (
                  <label key={channel.id} style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <input
                      type="checkbox"
                      checked={preferences.enabledChannels.includes(channel.id)}
                      onChange={(e) => {
                        const checked = e.target.checked;
                        setPreferences(prev => ({
                          ...prev,
                          enabledChannels: checked
                            ? [...prev.enabledChannels, channel.id]
                            : prev.enabledChannels.filter(id => id !== channel.id)
                        }));
                      }}
                    />
                    <span>{channel.name || `Channel ${channel.id}`}</span>
                  </label>
                ))}
              </div>
            ) : (
              <p style={{ color: '#666', fontStyle: 'italic' }}>No channels available</p>
            )}
          </div>

          {/* Direct Messages Toggle */}
          <div style={{ marginBottom: '20px' }}>
            <h4>Direct Messages</h4>
            <label style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <input
                type="checkbox"
                checked={preferences.enableDirectMessages}
                onChange={(e) => {
                  setPreferences(prev => ({
                    ...prev,
                    enableDirectMessages: e.target.checked
                  }));
                }}
              />
              <span>Enable notifications for direct messages</span>
            </label>
          </div>

          {/* Whitelist */}
          <div style={{ marginBottom: '20px' }}>
            <h4>Whitelist (Always Notify)</h4>
            <p>Messages containing these words will always trigger a notification (one word per line, case-insensitive):</p>
            <textarea
              value={whitelistText}
              onChange={(e) => setWhitelistText(e.target.value)}
              placeholder="Enter words to always notify&#10;Example:&#10;Hi&#10;Help"
              rows={5}
              style={{
                width: '100%',
                padding: '8px',
                fontFamily: 'monospace',
                fontSize: '14px',
                border: '1px solid #ccc',
                borderRadius: '4px'
              }}
            />
          </div>

          {/* Blacklist */}
          <div style={{ marginBottom: '20px' }}>
            <h4>Blacklist (Silence Notifications)</h4>
            <p>Messages containing these words will never trigger a notification (one word per line, case-insensitive):</p>
            <textarea
              value={blacklistText}
              onChange={(e) => setBlacklistText(e.target.value)}
              placeholder="Enter words to silence&#10;Example:&#10;Test&#10;Copy"
              rows={5}
              style={{
                width: '100%',
                padding: '8px',
                fontFamily: 'monospace',
                fontSize: '14px',
                border: '1px solid #ccc',
                borderRadius: '4px'
              }}
            />
          </div>

          {/* Save Button */}
          <button
            className="button button-primary"
            onClick={savePreferences}
            disabled={isSavingPreferences}
          >
            {isSavingPreferences ? 'Saving...' : '💾 Save Preferences'}
          </button>
        </div>
      )}

      {/* VAPID Configuration (Admin Only) */}
      {isAdmin && vapidStatus && (
        <div className="settings-section">
          <h3>VAPID Configuration</h3>
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
            <p style={{ fontSize: '12px', marginTop: '5px', color: '#666' }}>
              This email is sent with push notification requests (required by web push protocol)
            </p>
          </div>
        </div>
      )}

      {!isSupported && (
        <div className="error-message">
          <p>❌ Push notifications are not supported in your browser.</p>
          <p>Please use a modern browser like Chrome, Edge, Firefox, or Safari 16.4+</p>
        </div>
      )}
    </div>
  );
};

export default NotificationsTab;
