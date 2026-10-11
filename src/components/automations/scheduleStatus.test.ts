import { describe, expect, it } from 'vitest';
import { scheduleStatus } from './scheduleStatus';
import { timedAnnouncementTemplate } from './templates/timedAnnouncement';
import { validateAutomationGraph } from '../../types/automation';

const config = (params: Record<string, unknown>) => JSON.stringify({
  version: 1,
  nodes: [{ id: 't', type: 'trigger.schedule', params }, { id: 'a', type: 'action.notify', params: {} }],
  edges: [{ from: 't', to: 'a' }],
});
const START = Date.UTC(2026, 9, 3, 8, 0);
const END = Date.UTC(2026, 9, 3, 12, 0);
const WINDOW = { cron: '*/30 * * * *', startAt: '2026-10-03T08:00', endAt: '2026-10-03T12:00', timezone: 'UTC' };

describe('scheduleStatus', () => {
  it('says Starts, Until or Ended as time passes', () => {
    expect(scheduleStatus(config(WINDOW), START - 1)).toMatch(/^Starts /);
    expect(scheduleStatus(config(WINDOW), START)).toMatch(/^Until /);
    expect(scheduleStatus(config(WINDOW), END)).toMatch(/^Ended /);
  });

  it('is null with no window, for another trigger, and for bad JSON', () => {
    expect(scheduleStatus(config({ cron: '0 * * * *' }), START)).toBeNull();
    expect(scheduleStatus(JSON.stringify({ nodes: [{ type: 'trigger.message', params: WINDOW }] }), START)).toBeNull();
    expect(scheduleStatus('{', START)).toBeNull();
  });
});

describe('Timed Announcement template', () => {
  const build = (values: Record<string, unknown>) => {
    const built = timedAnnouncementTemplate.build(values);
    return Array.isArray(built) ? built[0] : built;
  };
  const trigger = (values: Record<string, unknown>) =>
    build(values).config.nodes.find((n) => n.type === 'trigger.schedule')!.params as Record<string, unknown>;

  it('builds a valid scheduled send with the window and targets', () => {
    const built = build({
      text: 'Net is open', interval: '30', sourceIds: ['a', 'b'], channels: [{ name: 'gauntlet' }],
      startAt: '2026-10-03T08:00', endAt: '2026-10-03T12:00', timezone: 'America/New_York',
    });
    expect(validateAutomationGraph(built.config).valid).toBe(true);
    expect(trigger({ interval: '30', startAt: '2026-10-03T08:00', endAt: '2026-10-03T12:00', timezone: 'America/New_York' }))
      .toEqual({ cron: '*/30 * * * *', startAt: '2026-10-03T08:00', endAt: '2026-10-03T12:00', timezone: 'America/New_York' });
    const send = built.config.nodes.find((n) => n.type === 'action.sendMessage')!.params as Record<string, unknown>;
    expect(send).toEqual({ text: 'Net is open', sourceIds: ['a', 'b'], channels: [{ name: 'gauntlet' }] });
  });

  it('defaults to every 30 minutes and never offers less than 5', () => {
    expect(trigger({}).cron).toBe('*/30 * * * *');
    const options = timedAnnouncementTemplate.params.find((p) => p.name === 'interval')!.options!;
    expect(Math.min(...options.map((o) => Number(o.value)))).toBe(5);
  });

  it('fills a blank zone when a date is set, and drops a window that does not validate', () => {
    expect(typeof trigger({ startAt: '2026-10-03T08:00' }).timezone).toBe('string');
    expect(trigger({ startAt: 'sample', endAt: 'sample', timezone: 'sample' })).toEqual({ cron: '*/30 * * * *' });
    expect(trigger({ startAt: '2026-10-03T12:00', endAt: '2026-10-03T08:00', timezone: 'UTC' })).toEqual({ cron: '*/30 * * * *' });
  });
});
