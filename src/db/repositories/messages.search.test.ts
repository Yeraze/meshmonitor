import { describe, it, expect } from 'vitest';
// A static import: the module loads while the file is collected, so its cost
// (~1.3 s idle) is not charged to the test's 10 s budget.
import { MessagesRepository } from './messages.js';

describe('MessagesRepository.searchMessages', () => {
  it('should be exported as a method', () => {
    expect(typeof MessagesRepository.prototype.searchMessages).toBe('function');
  });
});
