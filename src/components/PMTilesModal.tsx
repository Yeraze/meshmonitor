import { PMTilesDownloadHelper } from './PMTilesDownloadHelper';

interface PMTilesModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function PMTilesModal({ isOpen, onClose }: PMTilesModalProps) {
  if (!isOpen) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content large-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '900px', maxHeight: '90vh', overflow: 'auto' }}>
        <div className="modal-header">
          <h2>Offline Map Setup</h2>
          <button onClick={onClose} className="modal-close" aria-label="Close">
            &times;
          </button>
        </div>
        <div className="modal-body" style={{ padding: 0 }}>
          <PMTilesDownloadHelper />
        </div>
      </div>
    </div>
  );
}
