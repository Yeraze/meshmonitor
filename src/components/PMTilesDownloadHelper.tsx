import { useState, useEffect } from 'react';

interface PMTilesStatus {
  installed: boolean;
  size: number;
  sizeFormatted: string;
  path: string;
}

interface Coverage {
  hasCoverage: boolean;
  bounds?: {
    minLat: number;
    maxLat: number;
    minLon: number;
    maxLon: number;
    centerLat: number;
    centerLon: number;
    nodeCount: number;
  };
  message?: string;
}

interface Recommendation {
  id: string;
  name: string;
  url: string;
  size: string;
  sizeBytes: number;
  description: string;
  matchScore: number;
}

export function PMTilesDownloadHelper() {
  const [status, setStatus] = useState<PMTilesStatus | null>(null);
  const [coverage, setCoverage] = useState<Coverage | null>(null);
  const [recommendations, setRecommendations] = useState<Recommendation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = async () => {
    setLoading(true);
    setError(null);

    try {
      // Use window.location.pathname to detect the base path at runtime
      // If the page is at /meshmonitor/*, the API is at /meshmonitor/api/*
      // If the page is at /*, the API is at /api/*
      const pathname = window.location.pathname;
      const baseMatch = pathname.match(/^(\/[^/]+)\//);
      const basePath = baseMatch ? baseMatch[1] : '';
      const apiBase = basePath ? `${basePath}/api` : '/api';

      const [statusRes, coverageRes, recsRes] = await Promise.all([
        fetch(`${apiBase}/pmtiles/status`),
        fetch(`${apiBase}/pmtiles/coverage`),
        fetch(`${apiBase}/pmtiles/recommendations`)
      ]);

      if (!statusRes.ok || !coverageRes.ok || !recsRes.ok) {
        throw new Error('Failed to load PMTiles information');
      }

      const statusData = await statusRes.json();
      const coverageData = await coverageRes.json();
      const recsData = await recsRes.json();

      setStatus(statusData);
      setCoverage(coverageData);
      setRecommendations(recsData.recommendations);
    } catch (err) {
      setError('Failed to load PMTiles information');
      console.error('Error loading PMTiles data:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  if (loading) {
    return (
      <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-6 mt-4">
        <div className="flex items-center space-x-3">
          <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-blue-600"></div>
          <span className="text-gray-600 dark:text-gray-300">Loading offline map information...</span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-red-50 dark:bg-red-900/20 rounded-lg p-6 mt-4">
        <p className="text-red-800 dark:text-red-200">{error}</p>
        <button
          onClick={fetchData}
          className="mt-3 px-4 py-2 bg-red-600 text-white rounded hover:bg-red-700 transition-colors"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div style={{ padding: '1rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      {/* Status Section */}
      <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-4">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
            Offline Map Status
          </h3>
          <button
            onClick={fetchData}
            className="text-sm px-3 py-1 bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 rounded hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors"
          >
            Refresh
          </button>
        </div>

        {status?.installed ? (
          <div>
            <p className="font-medium text-gray-900 dark:text-white">
              Offline map installed
            </p>
            <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
              File size: {status.sizeFormatted}
            </p>
            <p className="text-xs text-gray-500 dark:text-gray-500 mt-1">
              Location: {status.path}
            </p>
          </div>
        ) : (
          <div>
            <p className="font-medium text-gray-900 dark:text-white">
              No offline map installed
            </p>
            <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
              Download and install a PMTiles file to enable offline maps
            </p>
          </div>
        )}
      </div>

      {/* Coverage Section */}
      {coverage?.hasCoverage && coverage.bounds && (
        <div className="bg-blue-50 dark:bg-blue-900/20 rounded-lg border border-blue-200 dark:border-blue-800 p-4">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">
            Your Network Coverage
          </h3>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '1rem' }}>
            <div className="bg-white dark:bg-gray-800 rounded-lg p-3 border border-blue-200 dark:border-blue-700">
              <p className="text-xs text-gray-600 dark:text-gray-400 mb-1">Total Nodes</p>
              <p className="text-2xl font-bold text-blue-600 dark:text-blue-400">{coverage.bounds.nodeCount}</p>
            </div>
            <div className="bg-white dark:bg-gray-800 rounded-lg p-3 border border-blue-200 dark:border-blue-700">
              <p className="text-xs text-gray-600 dark:text-gray-400 mb-1">Center Point</p>
              <p className="text-sm font-mono text-gray-900 dark:text-white">
                {coverage.bounds.centerLat.toFixed(4)}, {coverage.bounds.centerLon.toFixed(4)}
              </p>
            </div>
          </div>
          <div className="mt-3 bg-white dark:bg-gray-800 rounded-lg p-3 border border-blue-200 dark:border-blue-700">
            <p className="text-xs text-gray-600 dark:text-gray-400 mb-2">Coverage Area (with 20% buffer)</p>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem', fontSize: '0.75rem' }}>
              <div>
                <span className="text-gray-600 dark:text-gray-400">Lat Range:</span>
                <span className="ml-2 font-mono text-gray-900 dark:text-white">
                  {coverage.bounds.minLat.toFixed(4)} to {coverage.bounds.maxLat.toFixed(4)}
                </span>
              </div>
              <div>
                <span className="text-gray-600 dark:text-gray-400">Lon Range:</span>
                <span className="ml-2 font-mono text-gray-900 dark:text-white">
                  {coverage.bounds.minLon.toFixed(4)} to {coverage.bounds.maxLon.toFixed(4)}
                </span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Recommendations Section */}
      {recommendations.length > 0 && (
        <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-4">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">
            Recommended Downloads
          </h3>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '1rem' }}>
            {recommendations.map((rec) => (
              <div
                key={rec.id}
                className="bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg p-4 hover:border-blue-500 dark:hover:border-blue-500 hover:shadow-md transition-all"
                style={{ display: 'flex', flexDirection: 'column' }}
              >
                <div style={{ flex: '1' }}>
                  <div className="flex items-center space-x-2 mb-2">
                    <h4 className="font-semibold text-gray-900 dark:text-white">
                      {rec.name}
                    </h4>
                    {rec.matchScore > 0 && (
                      <span className="px-2 py-0.5 text-xs bg-blue-100 dark:bg-blue-900 text-blue-800 dark:text-blue-200 rounded font-medium">
                        Best Match
                      </span>
                    )}
                  </div>
                  <p className="text-sm text-gray-600 dark:text-gray-400 mb-3">
                    {rec.description}
                  </p>
                  <div className="flex items-center justify-between text-xs text-gray-500 dark:text-gray-500 mb-3">
                    <span>Size: {rec.size}</span>
                  </div>
                </div>
                <a
                  href={rec.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="w-full px-4 py-2 bg-blue-600 text-white text-sm text-center rounded hover:bg-blue-700 transition-colors font-medium"
                  style={{ display: 'block', textDecoration: 'none' }}
                >
                  Download
                </a>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Installation Instructions */}
      <div className="bg-gray-50 dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-700 p-4">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-3">
          Installation Instructions
        </h3>
        <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          <li style={{ display: 'flex', alignItems: 'flex-start', gap: '0.75rem' }}>
            <span className="flex-shrink-0 w-6 h-6 bg-blue-600 text-white rounded-full flex items-center justify-center text-xs font-medium">
              1
            </span>
            <span className="text-sm text-gray-700 dark:text-gray-300">
              Download a PMTiles file from one of the recommended sources above
            </span>
          </li>
          <li style={{ display: 'flex', alignItems: 'flex-start', gap: '0.75rem' }}>
            <span className="flex-shrink-0 w-6 h-6 bg-blue-600 text-white rounded-full flex items-center justify-center text-xs font-medium">
              2
            </span>
            <span className="text-sm text-gray-700 dark:text-gray-300">
              Rename the file to <code className="px-1.5 py-0.5 bg-gray-200 dark:bg-gray-800 rounded font-mono text-xs">basemap.pmtiles</code>
            </span>
          </li>
          <li style={{ display: 'flex', alignItems: 'flex-start', gap: '0.75rem' }}>
            <span className="flex-shrink-0 w-6 h-6 bg-blue-600 text-white rounded-full flex items-center justify-center text-xs font-medium">
              3
            </span>
            <div className="text-sm text-gray-700 dark:text-gray-300">
              <p>Place the file in the <code className="px-1.5 py-0.5 bg-gray-200 dark:bg-gray-800 rounded font-mono text-xs">public/pmtiles/</code> directory</p>
              <p className="text-xs text-gray-500 dark:text-gray-500 mt-1">
                For Docker: Copy to <code className="px-1 py-0.5 bg-gray-200 dark:bg-gray-800 rounded font-mono">./public/pmtiles/basemap.pmtiles</code> on the host system
              </p>
            </div>
          </li>
          <li style={{ display: 'flex', alignItems: 'flex-start', gap: '0.75rem' }}>
            <span className="flex-shrink-0 w-6 h-6 bg-blue-600 text-white rounded-full flex items-center justify-center text-xs font-medium">
              4
            </span>
            <span className="text-sm text-gray-700 dark:text-gray-300">
              Click the "Refresh" button above to verify the installation
            </span>
          </li>
          <li style={{ display: 'flex', alignItems: 'flex-start', gap: '0.75rem' }}>
            <span className="flex-shrink-0 w-6 h-6 bg-blue-600 text-white rounded-full flex items-center justify-center text-xs font-medium">
              5
            </span>
            <span className="text-sm text-gray-700 dark:text-gray-300">
              Select "Offline Map (PMTiles)" from the Map Tileset dropdown above
            </span>
          </li>
        </ul>

        <div className="mt-4 pt-4 border-t border-gray-200 dark:border-gray-700">
          <p className="text-xs text-gray-600 dark:text-gray-400">
            For detailed instructions and troubleshooting, see{' '}
            <a
              href="https://github.com/yeraze/meshmonitor/blob/main/PMTILES.md"
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-600 dark:text-blue-400 hover:underline"
            >
              PMTILES.md
            </a>
          </p>
        </div>
      </div>
    </div>
  );
}
