// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  installExternalAnchorGuard,
  installExternalWindowOpenGuard,
  isExternalHttpUrl,
  safeMarkdownComponents,
} from './externalNavigation';

describe('desktop external navigation boundary', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('classifies absolute and protocol-relative HTTP(S) links as external', () => {
    expect(isExternalHttpUrl('https://lumiai.asia/docs')).toBe(true);
    expect(isExternalHttpUrl('http://example.com/path')).toBe(true);
    expect(isExternalHttpUrl('//example.com/protocol-relative')).toBe(true);
    expect(isExternalHttpUrl('/settings/models')).toBe(false);
    expect(isExternalHttpUrl('#memory')).toBe(false);
    expect(isExternalHttpUrl('javascript:alert(1)')).toBe(false);
    expect(isExternalHttpUrl('data:text/plain,hello')).toBe(false);
  });

  it('hands clicked external anchors to the supplied system opener', async () => {
    const opener = vi.fn();
    const remove = installExternalAnchorGuard(document, opener);
    const anchor = document.createElement('a');
    anchor.href = 'https://example.com/guide';
    anchor.textContent = 'guide';
    document.body.append(anchor);

    fireEvent.click(anchor);

    expect(opener).toHaveBeenCalledOnce();
    expect(opener).toHaveBeenCalledWith('https://example.com/guide');
    remove();
  });

  it('normalizes a protocol-relative anchor and never leaves it in the WebView', () => {
    const opener = vi.fn();
    const remove = installExternalAnchorGuard(document, opener);
    const anchor = document.createElement('a');
    anchor.setAttribute('href', '//outside.example/guide');
    anchor.textContent = 'outside guide';
    document.body.append(anchor);

    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    const stayedInWebView = anchor.dispatchEvent(click);

    expect(stayedInWebView).toBe(false);
    expect(opener).toHaveBeenCalledOnce();
    expect(opener).toHaveBeenCalledWith(`${window.location.protocol}//outside.example/guide`);
    remove();
  });

  it('leaves relative internal routes inside Lumi', () => {
    const opener = vi.fn();
    const remove = installExternalAnchorGuard(document, opener);
    const anchor = document.createElement('a');
    anchor.href = '#memory';
    anchor.textContent = 'memory';
    document.body.append(anchor);

    fireEvent.click(anchor);

    expect(opener).not.toHaveBeenCalled();
    remove();
  });

  it('marks Markdown links and GFM bare URLs for safe external opening', () => {
    render(
      <Markdown components={safeMarkdownComponents} remarkPlugins={[remarkGfm]}>
        {'[docs](https://lumiai.asia/docs) and https://example.com/help'}
      </Markdown>,
    );

    expect(screen.getByRole('link', { name: 'docs' }).getAttribute('target')).toBe('_blank');
    expect(screen.getByRole('link', { name: 'docs' }).getAttribute('rel')).toBe('noopener noreferrer');
    expect(screen.getByRole('link', { name: 'https://example.com/help' }).getAttribute('target')).toBe('_blank');
  });

  it('reroutes programmatic external window.open without changing relative app behavior', () => {
    const original = vi.fn(() => null);
    Object.defineProperty(window, 'open', { configurable: true, writable: true, value: original });
    const opener = vi.fn();
    const remove = installExternalWindowOpenGuard(window, opener);

    window.open('https://example.com/from-code', '_blank');
    expect(opener).toHaveBeenCalledWith('https://example.com/from-code');
    expect(original).not.toHaveBeenCalled();

    window.open('//outside.example/from-code', '_blank');
    expect(opener).toHaveBeenCalledWith(`${window.location.protocol}//outside.example/from-code`);
    expect(original).not.toHaveBeenCalled();

    window.open('/api/files/download/report', '_blank');
    expect(original).toHaveBeenCalledWith('/api/files/download/report', '_blank', undefined);

    remove();
    expect(window.open).toBe(original);
  });
});
