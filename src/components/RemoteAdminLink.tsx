/**
 * "Open remote admin" — a deep link from a node's Remote Admin status badge
 * straight into the Admin Commands tab, pre-selecting that node (#5535).
 *
 * Mirrors `Analysis/ShowCoverageLink.tsx`: falls back to a plain
 * basename-prefixed `<a href>` (`useInRouterContext()` gated) when rendered
 * outside a Router, so existing `NodeDetailsBlock` tests that render it
 * without wrapping in a Router keep passing unchanged.
 *
 * The caller decides *whether* this should render as a link at all — it
 * only wraps `children` when both the node is admin-capable ("Available")
 * and the current user holds the permission the Admin Commands route
 * itself requires (`authStatus?.user?.isAdmin`, checked by the caller via
 * `useAuth()` and passed down as `enabled`, never read from context here —
 * that keeps this component usable in tests with no `AuthProvider`).
 */
import React from 'react';
import { Link, useInRouterContext } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { buildAdminCommandsPath, parseAdminDeepLink } from '../utils/adminDeepLink';
import { appBasename } from '../init';
import styles from './RemoteAdminLink.module.css';

export interface RemoteAdminLinkProps {
  /** Meshtastic `!xxxxxxxx` node id to pre-select on the Admin Commands tab. */
  nodeId: string;
  /** Node's display name, used to build the accessible label. */
  nodeName: string;
  /**
   * Whether the badge should actually be interactive. `false` (or an
   * invalid `nodeId`) renders `children` unwrapped, inert text — same look,
   * no control.
   */
  enabled: boolean;
  children: React.ReactNode;
}

export const RemoteAdminLink: React.FC<RemoteAdminLinkProps> = ({ nodeId, nodeName, enabled, children }) => {
  const { t } = useTranslation();
  const inRouterContext = useInRouterContext();

  // Validate via a round trip through `parseAdminDeepLink` — single source
  // of truth for the accepted id shape — then rebuild the final path from
  // the *canonical* (lowercased) node id it returns.
  const rawPath = buildAdminCommandsPath({ node: nodeId });
  const rawQueryString = rawPath.split('?')[1] ?? '';
  const accepted = parseAdminDeepLink(new URLSearchParams(rawQueryString));

  if (!enabled || !accepted?.node) {
    return <>{children}</>;
  }

  const path = buildAdminCommandsPath({ node: accepted.node });
  const label = t('node_details.open_remote_admin', 'Open remote admin for {{name}}', { name: nodeName });

  if (inRouterContext) {
    return (
      <Link to={path} className={styles.link} aria-label={label} title={label}>
        {children}
      </Link>
    );
  }

  return (
    <a href={`${appBasename}${path}`} className={styles.link} aria-label={label} title={label}>
      {children}
    </a>
  );
};

export default RemoteAdminLink;
