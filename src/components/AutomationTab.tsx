import React from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import '../styles/settings.css';
import { SaveBarGroup } from '../contexts/SaveBarContext';
import { useAutomation } from '../contexts/AutomationContext';
import { useSettings } from '../contexts/SettingsContext';
import { DeviceInfo, Channel } from '../types/device';
import SectionNav from './SectionNav';
import { AutomationTokenReference } from './AutomationTokenReference';
import { buildMeshtasticTokenGroups } from './meshtasticAutomationTokens';
import AirtimeCutoffSection from './AirtimeCutoffSection';
import AutoWelcomeSection from './AutoWelcomeSection';
import AutoFavoriteSection from './AutoFavoriteSection';
import AutoTracerouteSection from './AutoTracerouteSection';
import AutoLocalStatsSection from './AutoLocalStatsSection';
import AutoPingSection from './AutoPingSection';
import AutoHeapManagementSection from './AutoHeapManagementSection';
import RemoteAdminScannerSection from './RemoteAdminScannerSection';
import AutoTimeSyncSection from './AutoTimeSyncSection';
import AutoAcknowledgeSection from './AutoAcknowledgeSection';
import AutoAnnounceSection from './AutoAnnounceSection';
import AutoResponderSection from './AutoResponderSection';
import AutoKeyManagementSection from './AutoKeyManagementSection';
import TimerTriggersSection from './TimerTriggersSection';
import GeofenceTriggersSection from './GeofenceTriggersSection';
import AutoDeleteByDistanceSection from './AutoDeleteByDistanceSection';
import IgnoredNodesSection from './IgnoredNodesSection';

interface AutomationTabProps {
  baseUrl: string;
  channels: Channel[];
  nodes: DeviceInfo[];
  currentNodeId: string;
}

/**
 * AutomationTab hosts the per-source (Meshtastic) automation settings —
 * ~18 Auto*Section components under a shared SectionNav + SaveBarGroup.
 * All automation state comes from AutomationContext (useAutomation()); only
 * shared App state (baseUrl/channels/nodes/currentNodeId) is threaded as
 * props. Extracted from the inline `activeTab === 'automation'` render
 * block in App.tsx (#3962 5.4 PR6) — behavior-preserving.
 */
