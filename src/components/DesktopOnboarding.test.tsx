// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DesktopOnboarding } from './DesktopOnboarding';

vi.mock('motion/react', () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  motion: new Proxy({}, { get: (_target, tag: string) => tag }),
  useReducedMotion: () => true,
}));

function jsonResponse(payload: unknown, ok = true, status = ok ? 200 : 500) {
  return {
    ok,
    status,
    json: async () => payload,
  } as Response;
}

const snapshot = {
  timestamp: '2026-08-26T00:00:00.000Z',
  hardware: {
    cpus: { model: 'Test CPU', cores: 8, threads: 16 },
    totalMemoryGB: 32,
    disks: [{ name: 'C', totalGB: 1000, freeGB: 500 }],
  },
  software: { installedApps: ['Visual Studio Code'] },
  capabilityProfile: {
    opportunities: [{
      id: 'software_development',
      label: 'Software development',
      ready: true,
      confidence: 0.94,
      evidence: ['Visual Studio Code'],
      suggestedPrompts: [],
    }],
    firstQuestions: [{
      zh: '先审计我的当前项目',
      en: 'Audit my current project first',
    }],
  },
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('DesktopOnboarding consent-first adaptation', () => {
  it('grants consent before starting an isolated computer scan', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        explored: false,
        authorized: false,
        consent: { status: 'not_decided' },
        latest: null,
      }))
      .mockResolvedValueOnce(jsonResponse({
        authorized: true,
        consent: { status: 'granted' },
      }))
      .mockResolvedValueOnce(jsonResponse({ scanned: true, snapshot }));
    vi.stubGlobal('fetch', fetchMock);

    render(<DesktopOnboarding isOpen onFinish={vi.fn()} t={{ langCode: 'zh' }} />);
    fireEvent.click(await screen.findByRole('button', { name: '允许并开始扫描' }));

    await screen.findByText('Lumi 已知道从哪里开始');
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/explore/consent', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ granted: true }),
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(3, '/api/explore/scan', expect.objectContaining({
      method: 'POST',
    }));
    expect(fetchMock.mock.invocationCallOrder[1]).toBeLessThan(fetchMock.mock.invocationCallOrder[2]);
  });

  it('records a skip without starting any scan', async () => {
    const onFinish = vi.fn();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        explored: false,
        authorized: false,
        consent: { status: 'not_decided' },
        latest: null,
      }))
      .mockResolvedValueOnce(jsonResponse({
        authorized: false,
        consent: { status: 'declined' },
      }));
    vi.stubGlobal('fetch', fetchMock);

    render(<DesktopOnboarding isOpen onFinish={onFinish} t={{ langCode: 'zh' }} />);
    fireEvent.click(await screen.findByRole('button', { name: '暂时跳过' }));

    await waitFor(() => expect(onFinish).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenLastCalledWith('/api/explore/consent', expect.objectContaining({
      body: JSON.stringify({ granted: false }),
    }));
    expect(fetchMock.mock.calls.some(([url]) => url === '/api/explore/scan')).toBe(false);
  });

  it('hands the first evidence-backed question to chat and closes onboarding', async () => {
    const onAsk = vi.fn();
    const onFinish = vi.fn();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
      explored: true,
      authorized: true,
      consent: { status: 'granted' },
      latest: snapshot,
    })));

    render(
      <DesktopOnboarding
        isOpen
        onFinish={onFinish}
        onAsk={onAsk}
        t={{ langCode: 'zh' }}
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: /先审计我的当前项目/ }));

    expect(onAsk).toHaveBeenCalledWith('先审计我的当前项目');
    expect(onFinish).toHaveBeenCalledTimes(1);
  });
});
