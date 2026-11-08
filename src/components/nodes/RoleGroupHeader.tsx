import React from 'react';
import { useTranslation } from 'react-i18next';
import { UiIcon } from '../icons';
import { NODE_TYPE_CATEGORY_META, type NodeTypeCategory } from '../../utils/nodeTypeCategory';
import roleGroupingStyles from '../NodeRoleGrouping.module.css';

export interface RoleGroupHeaderProps {
  category: NodeTypeCategory;
  count: number;
  collapsed: boolean;
  onToggle: (category: NodeTypeCategory) => void;
  style?: React.CSSProperties;
  'data-index'?: number;
}

/** Collapsible role group header row. Forwards its ref so a virtualizer can measure it. */
export const RoleGroupHeader = React.forwardRef<HTMLDivElement, RoleGroupHeaderProps>(
  ({ category, count, collapsed, onToggle, style, 'data-index': dataIndex }, ref) => {
    const { t } = useTranslation();
    const meta = NODE_TYPE_CATEGORY_META[category];
    const roleLabel = t(meta.labelKey, meta.label);
    return (
      <div
        data-index={dataIndex}
        ref={ref}
        className={roleGroupingStyles.groupHeader}
        style={style}
        role="button"
        tabIndex={0}
        aria-expanded={!collapsed}
        onClick={() => onToggle(category)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onToggle(category);
          }
        }}
        title={collapsed
          ? t('nodes.expand_role_group', 'Expand {{role}} group', { role: roleLabel })
          : t('nodes.collapse_role_group', 'Collapse {{role}} group', { role: roleLabel })}
      >
        {/* Collapsed = right-pointing chevron ("expand this"), expanded = down. */}
        <UiIcon name={collapsed ? 'chevronRight' : 'chevronDown'} size={14} />
        <span className={roleGroupingStyles.groupName}>{roleLabel}</span>
        <span className={roleGroupingStyles.groupCount}>{count}</span>
      </div>
    );
  }
);
RoleGroupHeader.displayName = 'RoleGroupHeader';
