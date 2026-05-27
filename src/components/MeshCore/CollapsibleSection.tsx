import React, { useState } from 'react';

interface CollapsibleSectionProps {
  title: string;
  defaultExpanded?: boolean;
  className?: string;
  headerClassName?: string;
  children: React.ReactNode;
}

export const CollapsibleSection: React.FC<CollapsibleSectionProps> = ({
  title,
  defaultExpanded = true,
  className = '',
  headerClassName = '',
  children,
}) => {
  const [expanded, setExpanded] = useState(defaultExpanded);

  return (
    <div className={className}>
      <div
        className={`meshcore-collapsible-header ${headerClassName}`}
        onClick={() => setExpanded(v => !v)}
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setExpanded(v => !v);
          }
        }}
      >
        <h3>{title}</h3>
        <span className={`meshcore-collapsible-chevron ${expanded ? 'expanded' : ''}`}>
          ▶
        </span>
      </div>
      <div className={`meshcore-collapsible-body ${expanded ? 'expanded' : 'collapsed'}`}>
        {children}
      </div>
    </div>
  );
};
