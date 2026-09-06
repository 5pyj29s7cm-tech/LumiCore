// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ChatAttachmentUploadStatus } from '../src/components/ChatAttachmentUploadStatus';
import { chatAttachmentCopy } from '../src/i18n/locales/chatAttachments';

afterEach(cleanup);
it.each([true, false])('shows pending processing without offering a premature send or retry (Chinese=%s)', isZh => {
  render(<ChatAttachmentUploadStatus busy failures={[]} isZh={isZh} onRetry={vi.fn()} onDismiss={vi.fn()} />);
  expect(screen.getByRole('status').textContent).toBe(chatAttachmentCopy(isZh).processing);
  expect(screen.queryByRole('button')).toBeNull();
});

it.each([true, false])('names failed files, explains retained successes, and offers distinct retry/dismiss choices (Chinese=%s)', isZh => {
  const retry = vi.fn();
  const dismiss = vi.fn();
  render(<ChatAttachmentUploadStatus busy={false} failures={[{ name: 'synthetic-document.pdf', error: 'Synthetic disk failure' }]}
    isZh={isZh} onRetry={retry} onDismiss={dismiss} />);
  expect(screen.getByText('synthetic-document.pdf')).toBeTruthy();
  expect(screen.getByText(chatAttachmentCopy(isZh).failed)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: chatAttachmentCopy(isZh).retry }));
  expect(retry).toHaveBeenCalledTimes(1);
  expect(dismiss).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: chatAttachmentCopy(isZh).dismiss }));
  expect(dismiss).toHaveBeenCalledTimes(1);
});

it('leaves no empty status panel after successful completion', () => {
  const result = render(<ChatAttachmentUploadStatus busy={false} failures={[]} isZh={false} onRetry={vi.fn()} onDismiss={vi.fn()} />);
  expect(result.container.childElementCount).toBe(0);
});
