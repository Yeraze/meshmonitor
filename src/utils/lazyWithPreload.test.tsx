/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { Suspense, type ComponentType } from 'react';
import { render, screen } from '@testing-library/react';
import { lazyWithPreload } from './lazyWithPreload';

describe('lazyWithPreload', () => {
  it('renders the fallback, then the component once its chunk resolves', async () => {
    const Tab = lazyWithPreload(() => Promise.resolve({ default: () => <div>tab body</div> }));
    render(
      <Suspense fallback={<div>loading</div>}>
        <Tab />
      </Suspense>,
    );
    expect(screen.getByText('loading')).toBeTruthy();
    expect(await screen.findByText('tab body')).toBeTruthy();
  });

  it('shares one download between preload() and the render', async () => {
    const factory = vi.fn(() => Promise.resolve({ default: () => <div>once</div> }));
    const Tab = lazyWithPreload(factory);
    await Tab.preload();
    await Tab.preload();
    render(
      <Suspense fallback={null}>
        <Tab />
      </Suspense>,
    );
    expect(await screen.findByText('once')).toBeTruthy();
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('retries after a failed preload instead of caching the failure', async () => {
    const factory = vi
      .fn<() => Promise<{ default: ComponentType }>>()
      .mockRejectedValueOnce(new Error('chunk 404'))
      .mockResolvedValue({ default: () => <div>second try</div> });
    const Tab = lazyWithPreload(factory);
    await expect(Tab.preload()).rejects.toThrow('chunk 404');
    render(
      <Suspense fallback={null}>
        <Tab />
      </Suspense>,
    );
    expect(await screen.findByText('second try')).toBeTruthy();
    expect(factory).toHaveBeenCalledTimes(2);
  });
});
