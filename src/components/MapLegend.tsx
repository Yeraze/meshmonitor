import React from 'react';
import { getHopColor } from '../utils/mapIcons';

const MapLegend: React.FC = () => {
  const legendItems = [
    { hops: '0', color: getHopColor(0), label: 'Direct (0 hops)' },
    { hops: '1-3', color: getHopColor(1), label: '1-3 Hops' },
    { hops: '4-5', color: getHopColor(4), label: '4-5 Hops' },
    { hops: '6+', color: getHopColor(6), label: '6+ / Unknown' }
  ];

  return (
    <div style={{
      position: 'absolute',
      top: '10px',
      left: '10px',
      zIndex: 1000,
      background: 'white',
      padding: '10px',
      borderRadius: '4px',
      boxShadow: '0 1px 5px rgba(0,0,0,0.4)',
      fontSize: '12px',
      fontFamily: 'system-ui, -apple-system, sans-serif',
      color: '#000'
    }}>
      <div style={{ fontWeight: 'bold', marginBottom: '8px', fontSize: '13px', color: '#000' }}>
        Hop Distance
      </div>
      {legendItems.map((item, index) => (
        <div key={index} style={{ display: 'flex', alignItems: 'center', marginBottom: '4px' }}>
          <div style={{
            width: '16px',
            height: '16px',
            borderRadius: '50%',
            backgroundColor: item.color,
            marginRight: '8px',
            border: '1px solid rgba(0,0,0,0.2)'
          }} />
          <span style={{ color: '#000' }}>{item.label}</span>
        </div>
      ))}
    </div>
  );
};

export default MapLegend;
