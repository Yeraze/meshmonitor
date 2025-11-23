// CRITICAL: This must be the FIRST import to ensure API base URL is set
// before any other modules are loaded
import { appBasename } from './init'
import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import App from './App.tsx'
import PacketMonitorPage from './pages/PacketMonitorPage.tsx'
import './index.css'
import { AuthProvider } from './contexts/AuthContext'
import { CsrfProvider } from './contexts/CsrfContext'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter basename={appBasename}>
      <Routes>
        <Route path="packet-monitor" element={<PacketMonitorPage />} />
        <Route path="*" element={
          <CsrfProvider>
            <AuthProvider>
              <App />
            </AuthProvider>
          </CsrfProvider>
        } />
      </Routes>
    </BrowserRouter>
  </React.StrictMode>,
)