const AutomationTab: React.FC<AutomationTabProps> = ({ baseUrl, channels, nodes, currentNodeId }) => {
  const { t } = useTranslation();
  const {
    tracerouteIntervalMinutes,
    remoteLocalStatsIntervalMinutes,
    setTracerouteIntervalMinutes,
    setRemoteLocalStatsIntervalMinutes,
  } = useSettings();
  const {
    autoAckEnabled, setAutoAckEnabled,
    autoAckRegex, setAutoAckRegex,
    autoAckMessage, setAutoAckMessage,
    autoAckMessageDirect, setAutoAckMessageDirect,
    autoAckChannels, setAutoAckChannels,
    autoAckSkipIncompleteNodes, setAutoAckSkipIncompleteNodes,
    autoAckIgnoredNodes, setAutoAckIgnoredNodes,
    autoAckMatrix, setAutoAckMatrix,
    autoAckCooldownSeconds, setAutoAckCooldownSeconds,
    autoAckPreSendDelaySeconds, setAutoAckPreSendDelaySeconds,
    autoAckMaxAttempts, setAutoAckMaxAttempts,
    autoAckTestMessages, setAutoAckTestMessages,
    autoAnnounceEnabled, setAutoAnnounceEnabled,
    autoAnnounceIntervalHours, setAutoAnnounceIntervalHours,
    autoAnnounceMessage, setAutoAnnounceMessage,
    autoAnnounceChannelIndexes, setAutoAnnounceChannelIndexes,
    autoAnnounceOnStart, setAutoAnnounceOnStart,
    autoAnnounceUseSchedule, setAutoAnnounceUseSchedule,
    autoAnnounceSchedule, setAutoAnnounceSchedule,
    autoAnnounceNodeInfoEnabled, setAutoAnnounceNodeInfoEnabled,
    autoAnnounceNodeInfoChannels, setAutoAnnounceNodeInfoChannels,
    autoAnnounceNodeInfoDelaySeconds, setAutoAnnounceNodeInfoDelaySeconds,
    autoWelcomeEnabled, setAutoWelcomeEnabled,
    autoWelcomeMessage, setAutoWelcomeMessage,
    autoWelcomeTarget, setAutoWelcomeTarget,
    autoWelcomeWaitForName, setAutoWelcomeWaitForName,
    autoWelcomeMaxHops, setAutoWelcomeMaxHops,
    autoWelcomeDelay, setAutoWelcomeDelay,
    autoResponderEnabled, setAutoResponderEnabled,
    autoResponderTriggers, setAutoResponderTriggers,
    autoResponderSkipIncompleteNodes, setAutoResponderSkipIncompleteNodes,
    autoKeyManagementEnabled, setAutoKeyManagementEnabled,
    autoKeyManagementIntervalMinutes, setAutoKeyManagementIntervalMinutes,
    autoKeyManagementMaxExchanges, setAutoKeyManagementMaxExchanges,
    autoKeyManagementAutoPurge, setAutoKeyManagementAutoPurge,
    autoKeyManagementImmediatePurge, setAutoKeyManagementImmediatePurge,
    timerTriggers, setTimerTriggers,
    geofenceTriggers, setGeofenceTriggers,
    autoDeleteByDistanceEnabled, setAutoDeleteByDistanceEnabled,
    autoDeleteByDistanceIntervalHours, setAutoDeleteByDistanceIntervalHours,
    autoDeleteByDistanceThresholdKm, setAutoDeleteByDistanceThresholdKm,
    autoDeleteByDistanceLat, setAutoDeleteByDistanceLat,
    autoDeleteByDistanceLon, setAutoDeleteByDistanceLon,
    autoDeleteByDistanceAction, setAutoDeleteByDistanceAction,
  } = useAutomation();

  return (
    <SaveBarGroup id="automation">
      <div className="settings-tab">
        <SectionNav
          items={[
            { id: 'airtime-cutoff', label: t('automation.airtime_cutoff.title', 'Cutoff Airtime Utilization Threshold') },
            { id: 'auto-welcome', label: t('automation.welcome.title', 'Auto Welcome') },
            { id: 'auto-favorite', label: t('automation.auto_favorite.title', 'Auto Favorite') },
            { id: 'auto-traceroute', label: t('automation.traceroute.title', 'Auto Traceroute') },
            { id: 'auto-localstats', label: t('automation.auto_localstats.title', 'Auto Remote LocalStats') },
            { id: 'auto-ping', label: t('automation.auto_ping.title', 'Auto Ping') },
            { id: 'auto-heap-management', label: t('automation.auto_heap.title', 'Auto Heap Management') },
            { id: 'remote-admin-scanner', label: t('automation.remote_admin_scanner.title', 'Remote Admin Scanner') },
            { id: 'auto-time-sync', label: t('automation.time_sync.title', 'Auto Time Sync') },
            { id: 'auto-acknowledge', label: t('automation.acknowledge.title', 'Auto Acknowledge') },
            { id: 'auto-announce', label: t('automation.announce.title', 'Auto Announce') },
            { id: 'auto-responder', label: t('automation.auto_responder.title', 'Auto Responder') },
            { id: 'auto-key-management', label: t('automation.auto_key_management.title', 'Auto Key Management') },
            { id: 'timer-triggers', label: t('automation.timer_triggers.title', 'Timer Triggers') },
            { id: 'geofence-triggers', label: t('automation.geofence_triggers.title', 'Geofence Triggers') },
            { id: 'auto-delete-by-distance', label: t('automation.distance_delete.title', 'Auto Delete by Distance') },
            { id: 'ignored-nodes', label: t('automation.ignored_nodes.title', 'Ignored Nodes') },
          ]}
        />
        <div className="settings-content">
          <AutomationTokenReference
            title={t('automation.tokens.title', 'Available message tokens')}
            intro={t(
              'automation.tokens.intro',
              'These placeholders are substituted in the message templates below. Reply tokens only expand when responding to a received message.',
            )}
            groups={buildMeshtasticTokenGroups({
              replyTitle: t('automation.tokens.reply_title', 'When replying (Auto-Acknowledge, Auto-Responder)'),
              replyNote: t('automation.tokens.reply_note', 'Resolved from the message that triggered the reply.'),
              globalTitle: t('automation.tokens.global_title', 'Available everywhere'),
              globalNote: t('automation.tokens.global_note', 'Also work in Auto-Announce and Auto-Welcome.'),
            })}
            footer={
              <>
                {/* eslint-disable-line meshmonitor-ui/no-hardcoded-ui-glyph -- #3962 5.4 PR6: verbatim move from App.tsx (which predates this components/-scoped rule); UiIcon migration out of scope for this extraction */}💡 {t('automation.tokens.engine_tip', 'Want maximum flexibility? Try the')}{' '}
                <Link to="/automations" style={{ color: 'var(--ctp-mauve)', fontWeight: 'bold' }}>
                  {t('automation.engine_link', 'Automation Engine')}
                </Link>{' '}
                {t('automation.tokens.engine_tip2', '— build global “when this happens, do that” workflows across every source.')}
              </>
            }
          />
          <div id="airtime-cutoff">
            <AirtimeCutoffSection baseUrl={baseUrl} />
          </div>
          <div id="auto-welcome">
            <AutoWelcomeSection
              enabled={autoWelcomeEnabled}
              message={autoWelcomeMessage}
              target={autoWelcomeTarget}
              waitForName={autoWelcomeWaitForName}
              maxHops={autoWelcomeMaxHops}
              delay={autoWelcomeDelay}
              channels={channels}
              baseUrl={baseUrl}
              onEnabledChange={setAutoWelcomeEnabled}
              onMessageChange={setAutoWelcomeMessage}
              onTargetChange={setAutoWelcomeTarget}
              onWaitForNameChange={setAutoWelcomeWaitForName}
              onMaxHopsChange={setAutoWelcomeMaxHops}
              onDelayChange={setAutoWelcomeDelay}
            />
          </div>
          <div id="auto-favorite">
            <AutoFavoriteSection baseUrl={baseUrl} />
          </div>
          <div id="auto-traceroute">
            <AutoTracerouteSection
              intervalMinutes={tracerouteIntervalMinutes}
              baseUrl={baseUrl}
              onIntervalChange={setTracerouteIntervalMinutes}
            />
          </div>
          <div id="auto-localstats">
            <AutoLocalStatsSection
              intervalMinutes={remoteLocalStatsIntervalMinutes}
              baseUrl={baseUrl}
              onIntervalChange={setRemoteLocalStatsIntervalMinutes}
            />
          </div>
          <div id="auto-ping">
            <AutoPingSection
              baseUrl={baseUrl}
            />
          </div>
          <div id="auto-heap-management">
            <AutoHeapManagementSection baseUrl={baseUrl} />
          </div>
          <div id="remote-admin-scanner">
            <RemoteAdminScannerSection
              baseUrl={baseUrl}
            />
          </div>
          <div id="auto-time-sync">
            <AutoTimeSyncSection
              baseUrl={baseUrl}
            />
          </div>
          <div id="auto-acknowledge">
            <AutoAcknowledgeSection
              enabled={autoAckEnabled}
              regex={autoAckRegex}
              message={autoAckMessage}
              messageDirect={autoAckMessageDirect}
              channels={channels}
              enabledChannels={autoAckChannels}
              skipIncompleteNodes={autoAckSkipIncompleteNodes}
              ignoredNodes={autoAckIgnoredNodes}
              matrix={autoAckMatrix}
              testMessages={autoAckTestMessages}
              cooldownSeconds={autoAckCooldownSeconds}
              onCooldownSecondsChange={setAutoAckCooldownSeconds}
              preSendDelaySeconds={autoAckPreSendDelaySeconds}
              onPreSendDelaySecondsChange={setAutoAckPreSendDelaySeconds}
              maxAttempts={autoAckMaxAttempts}
              onMaxAttemptsChange={setAutoAckMaxAttempts}
              baseUrl={baseUrl}
              onEnabledChange={setAutoAckEnabled}
              onRegexChange={setAutoAckRegex}
              onMessageChange={setAutoAckMessage}
              onMessageDirectChange={setAutoAckMessageDirect}
              onChannelsChange={setAutoAckChannels}
              onSkipIncompleteNodesChange={setAutoAckSkipIncompleteNodes}
              onIgnoredNodesChange={setAutoAckIgnoredNodes}
              onMatrixChange={setAutoAckMatrix}
              onTestMessagesChange={setAutoAckTestMessages}
            />
          </div>
          <div id="auto-announce">
            <AutoAnnounceSection
              enabled={autoAnnounceEnabled}
              intervalHours={autoAnnounceIntervalHours}
              message={autoAnnounceMessage}
              channelIndexes={autoAnnounceChannelIndexes}
              announceOnStart={autoAnnounceOnStart}
              useSchedule={autoAnnounceUseSchedule}
              schedule={autoAnnounceSchedule}
              channels={channels}
              baseUrl={baseUrl}
              onEnabledChange={setAutoAnnounceEnabled}
              onIntervalChange={setAutoAnnounceIntervalHours}
              onMessageChange={setAutoAnnounceMessage}
              onChannelIndexesChange={setAutoAnnounceChannelIndexes}
              onAnnounceOnStartChange={setAutoAnnounceOnStart}
              onUseScheduleChange={setAutoAnnounceUseSchedule}
              onScheduleChange={setAutoAnnounceSchedule}
              nodeInfoEnabled={autoAnnounceNodeInfoEnabled}
              nodeInfoChannels={autoAnnounceNodeInfoChannels}
              nodeInfoDelaySeconds={autoAnnounceNodeInfoDelaySeconds}
              onNodeInfoEnabledChange={setAutoAnnounceNodeInfoEnabled}
              onNodeInfoChannelsChange={setAutoAnnounceNodeInfoChannels}
              onNodeInfoDelayChange={setAutoAnnounceNodeInfoDelaySeconds}
            />
          </div>
          <div id="auto-responder">
            <AutoResponderSection
              enabled={autoResponderEnabled}
              triggers={autoResponderTriggers}
              channels={channels}
              skipIncompleteNodes={autoResponderSkipIncompleteNodes}
              baseUrl={baseUrl}
              onEnabledChange={setAutoResponderEnabled}
              onTriggersChange={setAutoResponderTriggers}
              onSkipIncompleteNodesChange={setAutoResponderSkipIncompleteNodes}
            />
          </div>
          <div id="auto-key-management">
            <AutoKeyManagementSection
              enabled={autoKeyManagementEnabled}
              intervalMinutes={autoKeyManagementIntervalMinutes}
              maxExchanges={autoKeyManagementMaxExchanges}
              autoPurge={autoKeyManagementAutoPurge}
              immediatePurge={autoKeyManagementImmediatePurge}
              baseUrl={baseUrl}
              onEnabledChange={setAutoKeyManagementEnabled}
              onIntervalChange={setAutoKeyManagementIntervalMinutes}
              onMaxExchangesChange={setAutoKeyManagementMaxExchanges}
              onAutoPurgeChange={setAutoKeyManagementAutoPurge}
              onImmediatePurgeChange={setAutoKeyManagementImmediatePurge}
            />
          </div>
          <div id="timer-triggers">
            <TimerTriggersSection
              triggers={timerTriggers}
              channels={channels}
              baseUrl={baseUrl}
              onTriggersChange={setTimerTriggers}
            />
          </div>
          <div id="geofence-triggers">
            <GeofenceTriggersSection
              triggers={geofenceTriggers}
              channels={channels}
              nodes={nodes}
              baseUrl={baseUrl}
              onTriggersChange={setGeofenceTriggers}
            />
          </div>
          <div id="auto-delete-by-distance">
            <AutoDeleteByDistanceSection
              enabled={autoDeleteByDistanceEnabled}
              intervalHours={autoDeleteByDistanceIntervalHours}
              thresholdKm={autoDeleteByDistanceThresholdKm}
              homeLat={autoDeleteByDistanceLat}
              homeLon={autoDeleteByDistanceLon}
              localNodeLat={currentNodeId ? nodes.find((n: DeviceInfo) => n.user?.id === currentNodeId)?.position?.latitude : undefined}
              localNodeLon={currentNodeId ? nodes.find((n: DeviceInfo) => n.user?.id === currentNodeId)?.position?.longitude : undefined}
              baseUrl={baseUrl}
              onEnabledChange={setAutoDeleteByDistanceEnabled}
              onIntervalChange={setAutoDeleteByDistanceIntervalHours}
              onThresholdChange={setAutoDeleteByDistanceThresholdKm}
              onHomeLatChange={setAutoDeleteByDistanceLat}
              onHomeLonChange={setAutoDeleteByDistanceLon}
              action={autoDeleteByDistanceAction}
              onActionChange={setAutoDeleteByDistanceAction}
            />
          </div>
          <div id="ignored-nodes">
            <IgnoredNodesSection
              baseUrl={baseUrl}
            />
          </div>
        </div>
      </div>
    </SaveBarGroup>
  );
};

export default AutomationTab;
