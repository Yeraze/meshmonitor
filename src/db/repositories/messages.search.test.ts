import { describe, it, expect } from 'vitest';

describe('MessagesRepository.searchMessages', () => {
  it('should be exported as a method', async () => {
    const { MessagesRepository } = await import('./messages.js');
    expect(typeof MessagesRepository.prototype.searchMessages).toBe('function');
  });
});
