// @vitest-environment jsdom
import React, { lazy } from 'react';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ClientSurface } from '../src/components/ClientSurface';
import { isClientSurfaceRendered } from '../src/lib/clientSurfaceCommit';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
it('commits the surface only after lazy content resolves', async () => {
  let finish!: (module: { default: React.ComponentType }) => void;
  const Panel = lazy(() => new Promise<{ default: React.ComponentType }>(resolve => finish = resolve));
  const view = render(<ClientSurface id="tools" fallback={<p>Loading tools</p>}><Panel /></ClientSurface>);
  expect(view.getByText('Loading tools')).toBeTruthy(); expect(isClientSurfaceRendered('tools')).toBe(false);
  await act(async () => finish({ default: () => <p>Tools ready</p> }));
  expect(view.getByText('Tools ready')).toBeTruthy(); expect(isClientSurfaceRendered('tools')).toBe(true);
});
it('contains a render failure, preserves its sibling and retries only the failed surface', () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  let broken = true;
  function Panel() { if (broken) throw Error('synthetic feature failure'); return <p>Recovered tools</p>; }
  const view = render(<><ClientSurface id="tools"><Panel /></ClientSurface><ClientSurface id="settings"><p>Settings ready</p></ClientSurface></>);
  expect(view.getByText('Settings ready')).toBeTruthy(); expect(isClientSurfaceRendered('tools')).toBe(false); expect(isClientSurfaceRendered('settings')).toBe(true);
  expect(view.container.querySelector('[data-lumi-failed-surface="tools"]')).toBeTruthy(); expect(view.queryByRole('button', { name: /reload/i })).toBeNull();
  broken = false; fireEvent.click(view.getByRole('button', { name: /retry|重试/i }));
  expect(view.getByText('Recovered tools')).toBeTruthy(); expect(isClientSurfaceRendered('tools')).toBe(true); expect(view.getByText('Settings ready')).toBeTruthy();
});
it('does not count inactive or hidden surfaces and accepts the visible duplicate', () => {
  const view = render(<><ClientSurface id="home" active={false}><ClientSurface id="tools"><p>Tools</p></ClientSurface></ClientSurface><div aria-hidden="true"><ClientSurface id="settings"><p>Hidden settings</p></ClientSurface></div><ClientSurface id="settings"><p>Visible settings</p></ClientSurface><ClientSurface id="memory" active={false}><p>Minimized memory</p></ClientSurface></>);
  expect(isClientSurfaceRendered('home')).toBe(false); expect(isClientSurfaceRendered('tools')).toBe(true); expect(isClientSurfaceRendered('memory')).toBe(false); expect(isClientSurfaceRendered('settings')).toBe(true);
  view.rerender(<div inert><ClientSurface id="settings"><p>Inert settings</p></ClientSurface></div>);
  expect(isClientSurfaceRendered('settings')).toBe(false);
});
