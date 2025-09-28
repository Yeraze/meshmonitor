import L from 'leaflet';

export const ROLE_NAMES: Record<number, string> = {
  0: 'Client',
  1: 'Client Mute',
  2: 'Router',
  3: 'Router Client',
  4: 'Repeater',
  5: 'Tracker',
  6: 'Sensor',
  7: 'TAK',
  8: 'Client Hidden',
  9: 'Lost and Found',
  10: 'TAK Tracker'
};

export const DEFAULT_ICON = new L.Icon({
  iconUrl: 'https://unpkg.com/leaflet@1.7.1/dist/images/marker-icon.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.7.1/dist/images/marker-shadow.png',
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
});

export const SELECTED_ICON = new L.Icon({
  iconUrl: 'https://unpkg.com/leaflet@1.7.1/dist/images/marker-icon.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.7.1/dist/images/marker-shadow.png',
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
  className: 'selected-marker'
});

export const MESSAGE_SANITIZATION_REGEX = /[\x00-\x1F\x7F-\x9F]/g;