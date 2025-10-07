/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Toast, { ToastProps } from './Toast';

describe('Toast Component', () => {
  let mockOnClose: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockOnClose = vi.fn();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  const defaultProps: ToastProps = {
    id: 'test-toast-1',
    message: 'Test message',
    type: 'info',
    onClose: mockOnClose,
  };

  describe('Rendering', () => {
    it('should render toast with message', () => {
      render(<Toast {...defaultProps} />);
      expect(screen.getByText('Test message')).toBeInTheDocument();
    });

    it('should render success toast with correct icon', () => {
      render(<Toast {...defaultProps} type="success" />);
      expect(screen.getByText('✓')).toBeInTheDocument();
    });

    it('should render error toast with correct icon', () => {
      render(<Toast {...defaultProps} type="error" />);
      expect(screen.getByText('✕')).toBeInTheDocument();
    });

    it('should render warning toast with correct icon', () => {
      render(<Toast {...defaultProps} type="warning" />);
      expect(screen.getByText('⚠')).toBeInTheDocument();
    });

    it('should render info toast with correct icon', () => {
      render(<Toast {...defaultProps} type="info" />);
      expect(screen.getByText('ℹ')).toBeInTheDocument();
    });

    it('should render close button', () => {
      render(<Toast {...defaultProps} />);
      expect(screen.getByText('×')).toBeInTheDocument();
    });
  });

  describe('Auto-dismiss', () => {
    it('should auto-dismiss after default duration (5 seconds)', async () => {
      render(<Toast {...defaultProps} />);

      expect(mockOnClose).not.toHaveBeenCalled();

      // Fast-forward 5 seconds
      vi.advanceTimersByTime(5000);

      await waitFor(() => {
        expect(mockOnClose).toHaveBeenCalledWith('test-toast-1');
        expect(mockOnClose).toHaveBeenCalledTimes(1);
      });
    });

    it('should auto-dismiss after custom duration', async () => {
      render(<Toast {...defaultProps} duration={3000} />);

      expect(mockOnClose).not.toHaveBeenCalled();

      // Fast-forward 3 seconds
      vi.advanceTimersByTime(3000);

      await waitFor(() => {
        expect(mockOnClose).toHaveBeenCalledWith('test-toast-1');
      });
    });

    it('should not dismiss before duration', () => {
      render(<Toast {...defaultProps} duration={5000} />);

      // Fast-forward 4 seconds (less than duration)
      vi.advanceTimersByTime(4000);

      expect(mockOnClose).not.toHaveBeenCalled();
    });

    it('should clear timer on unmount', () => {
      const { unmount } = render(<Toast {...defaultProps} duration={5000} />);

      unmount();

      // Fast-forward past duration
      vi.advanceTimersByTime(6000);

      expect(mockOnClose).not.toHaveBeenCalled();
    });
  });

  describe('Manual Close', () => {
    it('should call onClose when close button is clicked', async () => {
      const user = userEvent.setup({ delay: null });
      render(<Toast {...defaultProps} />);

      const closeButton = screen.getByText('×');
      await user.click(closeButton);

      expect(mockOnClose).toHaveBeenCalledWith('test-toast-1');
      expect(mockOnClose).toHaveBeenCalledTimes(1);
    });

    it('should not auto-dismiss after manual close', async () => {
      const user = userEvent.setup({ delay: null });
      render(<Toast {...defaultProps} duration={5000} />);

      const closeButton = screen.getByText('×');
      await user.click(closeButton);

      expect(mockOnClose).toHaveBeenCalledTimes(1);

      // Fast-forward past duration
      vi.advanceTimersByTime(6000);

      // Should still only be called once (from manual close)
      expect(mockOnClose).toHaveBeenCalledTimes(1);
    });
  });

  describe('Styling', () => {
    it('should apply success background color', () => {
      const { container } = render(<Toast {...defaultProps} type="success" />);
      const toastDiv = container.firstChild as HTMLElement;
      expect(toastDiv.style.backgroundColor).toBe('#4caf50');
    });

    it('should apply error background color', () => {
      const { container } = render(<Toast {...defaultProps} type="error" />);
      const toastDiv = container.firstChild as HTMLElement;
      expect(toastDiv.style.backgroundColor).toBe('#f44336');
    });

    it('should apply warning background color', () => {
      const { container } = render(<Toast {...defaultProps} type="warning" />);
      const toastDiv = container.firstChild as HTMLElement;
      expect(toastDiv.style.backgroundColor).toBe('#ff9800');
    });

    it('should apply info background color', () => {
      const { container } = render(<Toast {...defaultProps} type="info" />);
      const toastDiv = container.firstChild as HTMLElement;
      expect(toastDiv.style.backgroundColor).toBe('#2196f3');
    });

    it('should have slideIn animation', () => {
      const { container } = render(<Toast {...defaultProps} />);
      const toastDiv = container.firstChild as HTMLElement;
      expect(toastDiv.style.animation).toContain('slideIn');
    });
  });

  describe('Long Messages', () => {
    it('should render long messages', () => {
      const longMessage = 'This is a very long message '.repeat(10);
      render(<Toast {...defaultProps} message={longMessage} />);
      expect(screen.getByText(longMessage)).toBeInTheDocument();
    });

    it('should render messages with special characters', () => {
      const specialMessage = 'Message with <html> & special chars: !@#$%^&*()';
      render(<Toast {...defaultProps} message={specialMessage} />);
      expect(screen.getByText(specialMessage)).toBeInTheDocument();
    });

    it('should render messages with emojis', () => {
      const emojiMessage = 'Success! 🎉✨🚀';
      render(<Toast {...defaultProps} message={emojiMessage} />);
      expect(screen.getByText(emojiMessage)).toBeInTheDocument();
    });
  });

  describe('Multiple Toasts', () => {
    it('should render multiple toasts with unique IDs', () => {
      const { container } = render(
        <>
          <Toast {...defaultProps} id="toast-1" message="First toast" />
          <Toast {...defaultProps} id="toast-2" message="Second toast" />
          <Toast {...defaultProps} id="toast-3" message="Third toast" />
        </>
      );

      expect(screen.getByText('First toast')).toBeInTheDocument();
      expect(screen.getByText('Second toast')).toBeInTheDocument();
      expect(screen.getByText('Third toast')).toBeInTheDocument();
    });
  });

  describe('Accessibility', () => {
    it('should have close button accessible via keyboard', async () => {
      const user = userEvent.setup({ delay: null });
      render(<Toast {...defaultProps} />);

      const closeButton = screen.getByText('×');

      // Tab to button and press Enter
      closeButton.focus();
      await user.keyboard('{Enter}');

      expect(mockOnClose).toHaveBeenCalledWith('test-toast-1');
    });
  });
});
