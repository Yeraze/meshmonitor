import React from 'react';
import PacketMonitorPanel from '../components/PacketMonitorPanel';
import { AuthProvider } from '../contexts/AuthContext';
import { SettingsProvider } from '../contexts/SettingsContext';
import { DataProvider } from '../contexts/DataContext';
import { CsrfProvider } from '../contexts/CsrfContext';
import '../App.css';

const PacketMonitorPage: React.FC = () => {
  return (
    <CsrfProvider>
      <AuthProvider>
        <SettingsProvider>
          <DataProvider>
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
          </DataProvider>
        </SettingsProvider>
      </AuthProvider>
    </CsrfProvider>
  );
};

export default PacketMonitorPage;
