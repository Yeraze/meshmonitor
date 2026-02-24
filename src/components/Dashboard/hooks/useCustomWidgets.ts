import { useCallback } from 'react';
import { useCsrfFetch } from '../../../hooks/useCsrfFetch';
import { logger } from '../../../utils/logger';
import { type CustomWidget } from '../types';
import { type WidgetType } from '../../AddWidgetModal';

interface UseCustomWidgetsOptions {
  baseUrl: string;
  customWidgets: CustomWidget[];
  setCustomWidgets: React.Dispatch<React.SetStateAction<CustomWidget[]>>;
}

interface UseCustomWidgetsResult {
  addWidget: (type: WidgetType) => void;
  removeWidget: (widgetId: string) => void;
  addNodeToWidget: (widgetId: string, nodeId: string) => void;
  removeNodeFromWidget: (widgetId: string, nodeId: string) => void;
  selectTracerouteNode: (widgetId: string, nodeId: string) => void;
}

/**
 * Hook for managing custom dashboard widgets (NodeStatus, Traceroute)
 */
export function useCustomWidgets({
  baseUrl,
  customWidgets,
  setCustomWidgets,
}: UseCustomWidgetsOptions): UseCustomWidgetsResult {
  const csrfFetch = useCsrfFetch();

  // Save widgets to server
  const saveWidgets = useCallback(async (widgets: CustomWidget[]) => {
    try {
      await csrfFetch(`${baseUrl}/api/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dashboardWidgets: JSON.stringify(widgets) }),
      });
    } catch (error) {
      logger.error('Error saving widgets:', error);
    }
  }, [baseUrl, csrfFetch]);

  // Add a new widget
  const addWidget = useCallback((type: WidgetType) => {
    const id = `widget-${Date.now()}`;
    let newWidget: CustomWidget;

    if (type === 'nodeStatus') {
      newWidget = { id, type: 'nodeStatus', nodeIds: [] };
    } else {
      newWidget = { id, type: 'traceroute', targetNodeId: null };
    }

    const newWidgets = [...customWidgets, newWidget];
    setCustomWidgets(newWidgets);
    saveWidgets(newWidgets);
  }, [customWidgets, setCustomWidgets, saveWidgets]);

  // Remove a widget
  const removeWidget = useCallback((widgetId: string) => {
    const newWidgets = customWidgets.filter(w => w.id !== widgetId);
    setCustomWidgets(newWidgets);
    saveWidgets(newWidgets);
  }, [customWidgets, setCustomWidgets, saveWidgets]);

  // Add node to NodeStatus widget
  const addNodeToWidget = useCallback((widgetId: string, nodeId: string) => {
    const newWidgets = customWidgets.map(w => {
      if (w.id === widgetId && w.type === 'nodeStatus') {
        return { ...w, nodeIds: [...w.nodeIds, nodeId] };
      }
      return w;
    });
    setCustomWidgets(newWidgets);
    saveWidgets(newWidgets);
  }, [customWidgets, setCustomWidgets, saveWidgets]);

  // Remove node from NodeStatus widget
  const removeNodeFromWidget = useCallback((widgetId: string, nodeId: string) => {
    const newWidgets = customWidgets.map(w => {
      if (w.id === widgetId && w.type === 'nodeStatus') {
        return { ...w, nodeIds: w.nodeIds.filter(id => id !== nodeId) };
      }
      return w;
    });
    setCustomWidgets(newWidgets);
    saveWidgets(newWidgets);
  }, [customWidgets, setCustomWidgets, saveWidgets]);

  // Set target node for Traceroute widget
  const selectTracerouteNode = useCallback((widgetId: string, nodeId: string) => {
    const newWidgets = customWidgets.map(w => {
      if (w.id === widgetId && w.type === 'traceroute') {
        return { ...w, targetNodeId: nodeId };
      }
      return w;
    });
    setCustomWidgets(newWidgets);
    saveWidgets(newWidgets);
  }, [customWidgets, setCustomWidgets, saveWidgets]);

  return {
    addWidget,
    removeWidget,
    addNodeToWidget,
    removeNodeFromWidget,
    selectTracerouteNode,
  };
}
