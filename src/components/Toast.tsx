import React, { useEffect } from 'react';
import { UiIcon, type UiIconName } from './icons';

export interface ToastProps {
  id: string;
  message: string;
  type: 'success' | 'error' | 'info' | 'warning';
  duration?: number;
  onClose: (id: string) => void;
}

const Toast: React.FC<ToastProps> = ({ id, message, type, duration = 5000, onClose }) => {
  useEffect(() => {
    const timer = setTimeout(() => {
      onClose(id);
    }, duration);

    return () => clearTimeout(timer);
  }, [id, duration, onClose]);

  const backgroundColor = {
    success: 'var(--ctp-green)',
    error: 'var(--ctp-red)',
    warning: 'var(--ctp-peach)',
    info: 'var(--ctp-blue)'
  }[type];

  const icons: Record<ToastProps['type'], UiIconName> = {
    success: 'check',
    error: 'error',
    warning: 'alert',
    info: 'info'
  };
  const icon = icons[type];

  return (
    <div
      style={{
        backgroundColor,
        color: 'var(--ctp-crust, #1e1e2e)',
        padding: '1rem 1.5rem',
        borderRadius: '4px',
        boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
        display: 'flex',
        alignItems: 'center',
        gap: '0.75rem',
        minWidth: '300px',
        maxWidth: '500px',
        animation: 'slideIn 0.3s ease-out',
        marginBottom: '0.5rem'
      }}
    >
      <span style={{ fontSize: '1.5rem', fontWeight: 'bold' }}><UiIcon name={icon} /></span>
      <span style={{ flex: 1, fontSize: '0.95rem' }}>{message}</span>
      <button
        onClick={() => onClose(id)}
        aria-label="Close notification"
        style={{
          background: 'none',
          border: 'none',
          color: 'var(--ctp-crust, #1e1e2e)',
          fontSize: '1.25rem',
          cursor: 'pointer',
          padding: '0 0.25rem',
          opacity: 0.8
        }}
        onMouseEnter={(e) => e.currentTarget.style.opacity = '1'}
        onMouseLeave={(e) => e.currentTarget.style.opacity = '0.8'}
      >
        <UiIcon name="close" size={16} />
      </button>
    </div>
  );
};

export default Toast;
