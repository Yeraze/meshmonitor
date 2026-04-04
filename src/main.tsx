// CRITICAL: This must be the FIRST import to ensure API base URL is set
// before any other modules are loaded
import { appBasename } from './init';
// Initialize i18n after init.ts sets the base URL
import './config/i18n';
import React, { Suspense } from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Routes, Route, Navigate, useParams } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import { ReactQueryDevtools } from '@tanstack/react-query-devtools';
import { queryClient } from './config/queryClient.ts';
import App from './App.tsx';
import PacketMonitorPage from './pages/PacketMonitorPage.tsx';
import SourceListPage from './pages/SourceListPage.tsx';
import AnalysisPage from './pages/AnalysisPage.tsx';
import UnifiedMessagesPage from './pages/UnifiedMessagesPage.tsx';
import './index.css';
import { AuthProvider } from './contexts/AuthContext';
import { CsrfProvider } from './contexts/CsrfContext';
import { WebSocketProvider } from './contexts/WebSocketContext';
import { SourceProvider } from './contexts/SourceContext';

/** Wraps the existing App in a SourceProvider keyed to the :sourceId URL param */
function SourceApp() {
  const { sourceId } = useParams<{ sourceId: string }>();
  if (!sourceId) return <Navigate to="/" replace />;
  return (
    <SourceProvider sourceId={sourceId}>
      <App />
    </SourceProvider>
  );
}

const sharedProviders = (children: React.ReactNode) => (
  <CsrfProvider>
    <AuthProvider>
      <WebSocketProvider>
        {children}
      </WebSocketProvider>
    </AuthProvider>
  </CsrfProvider>
);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Suspense fallback={<div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh' }}>Loading...</div>}>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter basename={appBasename}>
          <Routes>
            {/* Standalone routes — no auth providers needed */}
            <Route path="packet-monitor" element={<PacketMonitorPage />} />

            {/* Source-specific view — full App with SourceProvider */}
            <Route
              path="source/:sourceId/*"
              element={sharedProviders(<SourceApp />)}
            />

            {/* Unified cross-source views */}
            <Route
              path="unified/messages"
              element={sharedProviders(<UnifiedMessagesPage />)}
            />

            {/* Analysis workspace — coming soon */}
            <Route
              path="analysis"
              element={sharedProviders(<AnalysisPage />)}
            />

            {/* Source list / landing page */}
            <Route
              path="*"
              element={sharedProviders(<SourceListPage />)}
            />
          </Routes>
        </BrowserRouter>
        <ReactQueryDevtools initialIsOpen={false} />
      </QueryClientProvider>
    </Suspense>
  </React.StrictMode>
);
