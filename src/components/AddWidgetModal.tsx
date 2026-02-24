/**
 * AddWidgetModal - Modal for adding new dashboard widgets
 */

import React from 'react';
import { useTranslation } from 'react-i18next';

export type WidgetType = 'nodeStatus' | 'traceroute';

interface WidgetOption {
  type: WidgetType;
  titleKey: string;
  descriptionKey: string;
  icon: string;
}

const WIDGET_OPTIONS: WidgetOption[] = [
  {
    type: 'nodeStatus',
    titleKey: 'dashboard.widget.node_status.title',
    descriptionKey: 'dashboard.widget.node_status.description',
    icon: '📊',
  },
  {
    type: 'traceroute',
    titleKey: 'dashboard.widget.traceroute.title',
    descriptionKey: 'dashboard.widget.traceroute.description',
    icon: '🔀',
  },
];

interface AddWidgetModalProps {
  isOpen: boolean;
  onClose: () => void;
  onAddWidget: (type: WidgetType) => void;
}

const AddWidgetModal: React.FC<AddWidgetModalProps> = ({ isOpen, onClose, onAddWidget }) => {
  const { t } = useTranslation();
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
          <h2>{t('dashboard.add_widget')}</h2>
          <button className="add-widget-modal-close" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="add-widget-modal-content">
          {WIDGET_OPTIONS.map(option => (
            <div key={option.type} className="add-widget-option" onClick={() => handleAddWidget(option.type)}>
              <div className="add-widget-option-icon">{option.icon}</div>
              <div className="add-widget-option-info">
                <h3>{t(option.titleKey)}</h3>
                <p>{t(option.descriptionKey)}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

export default AddWidgetModal;
