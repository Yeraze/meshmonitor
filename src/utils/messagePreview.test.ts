import { describe, it, expect } from 'vitest';
import { formatMessagePreview } from './messagePreview';

describe('formatMessagePreview', () => {
  it('keeps short text', () => {
    expect(formatMessagePreview('hi')).toBe('hi');
    expect(formatMessagePreview('')).toBe('');
    expect(formatMessagePreview(undefined)).toBe('');
  });
  it('cuts at 50 and adds an ellipsis only when cut', () => {
    expect(formatMessagePreview('x'.repeat(50))).toBe('x'.repeat(50));
    expect(formatMessagePreview('x'.repeat(51))).toBe('x'.repeat(50) + '...');
  });
  it('honours max', () => {
    expect(formatMessagePreview('abcdef', 3)).toBe('abc...');
  });
});
