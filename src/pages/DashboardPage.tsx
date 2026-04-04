/**
 * DashboardPage — MeshMonitor 4.0 landing page.
 *
 * Wraps the inner dashboard in a SettingsProvider so map tile preferences
 * are available, then wires together DashboardSidebar + DashboardMap with
 * per-source data fetched via the useDashboardData hooks.
 */

import React, { useState, useEffect } from 'react';
import { SettingsProvider, useSettings } from '../contexts/SettingsContext';
import { useAuth } from '../contexts/AuthContext';
import { useCsrf } from '../contexts/CsrfContext';
import {
  useDashboardSources,
  useSourceStatuses,
  useDashboardSourceData,
} from '../hooks/useDashboardData';
import DashboardSidebar from '../components/Dashboard/DashboardSidebar';
import DashboardMap from '../components/Dashboard/DashboardMap';
import LoginModal from '../components/LoginModal';
import { appBasename } from '../init';
import '../styles/dashboard.css';

// ---------------------------------------------------------------------------
// DashboardInner — rendered inside SettingsProvider
// ---------------------------------------------------------------------------

function DashboardInner() {
  const { authStatus } = useAuth();
  const { getToken } = useCsrf();
  const { mapTileset, customTilesets, defaultMapCenterLat, defaultMapCenterLon } = useSettings();

  const isAuthenticated = authStatus?.authenticated ?? false;
  const isAdmin = authStatus?.user?.isAdmin ?? false;
  const username = authStatus?.user?.username ?? null;

  const defaultCenter = {
    lat: defaultMapCenterLat ?? 30.0,
    lng: defaultMapCenterLon ?? -90.0,
  };

  // ----- state -----
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(null);
  const [showLogin, setShowLogin] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);

  // ----- data -----
  const { data: sources = [], isSuccess } = useDashboardSources();
  const sourceIds = sources.map((s) => s.id);
  const statusMap = useSourceStatuses(sourceIds);
  const sourceData = useDashboardSourceData(selectedSourceId);

  // Auto-select first enabled source when list loads
  useEffect(() => {
    if (!isSuccess || sources.length === 0 || selectedSourceId !== null) return;
    const firstEnabled = sources.find((s) => s.enabled);
    setSelectedSourceId(firstEnabled?.id ?? sources[0].id);
  }, [isSuccess, sources, selectedSourceId]);

  // Build node-count map — selected source gets real count, others get 0
  const nodeCounts = new Map<string, number>(
    sources.map((s) => [
      s.id,
      s.id === selectedSourceId ? sourceData.nodes.length : 0,
    ]),
  );

  // ----- admin actions -----
  const onAddSource = () => {
    // TODO: wire up to existing source add modal
  };

  const onEditSource = (_id: string) => {
    // TODO: wire up to existing source edit modal
  };

  const onToggleSource = async (id: string, enabled: boolean) => {
    const csrfToken = getToken();
    await fetch(`${appBasename}/api/sources/${id}`, {
      method: 'PUT',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        'x-csrf-token': csrfToken || '',
      },
      body: JSON.stringify({ enabled }),
    });
  };

  const onDeleteSource = (id: string) => {
    setDeleteConfirm(id);
  };

  const confirmDelete = async () => {
    if (!deleteConfirm) return;
    const csrfToken = getToken();
    await fetch(`${appBasename}/api/sources/${deleteConfirm}`, {
      method: 'DELETE',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        'x-csrf-token': csrfToken || '',
      },
    });
    if (selectedSourceId === deleteConfirm) {
      setSelectedSourceId(null);
    }
    setDeleteConfirm(null);
  };

  // ----- render -----
  return (
    <div className="dashboard-root">
      {/* Top bar */}
      <header className="dashboard-topbar">
        <div className="dashboard-topbar-left">
          <span className="dashboard-logo-text">MeshMonitor</span>
        </div>
        <div className="dashboard-topbar-right">
          {isAdmin && (
            <button className="dashboard-add-source-btn" onClick={onAddSource}>
              Add Source
            </button>
          )}
          {isAuthenticated ? (
            <span className="dashboard-username">{username}</span>
          ) : (
            <button
              className="dashboard-signin-btn"
              onClick={() => setShowLogin(true)}
            >
              Sign In
            </button>
          )}
        </div>
      </header>

      {/* Body */}
      <div className="dashboard-body">
        <DashboardSidebar
          sources={sources}
          statusMap={statusMap}
          nodeCounts={nodeCounts}
          selectedSourceId={selectedSourceId}
          onSelectSource={setSelectedSourceId}
          isAdmin={isAdmin}
          isAuthenticated={isAuthenticated}
          onAddSource={onAddSource}
          onEditSource={onEditSource}
          onToggleSource={onToggleSource}
          onDeleteSource={onDeleteSource}
        />

        <main className="dashboard-main">
          <DashboardMap
            nodes={sourceData.nodes}
            traceroutes={sourceData.traceroutes}
            neighborInfo={sourceData.neighborInfo}
            channels={sourceData.channels}
            tilesetId={mapTileset}
            customTilesets={customTilesets}
            defaultCenter={defaultCenter}
          />
        </main>
      </div>

      {/* Login modal */}
      <LoginModal isOpen={showLogin} onClose={() => setShowLogin(false)} />

      {/* Delete confirmation dialog */}
      {deleteConfirm && (
        <div className="dashboard-overlay">
          <div className="dashboard-dialog">
            <p>Are you sure you want to delete this source?</p>
            <div className="dashboard-dialog-actions">
              <button onClick={confirmDelete} className="dashboard-btn-danger">
                Delete
              </button>
              <button onClick={() => setDeleteConfirm(null)}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// DashboardPage — public export; wraps in SettingsProvider
// ---------------------------------------------------------------------------

export default function DashboardPage() {
  return (
    <SettingsProvider>
      <DashboardInner />
    </SettingsProvider>
  );
}
