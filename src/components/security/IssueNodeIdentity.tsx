import React from 'react';
import { getHardwareModelName } from '../../utils/hardwareModel';
import { keyPrefix, type SecurityIssueView } from './securityTypes';

const ADV_TYPE_LABEL: Record<number, string> = { 1: 'Companion', 2: 'Repeater', 3: 'Room Server', 4: 'Sensor' };

/** The id line of an issue card: `Node #HEX - hardware` on Meshtastic, key prefix and type on MeshCore. */
export const IssueNodeIdentity: React.FC<{ node: SecurityIssueView }> = ({ node }) => {
  if (node.protocol === 'meshcore') {
    return (
      <div className="node-id">
        {keyPrefix(node.publicKey)}
        {node.advType != null && ADV_TYPE_LABEL[node.advType] && (
          <span className="hw-model"> - {ADV_TYPE_LABEL[node.advType]}</span>
        )}
      </div>
    );
  }
  return (
    <div className="node-id">
      Node #{node.nodeNum.toString(16).toUpperCase()}
      {node.hwModel !== undefined && node.hwModel !== 0 && (
        <span className="hw-model"> - {getHardwareModelName(node.hwModel)}</span>
      )}
    </div>
  );
};
