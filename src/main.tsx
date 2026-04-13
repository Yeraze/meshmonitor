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
import DashboardPage from './pages/DashboardPage.tsx';
import AnalysisPage from './pages/AnalysisPage.tsx';
import UnifiedMessagesPage from './pages/UnifiedMessagesPage.tsx';
import UnifiedTelemetryPage from './pages/UnifiedTelemetryPage.tsx';
import GlobalSettingsPage from './pages/GlobalSettingsPage.tsx';
import UsersPage from './pages/UsersPage.tsx';
import './index.css';
import { AuthProvider } from './contexts/AuthContext';
import { CsrfProvider } from './contexts/CsrfContext';
import { WebSocketProvider } from './contexts/WebSocketContext';
import { SourceProvider } from './contexts/SourceContext';

/**
 * Wraps App with SourceProvider then WebSocketProvider so that useWebSocket()
 * can call useSource() and get the real sourceId for room subscription and
 * cache key targeting. WebSocketProvider must be INSIDE SourceProvider.
 */
function SourceApp() {
  const { sourceId } = useParams<{ sourceId: string }>();
  if (!sourceId) return <Navigate to="/" replace />;
  return (
    <SourceProvider sourceId={sourceId}>
      <WebSocketProvider>
        {/* key={sourceId} forces full remount when switching sources, resetting all DataContext/MessagingContext state */}
        <App key={sourceId} />
      </WebSocketProvider>
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

// Source routes need auth but NOT an outer WebSocket — SourceApp provides its own
// WebSocketProvider inside SourceProvider so useSource() is in scope.
const sourceRouteProviders = (children: React.ReactNode) => (
  <CsrfProvider>
    <AuthProvider>
      {children}
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

            {/* Source-specific view — SourceProvider wraps WebSocketProvider for correct sourceId */}
            <Route
              path="source/:sourceId/*"
              element={sourceRouteProviders(<SourceApp />)}
            />

            {/* Unified cross-source views */}
            <Route
              path="unified/messages"
              element={sharedProviders(<UnifiedMessagesPage />)}
            />
            <Route
              path="unified/telemetry"
              element={sharedProviders(<UnifiedTelemetryPage />)}
            />

            {/* Analysis workspace — coming soon */}
            <Route
              path="analysis"
              element={sharedProviders(<AnalysisPage />)}
            />

            {/* Global settings */}
            <Route
              path="settings"
              element={sharedProviders(<GlobalSettingsPage />)}
            />

            {/* User management */}
            <Route
              path="users"
              element={sharedProviders(<UsersPage />)}
            />

            {/* Dashboard / landing page */}
            <Route
              path="*"
              element={sharedProviders(<DashboardPage />)}
            />
          </Routes>
        </BrowserRouter>
        <ReactQueryDevtools initialIsOpen={false} />
      </QueryClientProvider>
    </Suspense>
  </React.StrictMode>
);
