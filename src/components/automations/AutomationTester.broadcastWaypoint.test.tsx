/**
 * AutomationTester — action.broadcastWaypoint dry-run headline (#5482).
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AutomationTester, { type SimResult } from './AutomationTester';

vi.mock('../../services/api', () => ({ default: { post: vi.fn() } }));
import apiService from '../../services/api';
const mockedPost = apiService.post as unknown as ReturnType<typeof vi.fn>;

describe('AutomationTester — action.broadcastWaypoint headline (#5482)', () => {
  beforeEach(() => mockedPost.mockReset());

  function result(resolvedParams: Record<string, unknown>): SimResult {
    return {
      matched: true, status: 'completed', triggerType: 'trigger.schedule', fields: {}, conditionResults: {},
      actions: [{ nodeId: 'a1', type: 'action.broadcastWaypoint', ok: true, resolvedParams }],
      variableWrites: [], steps: [],
    };
  }
  const getConfig = () => ({ ok: true as const, config: { trigger: { type: 'trigger.schedule', params: {} }, rules: [] }, triggerType: 'trigger.schedule' });

  it('shows name, channel, hop limit, position and the 30-minute note', async () => {
    const user = userEvent.setup();
    mockedPost.mockResolvedValue(result({
      name: 'San Ysidro 40m', channel: 1, hopLimit: 2, latitude: 32.54, longitude: -117.03, onlyWhenChanged: true,
    }));
    render(<AutomationTester getConfig={getConfig} variables={[]} sources={[]} />);
    await user.click(screen.getByRole('button', { name: /run test/i }));
    await waitFor(() => expect(screen.getByText(/Broadcast waypoint “San Ysidro 40m” → channel 1, hop limit 2/)).toBeInTheDocument());
    expect(screen.getByText(/32.54, -117.03/)).toBeInTheDocument();
    expect(screen.getByText(/At most once per 30 minutes per waypoint, and only when it changed/)).toBeInTheDocument();
  });

  it("says the node's hop limit when none is set", async () => {
    const user = userEvent.setup();
    mockedPost.mockResolvedValue(result({ name: 'x', channel: 0, hopLimit: null, latitude: 1, longitude: 2 }));
    render(<AutomationTester getConfig={getConfig} variables={[]} sources={[]} />);
    await user.click(screen.getByRole('button', { name: /run test/i }));
    await waitFor(() => expect(screen.getByText(/the node's hop limit/)).toBeInTheDocument());
  });
});
