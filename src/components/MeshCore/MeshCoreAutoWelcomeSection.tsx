import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useCsrfFetch } from '../../hooks/useCsrfFetch';
import { useToast } from '../ToastContainer';
import { useAuth } from '../../contexts/AuthContext';
import { useSaveBar } from '../../hooks/useSaveBar';
import { NumberInput } from '../common/NumberInput';
import { NumberInputScope } from '../common/NumberInputScope';
import { useNumberInputScope } from '../common/numberInputScopeContext';
import { ConfigSection } from '../shared/config/ConfigSection';

/**
 * MeshCore Auto Welcome (#6224). Parity with the Meshtastic AutoWelcomeSection:
 * greet a genuinely-new, named contact once. It TRANSMITS — a DM to a brand-new
 * node usually floods — so the hourly cap, hop gate and welcome-once guarantee
 * are load-bearing. Event-driven (no scheduler / no "run now").
 */
interface Props {
  baseUrl: string;
  sourceId: string;
}

interface AutoWelcomeSettings {
  enabled: boolean;
  message: string;
  target: string; // 'dm' or a channel index as a string
  waitForName: boolean;
  maxHops: number;
  delaySeconds: number;
  maxPerHour: number;
}

const DEFAULTS: AutoWelcomeSettings = {
  enabled: false,
  message: 'Welcome {NAME} to the mesh!',
  target: 'dm',
  waitForName: true,
  maxHops: 3,
  delaySeconds: 30,
  maxPerHour: 6,
};

