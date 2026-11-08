import React from 'react';
import { useTranslation } from 'react-i18next';
import { NODE_TYPE_CATEGORY_META } from '../../utils/nodeTypeCategory';
import type { RoleGroupCount } from '../../utils/nodeGrouping';
import roleGroupingStyles from '../NodeRoleGrouping.module.css';

// Number of role categories the distribution summary gives a distinct
// `--chart-N` colour (the app's categorical scale only defines 8 slots, and
// per the dataviz convention categorical hues are assigned in fixed order and
// never cycled — a 9th+ category folds into a single muted "Other" segment
// rather than reusing an earlier colour).
const ROLE_SUMMARY_MAX_COLORED_CATEGORIES = 8;

/**
 * Compact role-distribution summary shown above the node list when the
 * "Group by role" toggle is on (grouping requirement #3). A single-row
 * stacked bar (inline SVG, coloured with the app's `--chart-N` categorical
 * custom properties so it tracks every Catppuccin variant) plus a legend of
 * role name + count chips — the chips are the accessible source of truth
 * (identity is never colour-alone), so the SVG itself is decorative.
 */
export const RoleDistributionSummary = React.memo<{
  distribution: RoleGroupCount[];
}>(({ distribution }) => {
  const { t } = useTranslation();
  const total = distribution.reduce((sum, r) => sum + r.count, 0);
  if (total === 0) return null;

  const colored = distribution.slice(0, ROLE_SUMMARY_MAX_COLORED_CATEGORIES);
  const overflow = distribution.slice(ROLE_SUMMARY_MAX_COLORED_CATEGORIES);
  const otherCount = overflow.reduce((sum, r) => sum + r.count, 0);

  const chips = colored.map((r, i) => {
    const meta = NODE_TYPE_CATEGORY_META[r.category];
    return {
      key: r.category as string,
      label: t(meta.labelKey, meta.label),
      count: r.count,
      color: `var(--chart-${i + 1})`,
    };
  });
  if (otherCount > 0) {
    chips.push({
      key: 'other',
      label: t('nodes.other_roles', 'Other'),
      count: otherCount,
      color: 'var(--color-text-disabled)',
    });
  }

  // Lay segments out in a fixed 1000-unit viewBox with a small fixed gap
  // between them (renders as ~2px at typical sidebar widths), stretched to
  // fill the wrapper's actual width/height — the wrapper clips to a pill
  // shape via border-radius + overflow:hidden, so segments themselves stay
  // plain rectangles rather than fighting non-uniform SVG scaling with rx.
  const VIEWBOX_WIDTH = 1000;
  const GAP_UNITS = chips.length > 1 ? 6 : 0;
  const usableWidth = VIEWBOX_WIDTH - GAP_UNITS * (chips.length - 1);
  let cursor = 0;
  const segments = chips.map((chip) => {
    const width = Math.max((chip.count / total) * usableWidth, 0);
    const x = cursor;
    cursor += width + GAP_UNITS;
    return { ...chip, x, width };
  });

  return (
    <div className={roleGroupingStyles.summary}>
      <div className={roleGroupingStyles.summaryTitle}>{t('nodes.role_distribution', 'Role distribution')}</div>
      <div className={roleGroupingStyles.summaryBarWrap}>
        <svg
          viewBox={`0 0 ${VIEWBOX_WIDTH} 14`}
          preserveAspectRatio="none"
          className={roleGroupingStyles.summaryBar}
          aria-hidden="true"
        >
          {segments.map((seg) => (
            <rect key={seg.key} x={seg.x} y={0} width={seg.width} height={14} fill={seg.color}>
              <title>{`${seg.label}: ${seg.count}`}</title>
            </rect>
          ))}
        </svg>
      </div>
      <div className={roleGroupingStyles.summaryLegend}>
        {chips.map((chip) => (
          <span className={roleGroupingStyles.summaryChip} key={chip.key}>
            <span className={roleGroupingStyles.summarySwatch} style={{ background: chip.color }} />
            {chip.label}
            <span className={roleGroupingStyles.summaryChipCount}>{chip.count}</span>
          </span>
        ))}
      </div>
    </div>
  );
});
