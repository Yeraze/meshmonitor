/**
 * ConfigEmptyState — muted "nothing here yet" line for a config section
 * (#5807), e.g. "No triggers configured yet."
 */
import React from 'react';
import styles from './ConfigSection.module.css';

export interface ConfigEmptyStateProps {
  children: React.ReactNode;
  className?: string;
}

export const ConfigEmptyState: React.FC<ConfigEmptyStateProps> = ({ children, className }) => (
  <p className={className ? `${styles.empty} ${className}` : styles.empty}>{children}</p>
);

export default ConfigEmptyState;
