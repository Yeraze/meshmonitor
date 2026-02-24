import React from 'react';
import PacketMonitorPanel from '../components/PacketMonitorPanel';
import { AuthProvider } from '../contexts/AuthContext';
import { SettingsProvider } from '../contexts/SettingsContext';
import { DataProvider, useData } from '../contexts/DataContext';
import { CsrfProvider } from '../contexts/CsrfContext';
import api from '../services/api';
import '../App.css';

const PacketMonitorContent: React.FC = () => {
  const { setDeviceInfo } = useData();

  React.useEffect(() => {
    const fetchDeviceInfo = async () => {
      try {
        const config = await api.getCurrentConfig();
        setDeviceInfo(config);
      } catch (error) {
        console.error('Failed to fetch device info:', error);
      }
    };

    fetchDeviceInfo();
  }, [setDeviceInfo]);

  return (
    <div style={{
      width: '100vw',
      height: '100vh',
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden',
      background: 'var(--bg-primary)'
    }}>
      <PacketMonitorPanel
        onClose={() => window.close()}
        onNodeClick={(nodeId) => {
          // In pop-out mode, we can't navigate to node details
          // So we'll just log it or ignore it
          console.log('Node clicked in pop-out:', nodeId);
        }}
      />
    </div>
  );
};

const PacketMonitorPage: React.FC = () => {
  return (
    <CsrfProvider>
      <AuthProvider>
        <SettingsProvider>
          <DataProvider>
            <PacketMonitorContent />
          </DataProvider>
        </SettingsProvider>
      </AuthProvider>
    </CsrfProvider>
  );
};

export default PacketMonitorPage;
