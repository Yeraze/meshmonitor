import React, { useState, useEffect } from 'react';
import apiService from '../services/api';

interface RebootModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const RebootModal: React.FC<RebootModalProps> = ({ isOpen, onClose }) => {
  const [status, setStatus] = useState<string>('Device rebooting...');
  const [elapsedSeconds, setElapsedSeconds] = useState<number>(0);
  const [isVerifying, setIsVerifying] = useState<boolean>(false);

  useEffect(() => {
    if (!isOpen) {
      // Reset state when modal closes
      setStatus('Device rebooting...');
      setElapsedSeconds(0);
      setIsVerifying(false);
      return;
    }

    // Start monitoring device reboot
    const startTime = Date.now();
    let intervalId: NodeJS.Timeout;
    let aborted = false;

    // Update elapsed time every second
    intervalId = setInterval(() => {
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      setElapsedSeconds(elapsed);
    }, 1000);

    // Polling-based reboot sequence
    const waitForReboot = async () => {
      try {
        console.log('[RebootModal] ===== REBOOT SEQUENCE STARTED =====');

        // Wait 30 seconds for device to reboot (typical reboot time)
        setStatus('Device rebooting... Please wait');
        console.log('[RebootModal] Waiting 30 seconds for device reboot...');
        await new Promise(resolve => setTimeout(resolve, 30000));

        if (aborted) {
          console.log('[RebootModal] Aborted after reboot wait');
          return;
        }

        // Now verify device is back online
        setStatus('Verifying device connection...');
        setIsVerifying(true);
        console.log('[RebootModal] Starting connection verification...');

        // Try up to 3 times to verify device is back (with 3 second gaps)
        let connected = false;
        for (let attempt = 1; attempt <= 3; attempt++) {
          if (aborted) {
            console.log('[RebootModal] Aborted during connection check');
            return;
          }

          console.log(`[RebootModal] Connection check attempt ${attempt}/3...`);
          try {
            const statusData = await apiService.getConnectionStatus();
            console.log(`[RebootModal] Connection status:`, statusData);
            if (statusData.connected === true) {
              console.log('[RebootModal] ✅ Device connected!');
              connected = true;
              break;
            }
          } catch (err) {
            console.warn(`[RebootModal] Connection check attempt ${attempt} failed:`, err);
          }

          if (attempt < 3) {
            console.log('[RebootModal] Waiting 3 seconds before retry...');
            await new Promise(resolve => setTimeout(resolve, 3000));
          }
        }

        if (!connected) {
          console.error('[RebootModal] ❌ Device reconnection timeout');
          setStatus('Device reconnection timeout. Please reload page.');
          await new Promise(resolve => setTimeout(resolve, 5000));
          clearInterval(intervalId);
          if (!aborted) onClose();
          return;
        }

        if (aborted) {
          console.log('[RebootModal] Aborted after connection verified');
          return;
        }

        console.log('[RebootModal] ===== STARTING CONFIGURATION POLLING =====');

      // Device is connected - now poll for configuration updates
      setStatus('Waiting for device to apply configuration...');
      console.log('[RebootModal] Device connected, starting configuration polling...');

      // Get initial config to compare against
      let initialConfig: any = null;
      try {
        initialConfig = await apiService.getCurrentConfig();
        console.log('[RebootModal] Initial config after reboot:', initialConfig?.deviceConfig?.lora?.hopLimit);
      } catch (err) {
        console.warn('[RebootModal] Failed to get initial config:', err);
      }

      // Poll for up to 60 seconds (20 attempts, 3 seconds apart)
      let configUpdated = false;
      for (let pollAttempt = 1; pollAttempt <= 20; pollAttempt++) {
        if (aborted) return;

        console.log(`[RebootModal] Poll attempt ${pollAttempt}/20 - requesting config refresh...`);
        setStatus(`Checking for configuration updates... (${pollAttempt}/20)`);

        try {
          // Request fresh config from device
          await apiService.refreshNodes();

          // Wait a moment for device to respond
          await new Promise(resolve => setTimeout(resolve, 2000));

          if (aborted) return;

          // Check if config has been updated
          const currentConfig = await apiService.getCurrentConfig();
          const currentHopLimit = currentConfig?.deviceConfig?.lora?.hopLimit;
          const initialHopLimit = initialConfig?.deviceConfig?.lora?.hopLimit;

          console.log(`[RebootModal] Poll ${pollAttempt}: hopLimit=${currentHopLimit} (initial was ${initialHopLimit})`);

          // If config changed, we're done
          if (currentHopLimit !== initialHopLimit && currentHopLimit !== undefined) {
            console.log(`[RebootModal] ✅ Configuration updated! ${initialHopLimit} → ${currentHopLimit}`);
            setStatus('Configuration verified!');
            await new Promise(resolve => setTimeout(resolve, 1000));
            configUpdated = true;
            break;
          }
        } catch (err) {
          console.warn(`[RebootModal] Poll attempt ${pollAttempt} failed:`, err);
        }

        // Wait before next poll (unless this was the last attempt)
        if (pollAttempt < 20 && !aborted) {
          await new Promise(resolve => setTimeout(resolve, 3000));
        }
      }

      if (aborted) {
        console.log('[RebootModal] Aborted after polling');
        return;
      }

      if (!configUpdated) {
        console.log('[RebootModal] ⏱️ Configuration polling timeout - config may not have changed or device is slow');
        setStatus('Configuration saved. Please reload page if changes are not visible.');
        await new Promise(resolve => setTimeout(resolve, 3000));
      }

      console.log('[RebootModal] ===== REBOOT SEQUENCE COMPLETE =====');
      clearInterval(intervalId);
      if (!aborted) onClose();
    } catch (error) {
      console.error('[RebootModal] ❌ Fatal error in reboot sequence:', error);
      setStatus('Error during reboot verification. Please reload page.');
      await new Promise(resolve => setTimeout(resolve, 5000));
      clearInterval(intervalId);
      if (!aborted) onClose();
    }
    };

    // Start the reboot sequence immediately
    console.log('[RebootModal] Launching waitForReboot() function...');
    waitForReboot();

    return () => {
      aborted = true;
      clearInterval(intervalId);
    };
  }, [isOpen]); // Removed onClose from deps - it's stable and doesn't need to trigger re-runs

