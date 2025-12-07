import React, { useRef, useEffect } from 'react';
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
            Days to View:
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
          placeholder="Search nodes or telemetry types..."
          value={searchQuery}
          onChange={e => onSearchChange(e.target.value)}
        />

        <select
          className="dashboard-filter-select"
          value={selectedNode}
          onChange={e => onNodeChange(e.target.value)}
        >
          <option value="all">All Nodes</option>
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
          <option value="all">All Types</option>
          {uniqueTypes.map(type => (
            <option key={type} value={type}>
              {getTelemetryLabel(type)}
            </option>
          ))}
        </select>

        <div className="dashboard-role-filter-dropdown" ref={roleDropdownRef}>
          <div className="dashboard-role-filter-button" onClick={onToggleRoleDropdown}>
            <span>
              {selectedRoles.size === 0 ? 'Device Roles: All' : `Device Roles: ${selectedRoles.size} selected`}
            </span>
            <span className="dashboard-dropdown-arrow">{roleDropdownOpen ? '▲' : '▼'}</span>
          </div>
          {roleDropdownOpen && (
            <div className="dashboard-role-dropdown-content">
              {uniqueRoles.length > 0 ? (
                <>
                  <label className="dashboard-role-checkbox-label">
                    <input type="checkbox" checked={selectedRoles.size === 0} onChange={onClearRoleFilter} />
                    <span>All Roles</span>
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
                <span className="dashboard-no-roles">No roles available</span>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="dashboard-sort">
        <label htmlFor="sort-select">Sort by:</label>
        <select
          id="sort-select"
          className="dashboard-sort-select"
          value={sortOption}
          onChange={e => onSortChange(e.target.value as SortOption)}
        >
          <option value="custom">Custom Order (Drag & Drop)</option>
          <option value="node-asc">Node Name (A-Z)</option>
          <option value="node-desc">Node Name (Z-A)</option>
          <option value="type-asc">Telemetry Type (A-Z)</option>
          <option value="type-desc">Telemetry Type (Z-A)</option>
        </select>
      </div>
    </div>
  );
};

export default DashboardFilters;