export const MeshCoreAutoWelcomeSection: React.FC<Props> = ({ baseUrl, sourceId }) => {
  const { t } = useTranslation();
  const csrfFetch = useCsrfFetch();
  const { showToast } = useToast();
  const { hasPermission } = useAuth();
  const canWrite = hasPermission('automation', 'write');

  const [settings, setSettings] = useState<AutoWelcomeSettings>(DEFAULTS);
  const [initial, setInitial] = useState<AutoWelcomeSettings>(DEFAULTS);
  const [isSaving, setIsSaving] = useState(false);
  const loadedRef = useRef(false);
  const url = `${baseUrl}/api/sources/${sourceId}/meshcore/automation/auto-welcome`;

  const fetchData = useCallback(async () => {
    try {
      const res = await csrfFetch(url);
      if (!res.ok) return;
      const json = await res.json();
      const data = json?.data;
      if (!data?.settings || loadedRef.current) return;
      const s: AutoWelcomeSettings = { ...DEFAULTS, ...data.settings };
      setSettings(s);
      setInitial(s);
      loadedRef.current = true;
    } catch {
      // ignore; keep defaults
    }
  }, [csrfFetch, url]);

  useEffect(() => {
    loadedRef.current = false;
    void fetchData();
  }, [fetchData]);

  const hasChanges =
    settings.enabled !== initial.enabled ||
    settings.message !== initial.message ||
    settings.target !== initial.target ||
    settings.waitForName !== initial.waitForName ||
    settings.maxHops !== initial.maxHops ||
    settings.delaySeconds !== initial.delaySeconds ||
    settings.maxPerHour !== initial.maxPerHour;

  const handleSave = useCallback(async () => {
    setIsSaving(true);
    try {
      const res = await csrfFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enabled: settings.enabled,
          message: settings.message,
          target: settings.target,
          waitForName: settings.waitForName,
          maxHops: settings.maxHops,
          delaySeconds: settings.delaySeconds,
          maxPerHour: settings.maxPerHour,
        }),
      });
      if (!res.ok) {
        if (res.status === 403) {
          showToast(t('automation.insufficient_permissions', 'Insufficient permissions'), 'error');
          return;
        }
        const body = await res.json().catch(() => null);
        showToast(body?.error || t('automation.settings_save_failed', 'Failed to save settings'), 'error');
        return;
      }
      setInitial(settings);
      showToast(t('meshcore.automation.auto_welcome.saved', 'Auto Welcome settings saved'), 'success');
    } catch (err) {
      console.error('Failed to save MeshCore auto-welcome settings:', err);
      showToast(t('automation.settings_save_failed', 'Failed to save settings'), 'error');
    } finally {
      setIsSaving(false);
    }
  }, [settings, url, csrfFetch, showToast, t]);

  const handleDismiss = useCallback(() => setSettings(initial), [initial]);

  const numberScope = useNumberInputScope();
  useSaveBar({
    numberScope,
    id: 'meshcore-auto-welcome',
    sectionName: t('meshcore.automation.auto_welcome.title', 'Auto Welcome'),
    hasChanges,
    isSaving,
    onSave: handleSave,
    onDismiss: handleDismiss,
  });

  const update = <K extends keyof AutoWelcomeSettings>(key: K, value: AutoWelcomeSettings[K]) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
  };

  const disabled = !settings.enabled || !canWrite;
  const targetMode = settings.target === 'dm' ? 'dm' : 'channel';
  const channelIdx = settings.target === 'dm' ? 0 : (Number.parseInt(settings.target, 10) || 0);

  return (
    <NumberInputScope scope={numberScope}>
      <ConfigSection
        title={t('meshcore.automation.auto_welcome.title', 'Auto Welcome')}
        enabled={settings.enabled}
        onEnabledChange={(v) => update('enabled', v)}
        enableLabel={t('meshcore.automation.auto_welcome.title', 'Auto Welcome')}
        docsUrl="https://meshmonitor.org/features/automation#auto-welcome"
        canWrite={canWrite}
        description={t(
          'meshcore.automation.auto_welcome.description',
          'Greet each newly discovered node once with a short message. A DM to a brand-new node usually floods the mesh (no known path yet), so an hourly cap and a hop limit keep it in check. Each node is welcomed only once.',
        )}
      >
        <div className="setting-item">
          <label htmlFor="mcWelcomeMessage">
            {t('meshcore.automation.auto_welcome.message', 'Welcome message')}
            <span className="setting-description">
              {t('meshcore.automation.auto_welcome.message_description', 'Use {NAME} for the new node’s name. Keep it short — one LoRa packet.')}
            </span>
          </label>
          <input
            id="mcWelcomeMessage"
            type="text"
            maxLength={200}
            className="setting-input"
            value={settings.message}
            onChange={(e) => update('message', e.target.value)}
            disabled={disabled}
          />
        </div>

        <div className="setting-item">
          <label htmlFor="mcWelcomeTargetMode">
            {t('meshcore.automation.auto_welcome.target', 'Send as')}
            <span className="setting-description">
              {t('meshcore.automation.auto_welcome.target_description', 'A direct message reaches only the new node; a channel post greets it publicly.')}
            </span>
          </label>
          <select
            id="mcWelcomeTargetMode"
            className="setting-input"
            value={targetMode}
            onChange={(e) => update('target', e.target.value === 'dm' ? 'dm' : String(channelIdx))}
            disabled={disabled}
          >
            <option value="dm">{t('meshcore.automation.auto_welcome.target_dm', 'Direct message to the new node')}</option>
            <option value="channel">{t('meshcore.automation.auto_welcome.target_channel', 'Channel post')}</option>
          </select>
        </div>

        {targetMode === 'channel' && (
          <div className="setting-item">
            <label htmlFor="mcWelcomeChannelIdx">
              {t('meshcore.automation.auto_welcome.channel_index', 'Channel index')}
            </label>
            <NumberInput
              id="mcWelcomeChannelIdx"
              min={0}
              max={63}
              integer
              value={channelIdx}
              onChange={(v) => update('target', String(v ?? 0))}
              disabled={disabled}
              className="setting-input"
            />
          </div>
        )}

        <div className="setting-item">
          <label htmlFor="mcWelcomeWaitForName" className="setting-checkbox-label">
            <input
              id="mcWelcomeWaitForName"
              type="checkbox"
              checked={settings.waitForName}
              onChange={(e) => update('waitForName', e.target.checked)}
              disabled={disabled}
            />
            {t('meshcore.automation.auto_welcome.wait_for_name', 'Wait for the node’s name before greeting')}
            <span className="setting-description">
              {t('meshcore.automation.auto_welcome.wait_for_name_description', 'MeshCore often reports a new node before its name arrives. Leave on to avoid greeting an unnamed node.')}
            </span>
          </label>
        </div>

        <div className="setting-item">
          <label htmlFor="mcWelcomeMaxPerHour">
            {t('meshcore.automation.auto_welcome.max_per_hour', 'Max welcomes per hour')}
            <span className="setting-description">
              {t('meshcore.automation.auto_welcome.max_per_hour_description', 'A safety cap. Welcomes beyond this are dropped, not queued, so a burst of new nodes can’t flood the mesh (1–60).')}
            </span>
          </label>
          <NumberInput
            id="mcWelcomeMaxPerHour"
            min={1}
            max={60}
            integer
            value={settings.maxPerHour}
            onChange={(v) => update('maxPerHour', v)}
            disabled={disabled}
            className="setting-input"
          />
        </div>

        <div className="setting-item">
          <label htmlFor="mcWelcomeMaxHops">
            {t('meshcore.automation.auto_welcome.max_hops', 'Maximum hops')}
            <span className="setting-description">
              {t('meshcore.automation.auto_welcome.max_hops_description', 'Skip a node farther than this many hops. A node with no known path is still greeted (0–7).')}
            </span>
          </label>
          <NumberInput
            id="mcWelcomeMaxHops"
            min={0}
            max={7}
            integer
            value={settings.maxHops}
            onChange={(v) => update('maxHops', v)}
            disabled={disabled}
            className="setting-input"
          />
        </div>

        <div className="setting-item">
          <label htmlFor="mcWelcomeDelay">
            {t('meshcore.automation.auto_welcome.delay', 'Pre-send delay (seconds)')}
            <span className="setting-description">
              {t('meshcore.automation.auto_welcome.delay_description', 'Wait this long after discovery so the new node settles into receive mode before the greeting (0–600).')}
            </span>
          </label>
          <NumberInput
            id="mcWelcomeDelay"
            min={0}
            max={600}
            integer
            value={settings.delaySeconds}
            onChange={(v) => update('delaySeconds', v)}
            disabled={disabled}
            className="setting-input"
          />
        </div>
      </ConfigSection>
    </NumberInputScope>
  );
};
