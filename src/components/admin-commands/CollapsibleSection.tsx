import React from 'react';

interface CollapsibleSectionProps {
  id: string;
  title: string;
  children: React.ReactNode;
  defaultExpanded?: boolean;
  headerActions?: React.ReactNode;
  className?: string;
  nested?: boolean;
  isExpanded?: boolean;
  onToggle?: () => void;
}

const CollapsibleSection: React.FC<CollapsibleSectionProps> = ({
  id: _id,
  title,
  children,
  defaultExpanded,
  headerActions,
  className = '',
  nested = false,
  isExpanded,
  onToggle,
}) => {
  const expanded = isExpanded ?? defaultExpanded ?? false;

  return (
    <div className={`collapsible-section ${nested ? 'nested' : ''} ${className}`} style={{ marginBottom: nested ? '0.5rem' : '1rem' }}>
      <div
        className="collapsible-header"
        onClick={onToggle}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0.75rem 1rem',
          backgroundColor: nested ? 'var(--ctp-surface0)' : 'var(--ctp-mantle)',
          borderRadius: '8px',
          cursor: 'pointer',
          userSelect: 'none',
          marginBottom: expanded ? '0.5rem' : '0',
          transition: 'background-color 0.2s',
          border: `1px solid ${nested ? 'var(--ctp-surface1)' : 'var(--ctp-surface2)'}`,
          paddingLeft: nested ? '2rem' : '1rem',
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.backgroundColor = nested ? 'var(--ctp-surface1)' : 'var(--ctp-surface0)';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.backgroundColor = nested ? 'var(--ctp-surface0)' : 'var(--ctp-mantle)';
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flex: 1 }}>
          <span style={{ fontSize: '0.875rem', transition: 'transform 0.2s', transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)' }}>
            ▶
          </span>
          <h3 style={{ margin: 0, fontSize: nested ? '0.95rem' : '1rem', fontWeight: nested ? 500 : 600, color: 'var(--ctp-text)' }}>
            {title}
          </h3>
        </div>
        {headerActions && <div>{headerActions}</div>}
      </div>
      {expanded && (
        <div
          className="collapsible-content"
          style={{
            padding: nested ? '0.5rem 0 0.5rem 2rem' : '0.5rem 0 0.5rem 1rem',
            animation: 'fadeIn 0.2s ease-in',
          }}
        >
          {children}
        </div>
      )}
    </div>
  );
};

export default CollapsibleSection;