  if (!isOpen) return null;

  return (
    <div
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: 'rgba(0, 0, 0, 0.8)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 2000
      }}
    >
      <div
        style={{
          maxWidth: '500px',
          background: 'var(--ctp-base)',
          borderRadius: '8px',
          padding: '2rem',
          border: '2px solid var(--ctp-blue)',
          boxShadow: '0 0 20px rgba(137, 180, 250, 0.5)'
        }}
      >
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: '1.5rem', fontWeight: 'bold', color: 'var(--ctp-blue)', marginBottom: '1rem' }}>
            {isVerifying ? '✓' : '⟳'} Device Reboot
          </div>

          <div style={{ fontSize: '1rem', color: 'var(--ctp-text)', marginBottom: '1.5rem' }}>
            {status}
          </div>

          {!isVerifying && elapsedSeconds > 0 && (
            <div style={{ fontSize: '0.875rem', color: 'var(--ctp-subtext0)', marginBottom: '1.5rem' }}>
              Elapsed: {elapsedSeconds}s
            </div>
          )}

          {!isVerifying && (
            <div
              style={{
                width: '100%',
                height: '4px',
                background: 'var(--ctp-surface1)',
                borderRadius: '2px',
                overflow: 'hidden',
                marginBottom: '1rem'
              }}
            >
              <div
                style={{
                  height: '100%',
                  background: 'var(--ctp-blue)',
                  animation: 'progress-bar 2s ease-in-out infinite',
                  width: '30%'
                }}
              />
            </div>
          )}

          <style>{`
            @keyframes progress-bar {
              0% { transform: translateX(-100%); }
              50% { transform: translateX(300%); }
              100% { transform: translateX(-100%); }
            }
          `}</style>

          <div style={{ fontSize: '0.875rem', color: 'var(--ctp-subtext1)', marginTop: '1rem' }}>
            Please do not close this window or refresh the page.
          </div>
        </div>
      </div>
    </div>
  );
};
