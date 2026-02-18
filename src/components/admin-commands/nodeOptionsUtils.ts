export interface NodeOption {
  nodeNum: number;
  nodeId: string;
  longName: string;
  shortName: string;
  isLocal: boolean;
  isFavorite?: boolean;
  isIgnored?: boolean;
  hasRemoteAdmin?: boolean;
  lastRemoteAdminCheck?: number;
}

/**
 * Helper function to build node options list from nodes array
 */
export function buildNodeOptions(
  nodes: any[],
  currentNodeId: string,
  t: (key: string, options?: any) => string
): NodeOption[] {
  const options: NodeOption[] = [];
  
  if (!nodes || nodes.length === 0) {
    return options;
  }

  // Add local node first
  const localNode = nodes.find(n => (n.user?.id || n.nodeId) === currentNodeId);
  if (localNode && localNode.nodeNum !== undefined) {
    const localNodeId = localNode.user?.id || localNode.nodeId || `!${localNode.nodeNum.toString(16).padStart(8, '0')}`;
    options.push({
      nodeNum: localNode.nodeNum,
      nodeId: localNodeId,
      longName: localNode.user?.longName || localNode.longName || t('admin_commands.local_node_fallback'),
      shortName: localNode.user?.shortName || localNode.shortName || t('admin_commands.local_node_short'),
      isLocal: true,
      isFavorite: localNode.isFavorite ?? false,
      isIgnored: localNode.isIgnored ?? false,
      hasRemoteAdmin: localNode.hasRemoteAdmin ?? false,
      lastRemoteAdminCheck: localNode.lastRemoteAdminCheck,
    });
  }

  // Add other nodes - include all nodes with nodeNum, even if nodeId is missing
  nodes
    .filter(n => {
      // Exclude local node
      const nodeId = n.user?.id || n.nodeId;
      if (nodeId === currentNodeId) return false;
      // Include if it has a nodeNum (required for admin commands)
      return n.nodeNum !== undefined && n.nodeNum !== null;
    })
    .forEach(node => {
      const nodeId = node.user?.id || node.nodeId || `!${node.nodeNum.toString(16).padStart(8, '0')}`;
      const longName = node.user?.longName || node.longName;
      const shortName = node.user?.shortName || node.shortName;
      options.push({
        nodeNum: node.nodeNum,
        nodeId: nodeId,
        longName: longName || `Node ${nodeId}`,
        shortName: shortName || nodeId.slice(-4),
        isLocal: false,
        isFavorite: node.isFavorite ?? false,
        isIgnored: node.isIgnored ?? false,
        hasRemoteAdmin: node.hasRemoteAdmin ?? false,
        lastRemoteAdminCheck: node.lastRemoteAdminCheck,
      });
    });

  return options;
}

/**
 * Helper function to sort node options for Remote Admin page
 * Sort order: local node first, then hasRemoteAdmin=true, then alphabetically by longName
 */
export function sortNodeOptionsForRemoteAdmin(nodes: NodeOption[]): NodeOption[] {
  return [...nodes].sort((a, b) => {
    // Local node always first
    if (a.isLocal && !b.isLocal) return -1;
    if (!a.isLocal && b.isLocal) return 1;

    // Then nodes with remote admin access
    if (a.hasRemoteAdmin && !b.hasRemoteAdmin) return -1;
    if (!a.hasRemoteAdmin && b.hasRemoteAdmin) return 1;

    // Then alphabetically by longName
    return a.longName.localeCompare(b.longName);
  });
}

/**
 * Helper function to filter nodes based on search query
 */
export function filterNodes(nodes: NodeOption[], searchQuery: string): NodeOption[] {
  if (!searchQuery.trim()) {
    return nodes;
  }
  const lowerSearch = searchQuery.toLowerCase().trim();
  return nodes.filter(node => {
    const longName = node.longName.toLowerCase();
    const shortName = node.shortName.toLowerCase();
    const nodeId = node.nodeId.toLowerCase();
    const nodeNumHex = node.nodeNum.toString(16).padStart(8, '0');
    return longName.includes(lowerSearch) ||
           shortName.includes(lowerSearch) ||
           nodeId.includes(lowerSearch) ||
           nodeNumHex.includes(lowerSearch) ||
           node.nodeNum.toString().includes(lowerSearch);
  });
}

