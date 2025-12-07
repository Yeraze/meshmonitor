import React, { useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { getTelemetryLabel } from '../../TelemetryChart';
import { type SortOption } from '../types';

interface DashboardFiltersProps {
  // Days to view
  daysToView: number;
  maxDays: number;
  onDaysToViewChange: (days: number) => void;

  // Search
  searchQuery: string;
  onSearchChange: (query: string) => void;

  // Node filter
  selectedNode: string;
  onNodeChange: (nodeId: string) => void;
  uniqueNodes: Array<[string, string]>;

  // Type filter
  selectedType: string;
  onTypeChange: (type: string) => void;
  uniqueTypes: string[];

  // Role filter
  selectedRoles: Set<string>;
  uniqueRoles: string[];
  roleDropdownOpen: boolean;
  onToggleRoleDropdown: () => void;
  onClearRoleFilter: () => void;
  onToggleRole: (role: string, checked: boolean) => void;

  // Sort
  sortOption: SortOption;
  onSortChange: (option: SortOption) => void;
}

const DashboardFilters: React.FC<DashboardFiltersProps> = ({
  daysToView,
  maxDays,
  onDaysToViewChange,
  searchQuery,
  onSearchChange,
  selectedNode,
  onNodeChange,
  uniqueNodes,
  selectedType,
  onTypeChange,
  uniqueTypes,
  selectedRoles,
  uniqueRoles,
  roleDropdownOpen,
  onToggleRoleDropdown,
  onClearRoleFilter,
  onToggleRole,
  sortOption,
  onSortChange,
}) => {
  const { t } = useTranslation();
  const roleDropdownRef = useRef<HTMLDivElement>(null);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (roleDropdownRef.current && !roleDropdownRef.current.contains(event.target as Node)) {
        onToggleRoleDropdown();
      }
    };

    if (roleDropdownOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => {
        document.removeEventListener('mousedown', handleClickOutside);
      };
    }
  }, [roleDropdownOpen, onToggleRoleDropdown]);

  return (
    <div className="dashboard-controls">
      <div className="dashboard-filters">
        <div className="dashboard-filter-group">
          <label htmlFor="daysToView" style={{ marginRight: '0.5rem', fontWeight: '500' }}>
            {t('dashboard.days_to_view')}
          </label>
          <input
            type="number"
            id="daysToView"
            className="dashboard-number-input"
            min="1"
            max={maxDays}
            value={daysToView}
            onChange={e => onDaysToViewChange(parseInt(e.target.value) || 1)}
            style={{
              width: '80px',
              padding: '0.5rem',
              border: '1px solid #45475a',
              borderRadius: '4px',
              backgroundColor: '#1e1e2e',
              color: '#cdd6f4',
            }}
          />
        </div>

        <input
          type="text"
          className="dashboard-search"
          placeholder={t('dashboard.search_placeholder')}
          value={searchQuery}
          onChange={e => onSearchChange(e.target.value)}
        />

        <select
          className="dashboard-filter-select"
          value={selectedNode}
          onChange={e => onNodeChange(e.target.value)}
        >
          <option value="all">{t('dashboard.all_nodes')}</option>
          {uniqueNodes.map(([nodeId, nodeName]) => (
            <option key={nodeId} value={nodeId}>
              {nodeName}
            </option>
          ))}
        </select>

        <select
          className="dashboard-filter-select"
          value={selectedType}
          onChange={e => onTypeChange(e.target.value)}
        >
          <option value="all">{t('dashboard.all_types')}</option>
          {uniqueTypes.map(type => (
            <option key={type} value={type}>
              {getTelemetryLabel(type)}
            </option>
          ))}
        </select>

        <div className="dashboard-role-filter-dropdown" ref={roleDropdownRef}>
          <div className="dashboard-role-filter-button" onClick={onToggleRoleDropdown}>
            <span>
              {selectedRoles.size === 0
                ? t('dashboard.device_roles_all')
                : t('dashboard.device_roles_selected', { count: selectedRoles.size })}
            </span>
            <span className="dashboard-dropdown-arrow">{roleDropdownOpen ? '▲' : '▼'}</span>
          </div>
          {roleDropdownOpen && (
            <div className="dashboard-role-dropdown-content">
              {uniqueRoles.length > 0 ? (
                <>
                  <label className="dashboard-role-checkbox-label">
                    <input type="checkbox" checked={selectedRoles.size === 0} onChange={onClearRoleFilter} />
                    <span>{t('dashboard.all_roles')}</span>
                  </label>
                  <div className="dashboard-role-divider" />
                  {uniqueRoles.map(role => (
                    <label key={role} className="dashboard-role-checkbox-label">
                      <input
                        type="checkbox"
                        checked={selectedRoles.has(role)}
                        onChange={e => onToggleRole(role, e.target.checked)}
                      />
                      <span>{role}</span>
                    </label>
                  ))}
                </>
              ) : (
                <span className="dashboard-no-roles">{t('dashboard.no_roles')}</span>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="dashboard-sort">
        <label htmlFor="sort-select">{t('dashboard.sort_by')}</label>
        <select
          id="sort-select"
          className="dashboard-sort-select"
          value={sortOption}
          onChange={e => onSortChange(e.target.value as SortOption)}
        >
          <option value="custom">{t('dashboard.sort_custom')}</option>
          <option value="node-asc">{t('dashboard.sort_node_asc')}</option>
          <option value="node-desc">{t('dashboard.sort_node_desc')}</option>
          <option value="type-asc">{t('dashboard.sort_type_asc')}</option>
          <option value="type-desc">{t('dashboard.sort_type_desc')}</option>
        </select>
      </div>
    </div>
  );
};

export default DashboardFilters;
