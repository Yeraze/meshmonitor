/**
 * Analysis Page — coming soon placeholder.
 * Future home for cross-source analytics: network topology, coverage maps,
 * historical trends (MeshManager features).
 */

import { useNavigate } from 'react-router-dom';

export default function AnalysisPage() {
  const navigate = useNavigate();
  return (
    <div style={{
      minHeight: '100vh', background: '#111', color: '#eee',
      fontFamily: 'sans-serif', display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center', gap: 16, padding: 32,
    }}>
      <div style={{ fontSize: 48 }}>📊</div>
      <h1 style={{ margin: 0, fontSize: 28, fontWeight: 700, color: '#fff' }}>Analysis</h1>
      <p style={{ margin: 0, color: '#666', fontSize: 16, textAlign: 'center', maxWidth: 400 }}>
        Cross-source analytics — network topology, coverage maps, and historical
        trends — are coming in a future release.
      </p>
      <button
        onClick={() => navigate('/')}
        style={{
          marginTop: 8, background: '#2563eb', color: '#fff', border: 'none',
          borderRadius: 8, padding: '10px 24px', fontSize: 14, fontWeight: 600, cursor: 'pointer',
        }}
      >
        ← Back to Sources
      </button>
    </div>
  );
}
