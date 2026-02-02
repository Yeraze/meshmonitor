import React, { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useCsrfFetch } from '../hooks/useCsrfFetch';

export type ScriptTestTriggerType = 'auto-responder' | 'geofence' | 'timer';

export interface ScriptTestModalProps {
  isOpen: boolean;
  onClose: () => void;
  triggerType: ScriptTestTriggerType;
  scriptPath: string;
  scriptArgs?: string;
  baseUrl: string;
  // For auto-responder
  trigger?: string | string[];
  // For geofence
  geofenceName?: string;
  geofenceId?: string;
  // For timer
  timerName?: string;
  timerId?: string;
}

interface TestResult {
  success: boolean;
  stdout?: string;
  stderr?: string;
  wouldSendMessages?: string[];
  returnValue?: unknown;
  extractedParams?: Record<string, string>;
  matchedPattern?: string;
  executionTimeMs?: number;
  error?: string;
}

const ScriptTestModal: React.FC<ScriptTestModalProps> = ({
  isOpen,
  onClose,
  triggerType,
  scriptPath,
  scriptArgs,
  baseUrl,
  trigger,
  geofenceName,
  geofenceId,
  timerName,
  timerId,
}) => {
  const { t } = useTranslation();
  const csrfFetch = useCsrfFetch();

  // Mock context state
  const [testMessage, setTestMessage] = useState('');
  const [mockNodeNum, setMockNodeNum] = useState('12345');
  const [mockShortName, setMockShortName] = useState('TEST');
  const [mockLongName, setMockLongName] = useState('Test Node');
  const [mockNodeLat, setMockNodeLat] = useState('37.7749');
  const [mockNodeLon, setMockNodeLon] = useState('-122.4194');
  const [eventType, setEventType] = useState<'entry' | 'exit' | 'while_inside'>('entry');

  // Test state
  const [isRunning, setIsRunning] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);

  // Collapsible sections
  const [showConsole, setShowConsole] = useState(true);
  const [showWouldSend, setShowWouldSend] = useState(true);
  const [showEnvVars, setShowEnvVars] = useState(false);

  const runTest = useCallback(async () => {
    setIsRunning(true);
    setTestResult(null);

    try {
      const requestBody: Record<string, unknown> = {
        script: scriptPath,
        triggerType,
        scriptArgs,
        mockNode: {
          nodeNum: parseInt(mockNodeNum) || 12345,
          shortName: mockShortName,
          longName: mockLongName,
          lat: parseFloat(mockNodeLat) || 37.7749,
          lon: parseFloat(mockNodeLon) || -122.4194,
        },
      };

      if (triggerType === 'auto-responder') {
        requestBody.trigger = trigger;
        requestBody.testMessage = testMessage;
      } else if (triggerType === 'geofence') {
        requestBody.geofenceName = geofenceName || 'Test Geofence';
        requestBody.geofenceId = geofenceId || 'test-id';
        requestBody.eventType = eventType;
        requestBody.nodeLat = parseFloat(mockNodeLat) || 37.7749;
        requestBody.nodeLon = parseFloat(mockNodeLon) || -122.4194;
      } else if (triggerType === 'timer') {
        requestBody.timerName = timerName || 'Test Timer';
        requestBody.timerId = timerId || 'test-id';
      }

      const response = await csrfFetch(`${baseUrl}/api/scripts/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      });

      const data = await response.json();
      setTestResult(data);
    } catch (error: unknown) {
      setTestResult({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to execute test',
      });
    } finally {
      setIsRunning(false);
    }
  }, [
    scriptPath,
    triggerType,
    scriptArgs,
    mockNodeNum,
    mockShortName,
    mockLongName,
    mockNodeLat,
    mockNodeLon,
    trigger,
    testMessage,
    geofenceName,
    geofenceId,
    eventType,
    timerName,
    timerId,
    baseUrl,
    csrfFetch,
  ]);

  const getEnvironmentVariables = (): Record<string, string> => {
    const env: Record<string, string> = {
      IP: '(server IP)',
      PORT: '(server port)',
      VERSION: '(server version)',
    };

    if (triggerType === 'auto-responder') {
      env.MESSAGE = testMessage || '(test message)';
      env.FROM_NODE = mockNodeNum;
      env.FROM_SHORT_NAME = mockShortName;
      env.FROM_LONG_NAME = mockLongName;
      env.PACKET_ID = '99999';
      env.TRIGGER = Array.isArray(trigger) ? trigger.join(', ') : (trigger || '');
    } else if (triggerType === 'geofence') {
      env.GEOFENCE_NAME = geofenceName || 'Test Geofence';
      env.GEOFENCE_ID = geofenceId || 'test-id';
      env.GEOFENCE_EVENT = eventType;
      env.EVENT = eventType;
      env.NODE_LAT = mockNodeLat;
      env.NODE_LON = mockNodeLon;
      env.NODE_NUM = mockNodeNum;
      env.NODE_ID = mockNodeNum;
      env.SHORT_NAME = mockShortName;
      env.LONG_NAME = mockLongName;
      env.DISTANCE_TO_CENTER = '0.5';
    } else if (triggerType === 'timer') {
      env.TIMER_NAME = timerName || 'Test Timer';
      env.TIMER_ID = timerId || 'test-id';
      env.TIMER_SCRIPT = scriptPath;
    }

    return env;
  };

  if (!isOpen) return null;

  const scriptFilename = scriptPath.split('/').pop() || scriptPath;

  return (
    <div
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        background: 'rgba(0, 0, 0, 0.6)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 10000,
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        style={{
          background: 'var(--ctp-base)',
          borderRadius: '8px',
          width: '90%',
          maxWidth: '700px',
          maxHeight: '90vh',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
          border: '1px solid var(--ctp-overlay0)',
        }}
      >
        {/* Header */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            padding: '1rem 1.25rem',
            borderBottom: '1px solid var(--ctp-surface1)',
            background: 'var(--ctp-surface0)',
          }}
        >
          <h3 style={{ margin: 0, color: 'var(--ctp-text)', fontSize: '1.1rem' }}>
            {t('script_test.title', 'Test Script')}: {scriptFilename}
          </h3>
          <button
            onClick={onClose}
            style={{
              background: 'transparent',
              border: 'none',
              fontSize: '1.5rem',
              color: 'var(--ctp-subtext0)',
              cursor: 'pointer',
              padding: '0',
              lineHeight: '1',
            }}
          >
            &times;
          </button>
        </div>

        {/* Content */}
        <div style={{ padding: '1.25rem', overflowY: 'auto', flex: 1 }}>
          {/* Mock Context Section */}
          <div style={{ marginBottom: '1rem' }}>
            <h4 style={{ margin: '0 0 0.75rem 0', color: 'var(--ctp-text)', fontSize: '0.95rem' }}>
              {t('script_test.mock_context', 'Test Context')}
            </h4>

            <div
              style={{
                background: 'var(--ctp-surface0)',
                borderRadius: '6px',
                padding: '1rem',
              }}
            >
              {/* Auto-responder fields */}
              {triggerType === 'auto-responder' && (
                <div style={{ marginBottom: '0.75rem' }}>
                  <label style={{ display: 'block', fontSize: '0.85rem', marginBottom: '0.25rem', color: 'var(--ctp-subtext0)' }}>
                    {t('script_test.mock.message', 'Test Message')} *
                  </label>
                  <input
                    type="text"
                    value={testMessage}
                    onChange={(e) => setTestMessage(e.target.value)}
                    className="setting-input"
                    style={{ width: '100%' }}
                    placeholder={t('script_test.mock.message_hint', 'Enter a message that would trigger this script')}
                  />
                  <div style={{ fontSize: '0.75rem', color: 'var(--ctp-subtext0)', marginTop: '0.25rem' }}>
                    {t('script_test.mock.trigger_pattern', 'Trigger pattern')}: <code style={{ background: 'var(--ctp-surface1)', padding: '0 0.25rem', borderRadius: '2px' }}>
                      {Array.isArray(trigger) ? trigger.join(' | ') : trigger}
                    </code>
                  </div>
                </div>
              )}

              {/* Geofence fields */}
              {triggerType === 'geofence' && (
                <div style={{ marginBottom: '0.75rem' }}>
                  <label style={{ display: 'block', fontSize: '0.85rem', marginBottom: '0.25rem', color: 'var(--ctp-subtext0)' }}>
                    {t('script_test.mock.event_type', 'Geofence Event')}
                  </label>
                  <select
                    value={eventType}
                    onChange={(e) => setEventType(e.target.value as 'entry' | 'exit' | 'while_inside')}
                    className="setting-input"
                    style={{ width: '100%' }}
                  >
                    <option value="entry">{t('automation.geofence_triggers.event_entry', 'Entry')}</option>
                    <option value="exit">{t('automation.geofence_triggers.event_exit', 'Exit')}</option>
                    <option value="while_inside">{t('automation.geofence_triggers.event_while_inside', 'While Inside')}</option>
                  </select>
                </div>
              )}

              {/* Common mock node fields */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
                <div>
                  <label style={{ display: 'block', fontSize: '0.85rem', marginBottom: '0.25rem', color: 'var(--ctp-subtext0)' }}>
                    {t('script_test.mock.from_node', 'From Node Number')}
                  </label>
                  <input
                    type="text"
                    value={mockNodeNum}
                    onChange={(e) => setMockNodeNum(e.target.value)}
                    className="setting-input"
                    style={{ width: '100%' }}
                  />
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: '0.85rem', marginBottom: '0.25rem', color: 'var(--ctp-subtext0)' }}>
                    {t('script_test.mock.from_short_name', 'From Short Name')}
                  </label>
                  <input
                    type="text"
                    value={mockShortName}
                    onChange={(e) => setMockShortName(e.target.value)}
                    className="setting-input"
                    style={{ width: '100%' }}
                  />
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: '0.85rem', marginBottom: '0.25rem', color: 'var(--ctp-subtext0)' }}>
                    {t('script_test.mock.from_long_name', 'From Long Name')}
                  </label>
                  <input
                    type="text"
                    value={mockLongName}
                    onChange={(e) => setMockLongName(e.target.value)}
                    className="setting-input"
                    style={{ width: '100%' }}
                  />
                </div>
                {(triggerType === 'geofence' || triggerType === 'auto-responder') && (
                  <>
                    <div>
                      <label style={{ display: 'block', fontSize: '0.85rem', marginBottom: '0.25rem', color: 'var(--ctp-subtext0)' }}>
                        {t('script_test.mock.node_lat', 'Node Latitude')}
                      </label>
                      <input
                        type="text"
                        value={mockNodeLat}
                        onChange={(e) => setMockNodeLat(e.target.value)}
                        className="setting-input"
                        style={{ width: '100%' }}
                      />
                    </div>
                    <div>
                      <label style={{ display: 'block', fontSize: '0.85rem', marginBottom: '0.25rem', color: 'var(--ctp-subtext0)' }}>
                        {t('script_test.mock.node_lon', 'Node Longitude')}
                      </label>
                      <input
                        type="text"
                        value={mockNodeLon}
                        onChange={(e) => setMockNodeLon(e.target.value)}
                        className="setting-input"
                        style={{ width: '100%' }}
                      />
                    </div>
                  </>
                )}
              </div>
            </div>

            {/* Run Test Button */}
            <div style={{ marginTop: '1rem', display: 'flex', justifyContent: 'flex-end' }}>
              <button
                onClick={runTest}
                disabled={isRunning || (triggerType === 'auto-responder' && !testMessage.trim())}
                className="settings-button settings-button-primary"
                style={{
                  padding: '0.5rem 1.5rem',
                  opacity: isRunning || (triggerType === 'auto-responder' && !testMessage.trim()) ? 0.5 : 1,
                  cursor: isRunning || (triggerType === 'auto-responder' && !testMessage.trim()) ? 'not-allowed' : 'pointer',
                }}
              >
                {isRunning ? t('script_test.running', 'Running...') : t('script_test.run_test', 'Run Test')}
              </button>
            </div>
          </div>

          {/* Test Results */}
          {testResult && (
            <>
              {/* Status */}
              <div
                style={{
                  padding: '0.75rem',
                  marginBottom: '1rem',
                  borderRadius: '6px',
                  background: testResult.success ? 'rgba(166, 227, 161, 0.15)' : 'rgba(243, 139, 168, 0.15)',
                  border: `1px solid ${testResult.success ? 'var(--ctp-green)' : 'var(--ctp-red)'}`,
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ color: testResult.success ? 'var(--ctp-green)' : 'var(--ctp-red)', fontWeight: 'bold' }}>
                    {testResult.success
                      ? t('script_test.success', 'Script executed successfully')
                      : t('script_test.error', 'Script execution failed')}
                  </span>
                  {testResult.executionTimeMs !== undefined && (
                    <span style={{ fontSize: '0.85rem', color: 'var(--ctp-subtext0)' }}>
                      {t('script_test.execution_time', 'Execution time: {{time}}ms', { time: testResult.executionTimeMs })}
                    </span>
                  )}
                </div>
                {testResult.error && (
                  <div style={{ marginTop: '0.5rem', color: 'var(--ctp-red)', fontSize: '0.9rem' }}>
                    {testResult.error}
                  </div>
                )}
              </div>

              {/* Console Output */}
              <div style={{ marginBottom: '1rem' }}>
                <button
                  onClick={() => setShowConsole(!showConsole)}
                  style={{
                    background: 'none',
                    border: 'none',
                    padding: 0,
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.5rem',
                    color: 'var(--ctp-text)',
                    fontSize: '0.95rem',
                    fontWeight: 'bold',
                    marginBottom: '0.5rem',
                  }}
                >
                  <span style={{ transform: showConsole ? 'rotate(90deg)' : 'none', transition: 'transform 0.2s' }}>
                    &#9654;
                  </span>
                  {t('script_test.console_output', 'Console Output')}
                </button>
                {showConsole && (
                  <div
                    style={{
                      background: 'var(--ctp-crust)',
                      borderRadius: '4px',
                      padding: '0.75rem',
                      fontFamily: 'monospace',
                      fontSize: '0.85rem',
                      maxHeight: '200px',
                      overflow: 'auto',
                    }}
                  >
                    {testResult.stdout && (
                      <div style={{ color: 'var(--ctp-text)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                        <span style={{ color: 'var(--ctp-green)', fontWeight: 'bold' }}>stdout:</span> {testResult.stdout}
                      </div>
                    )}
                    {testResult.stderr && (
                      <div style={{ color: 'var(--ctp-yellow)', whiteSpace: 'pre-wrap', wordBreak: 'break-word', marginTop: testResult.stdout ? '0.5rem' : 0 }}>
                        <span style={{ fontWeight: 'bold' }}>stderr:</span> {testResult.stderr}
                      </div>
                    )}
                    {!testResult.stdout && !testResult.stderr && (
                      <span style={{ color: 'var(--ctp-subtext0)' }}>(no output)</span>
                    )}
                  </div>
                )}
              </div>

              {/* Would Send Messages */}
              <div style={{ marginBottom: '1rem' }}>
                <button
                  onClick={() => setShowWouldSend(!showWouldSend)}
                  style={{
                    background: 'none',
                    border: 'none',
                    padding: 0,
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.5rem',
                    color: 'var(--ctp-text)',
                    fontSize: '0.95rem',
                    fontWeight: 'bold',
                    marginBottom: '0.5rem',
                  }}
                >
                  <span style={{ transform: showWouldSend ? 'rotate(90deg)' : 'none', transition: 'transform 0.2s' }}>
                    &#9654;
                  </span>
                  {t('script_test.would_send', 'Would Send to Mesh')}
                </button>
                {showWouldSend && (
                  <div
                    style={{
                      background: 'var(--ctp-surface0)',
                      borderRadius: '4px',
                      padding: '0.75rem',
                    }}
                  >
                    <div style={{ fontSize: '0.75rem', color: 'var(--ctp-subtext0)', marginBottom: '0.5rem' }}>
                      {t('script_test.would_send_note', 'These messages would be sent if this were a real trigger (NOT sent during test)')}
                    </div>
                    {testResult.wouldSendMessages && testResult.wouldSendMessages.length > 0 ? (
                      testResult.wouldSendMessages.map((msg, idx) => (
                        <div
                          key={idx}
                          style={{
                            background: 'var(--ctp-surface1)',
                            padding: '0.5rem 0.75rem',
                            borderRadius: '4px',
                            marginBottom: idx < testResult.wouldSendMessages!.length - 1 ? '0.5rem' : 0,
                            fontFamily: 'monospace',
                            fontSize: '0.9rem',
                            color: 'var(--ctp-text)',
                            border: '1px solid var(--ctp-blue)',
                          }}
                        >
                          {msg}
                        </div>
                      ))
                    ) : (
                      <div style={{ color: 'var(--ctp-subtext0)', fontStyle: 'italic' }}>
                        {t('script_test.no_messages', 'No messages to send')}
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Extracted Params (auto-responder only) */}
              {triggerType === 'auto-responder' && testResult.extractedParams && Object.keys(testResult.extractedParams).length > 0 && (
                <div style={{ marginBottom: '1rem' }}>
                  <h4 style={{ margin: '0 0 0.5rem 0', color: 'var(--ctp-text)', fontSize: '0.95rem' }}>
                    Extracted Parameters
                  </h4>
                  <div
                    style={{
                      background: 'var(--ctp-surface0)',
                      borderRadius: '4px',
                      padding: '0.75rem',
                    }}
                  >
                    {Object.entries(testResult.extractedParams).map(([key, value]) => (
                      <div key={key} style={{ marginBottom: '0.25rem' }}>
                        <code style={{ color: 'var(--ctp-blue)' }}>PARAM_{key}</code>
                        <span style={{ color: 'var(--ctp-subtext0)' }}> = </span>
                        <code style={{ color: 'var(--ctp-green)' }}>{value}</code>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}

          {/* Environment Variables (collapsible) */}
          <div>
            <button
              onClick={() => setShowEnvVars(!showEnvVars)}
              style={{
                background: 'none',
                border: 'none',
                padding: 0,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: '0.5rem',
                color: 'var(--ctp-subtext0)',
                fontSize: '0.9rem',
                marginBottom: '0.5rem',
              }}
            >
              <span style={{ transform: showEnvVars ? 'rotate(90deg)' : 'none', transition: 'transform 0.2s' }}>
                &#9654;
              </span>
              {t('script_test.environment', 'Environment Variables')}
            </button>
            {showEnvVars && (
              <div
                style={{
                  background: 'var(--ctp-crust)',
                  borderRadius: '4px',
                  padding: '0.75rem',
                  fontFamily: 'monospace',
                  fontSize: '0.8rem',
                  maxHeight: '150px',
                  overflow: 'auto',
                }}
              >
                {Object.entries(getEnvironmentVariables()).map(([key, value]) => (
                  <div key={key} style={{ marginBottom: '0.15rem' }}>
                    <span style={{ color: 'var(--ctp-blue)' }}>{key}</span>
                    <span style={{ color: 'var(--ctp-subtext0)' }}>=</span>
                    <span style={{ color: 'var(--ctp-text)' }}>{value}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default ScriptTestModal;
