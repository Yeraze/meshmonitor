import React from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import PacketMonitorPanel from '../components/PacketMonitorPanel';
import { AuthProvider } from '../contexts/AuthContext';
import { SettingsProvider } from '../contexts/SettingsContext';
import { DataProvider, useData } from '../contexts/DataContext';
import { CsrfProvider } from '../contexts/CsrfContext';
import { SourceProvider } from '../contexts/SourceContext';
import { WebSocketProvider } from '../contexts/WebSocketContext';
import { MeshCorePacketMonitorView } from '../components/MeshCore/MeshCorePacketMonitorView';
import type { MeshCoreContact } from '../utils/meshcoreHelpers';
import { useDashboardSources } from '../hooks/useDashboardData';
import { appBasename } from '../init';
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

    void fetchDeviceInfo();
  }, [setDeviceInfo]);

  return (
    <div style={{
      width: '100vw',
      height: '100dvh',
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden',
      background: 'var(--bg-primary)'
    }}>
      <PacketMonitorPanel
        standalone
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

/**
 * Pop-out for a MeshCore source (`?sourceId=`). Contacts are read-only here:
 * they only name the From column and the relay chain.
 */
const MeshCorePacketMonitorPopout: React.FC<{ sourceId: string; sourceName: string; sourceType: string }> = ({
  sourceId,
  sourceName,
  sourceType,
}) => {
  const { data: contacts } = useQuery<MeshCoreContact[]>({
    queryKey: ['meshcore-popout-contacts', sourceId],
    queryFn: async () => {
      const res = await api.get<{ data?: MeshCoreContact[] }>(`/api/sources/${encodeURIComponent(sourceId)}/meshcore/contacts`);
      return Array.isArray(res?.data) ? res.data : [];
    },
    staleTime: 60_000,
  });

  return (
    <SourceProvider sourceId={sourceId} sourceName={sourceName} sourceType={sourceType}>
      <WebSocketProvider>
        <div style={{
          width: '100vw',
          height: '100dvh',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          background: 'var(--bg-primary)'
        }}>
          <MeshCorePacketMonitorView
            baseUrl={appBasename}
            sourceId={sourceId}
            contacts={contacts}
            standalone
          />
        </div>
      </WebSocketProvider>
    </SourceProvider>
  );
};

/** `?sourceId=` naming a MeshCore source selects its monitor; anything else is the Meshtastic panel. */
const PacketMonitorDispatch: React.FC = () => {
  const [params] = useSearchParams();
  const requestedSourceId = params.get('sourceId');
  const { data: sources, isLoading } = useDashboardSources();

  if (!requestedSourceId) return <PacketMonitorContent />;
  if (isLoading && !sources) return null;

  const source = sources?.find(s => s.id === requestedSourceId);
  if (source && (source.type === 'meshcore' || source.type === 'meshcore_mqtt')) {
    return <MeshCorePacketMonitorPopout sourceId={source.id} sourceName={source.name} sourceType={source.type} />;
  }
  return <PacketMonitorContent />;
};

const PacketMonitorPage: React.FC = () => {
  return (
    <CsrfProvider>
      <AuthProvider>
        <SettingsProvider>
          <DataProvider>
            <PacketMonitorDispatch />
          </DataProvider>
        </SettingsProvider>
      </AuthProvider>
    </CsrfProvider>
  );
};

export default PacketMonitorPage;
