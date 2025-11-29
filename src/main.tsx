// CRITICAL: This must be the FIRST import to ensure API base URL is set
// before any other modules are loaded
import { appBasename } from './init';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import { ReactQueryDevtools } from '@tanstack/react-query-devtools';
import { queryClient } from './config/queryClient.ts';
import App from './App.tsx';
import PacketMonitorPage from './pages/PacketMonitorPage.tsx';
import './index.css';
import { AuthProvider } from './contexts/AuthContext';
import { CsrfProvider } from './contexts/CsrfContext';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter basename={appBasename}>
        <Routes>
          <Route path="packet-monitor" element={<PacketMonitorPage />} />
          <Route
            path="*"
            element={
              <CsrfProvider>
                <AuthProvider>
                  <App />
                </AuthProvider>
              </CsrfProvider>
            }
          />
        </Routes>
      </BrowserRouter>
      <ReactQueryDevtools initialIsOpen={false} />
    </QueryClientProvider>
  </React.StrictMode>
);
