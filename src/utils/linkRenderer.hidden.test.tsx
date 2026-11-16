// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { renderMessageWithLinks } from './linkRenderer';
import { PUBLIC_INSTANCE_HIDDEN_TEXT } from './publicInstanceMode';

describe('renderMessageWithLinks hidden text', () => {
  it('renders the placeholder as the hidden span', () => {
    render(<div>{renderMessageWithLinks(PUBLIC_INSTANCE_HIDDEN_TEXT)}</div>);
    expect(screen.getByTestId('public-hidden-text')).toBeTruthy();
    expect(document.body.textContent).not.toContain('[hidden on');
  });
  it('leaves ordinary text alone', () => {
    render(<div>{renderMessageWithLinks('hello')}</div>);
    expect(screen.queryByTestId('public-hidden-text')).toBeNull();
  });
});
