import React from 'react';
import { keyPrefix, type FindingNode, type OpenNode } from './securityTypes';
import styles from './SecurityFindings.module.css';

interface FindingNodeLinkProps {
  node: FindingNode;
  onOpenNode?: OpenNode;
}

/** A node's name and key prefix; a button when the viewer can open it. */
export const FindingNodeLink: React.FC<FindingNodeLinkProps> = ({ node, onOpenNode }) => {
  const label = node.name?.trim() || keyPrefix(node.publicKey);
  const body = (
    <>
      <span className={styles.nodeName}>{label}</span>
      <span className={styles.keyFragment}>{keyPrefix(node.publicKey)}</span>
    </>
  );
  if (!onOpenNode) return <span className={styles.nodeRef}>{body}</span>;
  return (
    <button type="button" className={`${styles.nodeRef} ${styles.nodeButton}`} onClick={() => onOpenNode(node.nodeKey)}>
      {body}
    </button>
  );
};
