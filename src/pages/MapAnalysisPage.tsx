/**
 * MapAnalysisPage — cross-source map workspace with togglable visualization
 * layers, time slider, and node inspector. Public route; data still gated by
 * existing per-source permissions on each /api/analysis/* endpoint.
 */
import { SettingsProvider } from '../contexts/SettingsContext';
import { ToastProvider } from '../components/ToastContainer';
import MapAnalysisToolbar from '../components/MapAnalysis/MapAnalysisToolbar';
import MapAnalysisCanvas from '../components/MapAnalysis/MapAnalysisCanvas';
import AnalysisInspectorPanel from '../components/MapAnalysis/AnalysisInspectorPanel';
import { MapAnalysisProvider } from '../components/MapAnalysis/MapAnalysisContext';
import '../styles/map-analysis.css';

export default function MapAnalysisPage() {
  return (
    <ToastProvider>
      <SettingsProvider>
        <MapAnalysisProvider>
          <div className="map-analysis-page">
            <MapAnalysisToolbar />
            <div className="map-analysis-body">
              <MapAnalysisCanvas />
              <AnalysisInspectorPanel />
            </div>
          </div>
        </MapAnalysisProvider>
      </SettingsProvider>
    </ToastProvider>
  );
}
