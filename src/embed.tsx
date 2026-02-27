import React from 'react';
import { createRoot } from 'react-dom/client';
import { EmbedMap } from './components/EmbedMap';

function EmbedApp() {
  const pathParts = window.location.pathname.split('/');
  const embedIndex = pathParts.indexOf('embed');
  const profileId = embedIndex >= 0 ? pathParts[embedIndex + 1] : null;

  if (!profileId) {
    return <div style={{ padding: 20, color: '#ff4444' }}>Invalid embed URL</div>;
  }

  return <EmbedMap profileId={profileId} />;
}

const root = createRoot(document.getElementById('embed-root')!);
root.render(<EmbedApp />);
