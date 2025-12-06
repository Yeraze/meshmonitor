/**
 * AddWidgetModal - Modal for adding new dashboard widgets
 */

import React from 'react';

export type WidgetType = 'nodeStatus' | 'traceroute';

interface WidgetOption {
  type: WidgetType;
  title: string;
  description: string;
  icon: string;
}

const WIDGET_OPTIONS: WidgetOption[] = [
  {
    type: 'nodeStatus',
    title: 'Node Status',
    description: 'Monitor multiple nodes with a table showing name, last heard time, and hop count.',
    icon: '📊',
  },
  {
    type: 'traceroute',
    title: 'Traceroute',
    description: 'View the last successful traceroute to and from a selected node.',
    icon: '🔀',
  },
];

interface AddWidgetModalProps {
  isOpen: boolean;
  onClose: () => void;
  onAddWidget: (type: WidgetType) => void;
}

const AddWidgetModal: React.FC<AddWidgetModalProps> = ({ isOpen, onClose, onAddWidget }) => {
  if (!isOpen) return null;

  const handleBackdropClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  };

  const handleAddWidget = (type: WidgetType) => {
    onAddWidget(type);
    onClose();
  };

  return (
    <div className="add-widget-modal-backdrop" onClick={handleBackdropClick}>
      <div className="add-widget-modal">
        <div className="add-widget-modal-header">
          <h2>Add Widget</h2>
          <button className="add-widget-modal-close" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="add-widget-modal-content">
          {WIDGET_OPTIONS.map(option => (
            <div key={option.type} className="add-widget-option" onClick={() => handleAddWidget(option.type)}>
              <div className="add-widget-option-icon">{option.icon}</div>
              <div className="add-widget-option-info">
                <h3>{option.title}</h3>
                <p>{option.description}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

export default AddWidgetModal;
