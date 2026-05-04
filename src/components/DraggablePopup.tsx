import { useEffect, useRef } from 'react';
import { Popup, useMap } from 'react-leaflet';
import type { PopupProps } from 'react-leaflet';
import L from 'leaflet';

/**
 * Popup that can be dragged by its content wrapper. Drag is session-only —
 * closing/re-opening resets to the click anchor.
 *
 * Buttons, links, and form inputs inside the popup body still receive clicks
 * (drag is suppressed when the mousedown target is one of those elements).
 */
export function DraggablePopup({ children, ...rest }: PopupProps) {
  const popupRef = useRef<L.Popup | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  const map = useMap();

  useEffect(() => () => { cleanupRef.current?.(); cleanupRef.current = null; }, []);

  const attach = () => {
    const popup = popupRef.current;
    if (!popup) return;
    const el = popup.getElement();
    if (!el || !map) return;
    const wrapper = el.querySelector('.leaflet-popup-content-wrapper') as HTMLElement | null;
    if (!wrapper) return;

    wrapper.style.cursor = 'grab';
    wrapper.title = 'Drag to reposition';

    let dragging = false;
    let startX = 0;
    let startY = 0;
    let startLatLng: L.LatLng | null = null;

    const onMouseMove = (e: MouseEvent) => {
      if (!dragging || !startLatLng) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      const startPoint = map.latLngToContainerPoint(startLatLng);
      const newPoint = startPoint.add(L.point(dx, dy));
      popup.setLatLng(map.containerPointToLatLng(newPoint));
    };

    const onMouseUp = () => {
      if (!dragging) return;
      dragging = false;
      wrapper.style.cursor = 'grab';
      map.dragging.enable();
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };

    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest('button, a, input, select, textarea, .leaflet-popup-close-button')) return;
      const ll = popup.getLatLng();
      if (!ll) return;
      dragging = true;
      startX = e.clientX;
      startY = e.clientY;
      startLatLng = ll;
      wrapper.style.cursor = 'grabbing';
      map.dragging.disable();
      e.preventDefault();
      e.stopPropagation();
      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    };

    wrapper.addEventListener('mousedown', onMouseDown);

    cleanupRef.current = () => {
      wrapper.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      map.dragging.enable();
    };
  };

  const detach = () => {
    cleanupRef.current?.();
    cleanupRef.current = null;
  };

  return (
    <Popup
      autoPan={false}
      {...rest}
      ref={(instance) => {
        popupRef.current = instance ?? null;
      }}
      eventHandlers={{
        ...(rest.eventHandlers ?? {}),
        add: (e) => {
          attach();
          rest.eventHandlers?.add?.(e);
        },
        remove: (e) => {
          detach();
          rest.eventHandlers?.remove?.(e);
        },
      }}
    >
      {children}
    </Popup>
  );
}

export default DraggablePopup;
