/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { SearchModal } from './SearchModal';

// Mock apiService (default export)
vi.mock('../../services/api.js', () => ({
  default: {
    searchMessages: vi.fn(),
  },
}));

import apiService from '../../services/api.js';

const defaultProps = {
  isOpen: true,
  onClose: vi.fn(),
  onNavigateToMessage: vi.fn(),
  channels: [
    { id: 0, name: 'Primary' },
    { id: 1, name: 'Secondary' },
  ],
  nodes: [
    { nodeId: '!abcd0001', longName: 'Test Node 1', shortName: 'TN1' },
    { nodeId: '!abcd0002', longName: 'Test Node 2', shortName: 'TN2' },
  ],
};

describe('SearchModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should render when isOpen is true', () => {
    render(<SearchModal {...defaultProps} />);
    // The global i18n mock returns the key itself, so we look for 'search.title'
    expect(screen.getByText('search.title')).toBeInTheDocument();
  });

  it('should not render when isOpen is false', () => {
    const { container } = render(<SearchModal {...defaultProps} isOpen={false} />);
    expect(container.innerHTML).toBe('');
  });

  it('should call onClose when close button is clicked', () => {
    render(<SearchModal {...defaultProps} />);
    const closeButton = screen.getByText('\u00D7'); // &times; = ×
    fireEvent.click(closeButton);
    expect(defaultProps.onClose).toHaveBeenCalledTimes(1);
  });

  it('should call onClose when overlay is clicked', () => {
    const { container } = render(<SearchModal {...defaultProps} />);
    const overlay = container.querySelector('.search-modal-overlay');
    expect(overlay).not.toBeNull();
    fireEvent.click(overlay!);
    expect(defaultProps.onClose).toHaveBeenCalledTimes(1);
  });

  it('should not call onClose when modal body is clicked', () => {
    const { container } = render(<SearchModal {...defaultProps} />);
    const modal = container.querySelector('.search-modal');
    expect(modal).not.toBeNull();
    fireEvent.click(modal!);
    expect(defaultProps.onClose).not.toHaveBeenCalled();
  });

  it('should disable search button when query is too short', () => {
    render(<SearchModal {...defaultProps} />);
    const submitButton = screen.getByText('search.button');
    expect(submitButton).toBeDisabled();

    // Type a single character - still too short
    const input = screen.getByPlaceholderText('search.placeholder');
    fireEvent.change(input, { target: { value: 'a' } });
    expect(submitButton).toBeDisabled();
  });

  it('should enable search button when query has 2+ characters', () => {
    render(<SearchModal {...defaultProps} />);
    const input = screen.getByPlaceholderText('search.placeholder');
    fireEvent.change(input, { target: { value: 'ab' } });
    const submitButton = screen.getByText('search.button');
    expect(submitButton).not.toBeDisabled();
  });

  it('should perform search on form submit', async () => {
    const mockResults = {
      data: [
        {
          id: 'msg-1',
          text: 'Hello world test message',
          fromNodeId: '!abcd0001',
          channel: 0,
          timestamp: 1700000000,
          source: 'standard' as const,
        },
        {
          id: 'msg-2',
          text: 'Another test result',
          fromNodeId: '!abcd0002',
          toNodeId: '!abcd0001',
          timestamp: 1700001000,
          source: 'standard' as const,
        },
      ],
      total: 2,
    };
    (apiService.searchMessages as ReturnType<typeof vi.fn>).mockResolvedValue(mockResults);

    render(<SearchModal {...defaultProps} />);

    const input = screen.getByPlaceholderText('search.placeholder');
    fireEvent.change(input, { target: { value: 'test' } });

    const submitButton = screen.getByText('search.button');
    fireEvent.click(submitButton);

    expect(apiService.searchMessages).toHaveBeenCalledTimes(1);
    expect(apiService.searchMessages).toHaveBeenCalledWith(
      expect.objectContaining({ q: 'test', limit: 25, offset: 0 })
    );

    await waitFor(() => {
      // Results are rendered with highlighted text (split into multiple elements),
      // so we check for the result items via their container class
      const resultItems = document.querySelectorAll('.search-result-item');
      expect(resultItems.length).toBe(2);
      // Verify result text content is present (may be split by <mark> tags)
      expect(resultItems[0].textContent).toContain('Hello world');
      expect(resultItems[0].textContent).toContain('test');
      expect(resultItems[1].textContent).toContain('Another');
    });
  });

  it('should navigate on result click', async () => {
    const mockResult = {
      id: 'msg-nav-1',
      text: 'Navigate to this message',
      fromNodeId: '!abcd0001',
      channel: 0,
      timestamp: 1700000000,
      source: 'standard' as const,
    };
    (apiService.searchMessages as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: [mockResult],
      total: 1,
    });

    render(<SearchModal {...defaultProps} />);

    // Perform a search first
    const input = screen.getByPlaceholderText('search.placeholder');
    fireEvent.change(input, { target: { value: 'Navigate' } });
    fireEvent.click(screen.getByText('search.button'));

    let resultItem: Element;
    await waitFor(() => {
      const items = document.querySelectorAll('.search-result-item');
      expect(items.length).toBe(1);
      resultItem = items[0];
      expect(resultItem.textContent).toContain('Navigate');
      expect(resultItem.textContent).toContain('to this message');
    });

    // Click the result
    fireEvent.click(resultItem!);

    expect(defaultProps.onNavigateToMessage).toHaveBeenCalledTimes(1);
    expect(defaultProps.onNavigateToMessage).toHaveBeenCalledWith(mockResult);
    expect(defaultProps.onClose).toHaveBeenCalledTimes(1);
  });

  it('should show no results message when search returns empty', async () => {
    (apiService.searchMessages as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: [],
      total: 0,
    });

    render(<SearchModal {...defaultProps} />);

    const input = screen.getByPlaceholderText('search.placeholder');
    fireEvent.change(input, { target: { value: 'nonexistent' } });
    fireEvent.click(screen.getByText('search.button'));

    await waitFor(() => {
      expect(screen.getByText('search.no_results')).toBeInTheDocument();
    });
  });

  it('should show error message when search fails', async () => {
    (apiService.searchMessages as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('Network error')
    );

    render(<SearchModal {...defaultProps} />);

    const input = screen.getByPlaceholderText('search.placeholder');
    fireEvent.change(input, { target: { value: 'failing' } });
    fireEvent.click(screen.getByText('search.button'));

    await waitFor(() => {
      expect(screen.getByText('search.error')).toBeInTheDocument();
    });
  });

  it('should show min length hint when query is empty and no search has been made', () => {
    render(<SearchModal {...defaultProps} />);
    expect(screen.getByText('search.min_length')).toBeInTheDocument();
  });
});
