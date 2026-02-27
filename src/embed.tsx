import React from 'react';
import { createRoot } from 'react-dom/client';

function EmbedApp() {
  return <div>Loading embed...</div>;
}

const root = createRoot(document.getElementById('embed-root')!);
root.render(<EmbedApp />);
