/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import SystemRestartSection from './SystemRestartSection';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  return createReactI18nextMock();
});

const { showToast, getMock, restartMock } = vi.hoisted(() => ({
  showToast: vi.fn(),
  getMock: vi.fn(),
  restartMock: vi.fn(),
}));
vi.mock('../ToastContainer', () => ({ useToast: () => ({ showToast }) }));
vi.mock('../../services/api', () => ({
  default: { get: getMock, restartContainer: restartMock },
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});

describe('SystemRestartSection', () => {
  it('renders nothing until the status probe answers', async () => {
    getMock.mockReturnValue(new Promise(() => {}));
    const { container } = render(<SystemRestartSection />);
    expect(container.firstChild).toBeNull();
  });

  it('shows the shutdown button outside Docker and calls restartContainer on confirm', async () => {
    getMock.mockResolvedValue({ isDocker: false });
    restartMock.mockResolvedValue({ message: 'bye' });
    render(<SystemRestartSection />);
    const heading = await screen.findByText('settings.shutdown_title');
    expect(heading.closest('#settings-system')).not.toBeNull();
    fireEvent.click(screen.getByRole('button'));
    await waitFor(() => expect(restartMock).toHaveBeenCalledTimes(1));
    expect(showToast).toHaveBeenCalledWith('bye', 'success');
  });

  it('shows the restart title in Docker', async () => {
    getMock.mockResolvedValue({ isDocker: true });
    render(<SystemRestartSection />);
    expect(await screen.findByText('settings.restart_container_title')).toBeInTheDocument();
  });

  it('does not restart when the admin cancels the confirm', async () => {
    getMock.mockResolvedValue({ isDocker: true });
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<SystemRestartSection />);
    await screen.findByText('settings.restart_container_title');
    fireEvent.click(screen.getByRole('button'));
    expect(restartMock).not.toHaveBeenCalled();
  });
});
