import React, { useEffect } from 'react';

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
    success: '#4caf50',
    error: '#f44336',
    warning: '#ff9800',
    info: '#2196f3'
  }[type];

  const icon = {
    success: '✓',
    error: '✕',
    warning: '⚠',
    info: 'ℹ'
  }[type];

  return (
    <div
      style={{
        backgroundColor,
        color: 'white',
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
      <span style={{ fontSize: '1.5rem', fontWeight: 'bold' }}>{icon}</span>
      <span style={{ flex: 1, fontSize: '0.95rem' }}>{message}</span>
      <button
        onClick={() => onClose(id)}
        style={{
          background: 'none',
          border: 'none',
          color: 'white',
          fontSize: '1.25rem',
          cursor: 'pointer',
          padding: '0 0.25rem',
          opacity: 0.8
        }}
        onMouseEnter={(e) => e.currentTarget.style.opacity = '1'}
        onMouseLeave={(e) => e.currentTarget.style.opacity = '0.8'}
      >
        ×
      </button>
    </div>
  );
};

export default Toast;
