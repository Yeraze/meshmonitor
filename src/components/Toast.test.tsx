/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Toast, { ToastProps } from './Toast';

describe('Toast Component', () => {
  let mockOnClose: ReturnType<typeof vi.fn>;
  let defaultProps: ToastProps;

  beforeEach(() => {
    mockOnClose = vi.fn();
    defaultProps = {
      id: 'test-toast-1',
      message: 'Test message',
      type: 'info',
      onClose: mockOnClose as unknown as (id: string) => void,
    };
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

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

      // Fast-forward 5 seconds — async variant flushes microtasks so effects resolve
      await vi.advanceTimersByTimeAsync(5000);

      expect(mockOnClose).toHaveBeenCalledWith('test-toast-1');
      expect(mockOnClose).toHaveBeenCalledTimes(1);
    });

    it('should auto-dismiss after custom duration', async () => {
      render(<Toast {...defaultProps} duration={3000} />);

      expect(mockOnClose).not.toHaveBeenCalled();

      // Fast-forward 3 seconds
      await vi.advanceTimersByTimeAsync(3000);

      expect(mockOnClose).toHaveBeenCalledWith('test-toast-1');
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
    it('should call onClose when close button is clicked', () => {
      render(<Toast {...defaultProps} />);

      const closeButton = screen.getByText('×');
      // fireEvent is synchronous and plays nicely with fake timers
      fireEvent.click(closeButton);

      expect(mockOnClose).toHaveBeenCalledWith('test-toast-1');
      expect(mockOnClose).toHaveBeenCalledTimes(1);
    });

    it('should not auto-dismiss after manual close + unmount', () => {
      // The Toast itself doesn't manage its own visibility - the parent
      // unmounts it in response to onClose. Verify the unmount cleans up
      // the auto-dismiss timer so it doesn't fire a second onClose.
      const { unmount } = render(<Toast {...defaultProps} duration={5000} />);

      const closeButton = screen.getByText('×');
      fireEvent.click(closeButton);

      expect(mockOnClose).toHaveBeenCalledTimes(1);

      // Parent would unmount in response to onClose
      unmount();

      // Fast-forward past duration — timer should have been cleared on unmount
      vi.advanceTimersByTime(6000);

      expect(mockOnClose).toHaveBeenCalledTimes(1);
    });
  });

  describe('Styling', () => {
    it('should apply success background color', () => {
      const { container } = render(<Toast {...defaultProps} type="success" />);
      const toastDiv = container.firstChild as HTMLElement;
      // Component uses Catppuccin CSS variables
      expect(toastDiv.style.backgroundColor).toBe('var(--ctp-green)');
    });

    it('should apply error background color', () => {
      const { container } = render(<Toast {...defaultProps} type="error" />);
      const toastDiv = container.firstChild as HTMLElement;
      expect(toastDiv.style.backgroundColor).toBe('var(--ctp-red)');
    });

    it('should apply warning background color', () => {
      const { container } = render(<Toast {...defaultProps} type="warning" />);
      const toastDiv = container.firstChild as HTMLElement;
      expect(toastDiv.style.backgroundColor).toBe('var(--ctp-peach)');
    });

    it('should apply info background color', () => {
      const { container } = render(<Toast {...defaultProps} type="info" />);
      const toastDiv = container.firstChild as HTMLElement;
      expect(toastDiv.style.backgroundColor).toBe('var(--ctp-blue)');
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
      // Testing-library normalizes whitespace — use trimmed version for exact match
      expect(screen.getByText(longMessage.trim())).toBeInTheDocument();
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
      render(
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
      // userEvent.keyboard() with fake timers deadlocks; use real timers for this test
      vi.useRealTimers();
      const user = userEvent.setup();
      render(<Toast {...defaultProps} />);

      const closeButton = screen.getByText('×');

      // Tab to button and press Enter
      closeButton.focus();
      expect(closeButton).toHaveFocus();
      await user.keyboard('{Enter}');

      expect(mockOnClose).toHaveBeenCalledWith('test-toast-1');
    });
  });
});
