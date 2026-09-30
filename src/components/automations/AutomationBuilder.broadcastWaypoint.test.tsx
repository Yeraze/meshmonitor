/**
 * action.broadcastWaypoint in the builder (#5482): the catalog entry, the
 * single Meshtastic-source picker, and the always-on hop-limit airtime
 * warning. The tester headline is in AutomationTester.broadcastWaypoint.test.tsx.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import AutomationBuilder, { type SourceOption } from './AutomationBuilder';
import { BLOCK_BY_TYPE, WAYPOINT_HOP_LIMIT_WARNING } from './catalog';
import type { WorkflowForm } from './compile';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  return createReactI18nextMock();
});

const sources: SourceOption[] = [
  { id: 'mt-1', name: 'Border Node', type: 'meshtastic_tcp', enabled: true, txEnabled: true },
  { id: 'mt-rx', name: 'Receive Only', type: 'meshtastic_tcp', enabled: true, txEnabled: false },
  { id: 'mt-off', name: 'Disabled Node', type: 'meshtastic_tcp', enabled: false },
  { id: 'mc-1', name: 'MeshCore Node', type: 'meshcore', enabled: true },
  { id: 'mq-1', name: 'MQTT Bridge', type: 'mqtt_bridge', enabled: true },
];

function form(params: Record<string, unknown>): WorkflowForm {
  return {
    trigger: { type: 'trigger.schedule', params: { cron: '*/30 * * * *' } },
    rules: [{ conditions: [], actions: [{ type: 'action.broadcastWaypoint', params }] }],
    combine: null,
  };
}

function renderBuilder(params: Record<string, unknown>, onChange = vi.fn()) {
  render(
    <AutomationBuilder form={form(params)} variables={[]} sources={sources} channels={[]}
      scripts={[]} regions={[]} onChange={onChange} />,
  );
  return onChange;
}

describe('catalog — action.broadcastWaypoint (#5482)', () => {
  it('declares the spec fields', () => {
    const def = BLOCK_BY_TYPE['action.broadcastWaypoint'];
    expect(def).toBeDefined();
    expect(def.fields.map((f) => f.name)).toEqual([
      'sourceId', 'waypointKey', 'latitude', 'longitude', 'name', 'description', 'icon',
      'expireHours', 'channel', 'hopLimit', 'onlyWhenChanged',
    ]);
    expect(def.description).toMatch(/30 minutes/);
    const hop = def.fields.find((f) => f.name === 'hopLimit')!;
    expect(hop.advanced).toBe(false);
    expect(hop.warning).toBe(WAYPOINT_HOP_LIMIT_WARNING);
  });
});

describe('AutomationBuilder — action.broadcastWaypoint (#5482)', () => {
  it('lists only enabled native Meshtastic sources in the source picker', () => {
    renderBuilder({});
    const select = screen.getByDisplayValue('— select a Meshtastic source —') as HTMLSelectElement;
    const labels = Array.from(select.options).map((o) => o.textContent);
    expect(labels).toEqual(['— select a Meshtastic source —', 'Border Node', 'Receive Only']);
  });

  it('stores the chosen source id as params.sourceId', () => {
    const onChange = renderBuilder({});
    fireEvent.change(screen.getByDisplayValue('— select a Meshtastic source —'), { target: { value: 'mt-1' } });
    const next = onChange.mock.calls.at(-1)![0] as WorkflowForm;
    expect(next.rules[0].actions[0].params).toMatchObject({ sourceId: 'mt-1' });
  });

  it('warns when the chosen source cannot transmit', () => {
    renderBuilder({ sourceId: 'mt-rx' });
    expect(screen.getByText(/Transmit is disabled on this source/)).toBeInTheDocument();
  });

  it('always shows the hop-limit airtime warning', () => {
    renderBuilder({ sourceId: 'mt-1' });
    expect(screen.getByText(WAYPOINT_HOP_LIMIT_WARNING)).toBeInTheDocument();
  });
});
