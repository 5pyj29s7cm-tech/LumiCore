// @vitest-environment jsdom
import React, { useState } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ChatMessageMarkdown } from '../src/components/ChatMessageMarkdown';
import { ChatFilePreview, type ChatPreviewFile } from '../src/components/ChatFilePreview';
import { chatArtifactFromLink, legacyChatArtifacts } from '../src/lib/chatArtifactLinks';

const fetchMock = vi.fn();
const createObjectURL = vi.fn(() => 'blob:http://tauri.localhost/preview');
const revokeObjectURL = vi.fn();
const originalUrl = URL;
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('URL', class extends originalUrl { static createObjectURL = createObjectURL; static revokeObjectURL = revokeObjectURL; });
  (window as any).__LUMI_DESKTOP__ = true;
  localStorage.setItem('lumi_auth_token', 'synthetic-preview-token');
  localStorage.setItem('lumi_desktop_session_proof', 'synthetic-preview-proof');
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); delete (window as any).__LUMI_DESKTOP__; });

function Conversation({ text }: { text: string }) {
  const [file, setFile] = useState<ChatPreviewFile | null>(null);
  return <><ChatMessageMarkdown conversationId="owned-chat" onPreview={setFile}>{text}</ChatMessageMarkdown>
    {file && <ChatFilePreview key={file.url} file={file} isZh onClose={() => setFile(null)} />}</>;
}

it('opens an actual document link inside the chat, loads authenticated content and restores focus', async () => {
  fetchMock.mockResolvedValue({ ok: true, json: async () => ({ kind: 'table', sections: [{ name: '订单', rows: [['quantity', 'total'], ['4', '72']] }] }) });
  render(<Conversation text={'[查看表格](<C:/Users/Test/Documents/中文 sales.csv>)'} />);
  const link = screen.getByRole('button', { name: '查看表格' }); link.focus(); fireEvent.click(link);
  expect(screen.getByRole('dialog').getAttribute('aria-label')).toContain('中文 sales.csv');
  await screen.findByRole('cell', { name: '72' });
  const [url, options] = fetchMock.mock.calls[0];
  expect(new URL(url).searchParams.get('conversationId')).toBe('owned-chat');
  expect(new URL(url).searchParams.get('preview')).toBe('1');
  expect(new Headers(options.headers).get('Authorization')).toBe('Bearer synthetic-preview-token');
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).toBeNull(); expect(document.activeElement).toBe(link);
});

it.each(['png', 'mp4', 'mp3'])('opens and releases a %s preview with no secret in the element URL', async extension => {
  fetchMock.mockResolvedValue({ ok: true, blob: async () => new Blob(['synthetic media']) });
  render(<Conversation text={`[查看文件](C:/Documents/test.${extension})`} />);
  fireEvent.click(screen.getByRole('button', { name: '查看文件' }));
  await waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(1));
  const tag = extension === 'png' ? 'img' : extension === 'mp4' ? 'video' : 'audio';
  const media = screen.getByRole('dialog').querySelector(tag)!;
  expect(media.getAttribute('src')).toBe('blob:http://tauri.localhost/preview');
  if (tag !== 'img') { expect(media.hasAttribute('controls')).toBe(true); expect(media.hasAttribute('autoplay')).toBe(false); }
  fireEvent.click(screen.getByRole('button', { name: '关闭预览' }));
  expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:http://tauri.localhost/preview');
});

it('shows an actionable error on missing files and aborts document loading on close', async () => {
  fetchMock.mockResolvedValue({ ok: false, status: 404 });
  render(<Conversation text={'`C:/Documents/missing.txt`'} />);
  fireEvent.click(screen.getByRole('button', { name: 'C:/Documents/missing.txt' }));
  await screen.findByRole('alert');
  fetchMock.mockImplementation(() => new Promise(() => {}));
  fireEvent.click(screen.getByRole('button', { name: '重试' }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  const signal = fetchMock.mock.calls[1][1].signal;
  fireEvent.click(screen.getByRole('button', { name: '关闭预览' }));
  expect(signal.aborted).toBe(true);
});

it('renders HTML as inert source text, and keeps external links separate', async () => {
  fetchMock.mockResolvedValue({ ok: true, json: async () => ({ kind: 'text', text: '<script>window.previewLeak=1</script>' }) });
  render(<Conversation text={'[源文件](C:/Documents/page.html) [官网](https://example.com) [危险](javascript:alert(1))'} />);
  expect(screen.getByRole('link', { name: '官网' }).getAttribute('target')).toBe('_blank');
  fireEvent.click(screen.getByRole('button', { name: '源文件' }));
  await screen.findByText('<script>window.previewLeak=1</script>');
  expect(screen.getByRole('dialog').querySelector('script')).toBeNull();
  expect((window as any).previewLeak).toBeUndefined();
});

it('recognizes both Windows path styles and rejects unsafe or remote resource schemes', () => {
  const paths = legacyChatArtifacts('已完成并验证本地文件：C:/Users/Test/中文 report.csv（45字节）。\nC:\\Documents\\clip.webm', 'history-chat');
  expect(paths.map(file => file.fileName)).toEqual(['中文 report.csv', 'clip.webm']);
  expect(paths.every(file => new URL(file.url, 'http://local.invalid').searchParams.get('conversationId') === 'history-chat')).toBe(true);
  for (const target of ['javascript:alert(1)', 'https://evil.test/api/files/generated?path=C:/keys.json', '//evil.test/video.mp4']) expect(chatArtifactFromLink(target)).toBeNull();
  expect(chatArtifactFromLink('/api/files/download/%E0%A4')).toBeNull();
  const file = chatArtifactFromLink('/api/files/generated?path=C%3A%2FDocuments%2Ftest.csv', 'owned-chat');
  expect(new URL(file!.url, 'http://local.invalid').searchParams.get('conversationId')).toBe('owned-chat');
});

 it('expands and restores only the video, preserves its element and position, and gives Escape to the player first', async () => {
  fetchMock.mockResolvedValue({ ok: true, blob: async () => new Blob(['synthetic video']) });
  const requestFullscreen = vi.fn(); Object.defineProperty(HTMLElement.prototype, 'requestFullscreen', { configurable: true, value: requestFullscreen });
  try {
    render(<Conversation text={'[查看视频](C:/Documents/test.mp4)'} />);
    fireEvent.click(screen.getByRole('button', { name: '查看视频' }));
    await waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(1));
    const video = document.querySelector('video')!; video.currentTime = 12;
    expect(video.getAttribute('controlslist')).toContain('nofullscreen');
    fireEvent.click(screen.getByRole('button', { name: '放大视频' }));
    expect(document.querySelector('[data-video-expanded="true"]')).not.toBeNull();
    expect(document.querySelector('video')).toBe(video); expect(video.currentTime).toBe(12);
    fireEvent.click(screen.getByRole('button', { name: '还原视频' }));
    expect(document.querySelector('[data-video-expanded="true"]')).toBeNull();
    expect(document.querySelector('video')).toBe(video); expect(video.currentTime).toBe(12);
    fireEvent.click(screen.getByRole('button', { name: '放大视频' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(document.querySelector('[data-video-expanded="true"]')).toBeNull();
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '放大视频' }));
    expect(requestFullscreen).not.toHaveBeenCalled();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.querySelector('[data-video-player]')).toBeNull();
    expect(revokeObjectURL).toHaveBeenCalledOnce();
  } finally { delete (HTMLElement.prototype as any).requestFullscreen; }
 });

it('removes an expanded video and releases its resource when the preview unmounts', async () => {
  fetchMock.mockResolvedValue({ ok: true, blob: async () => new Blob(['synthetic video']) });
  const view = render(<ChatFilePreview file={{ fileName: 'test.mp4', url: '/api/files/download/test.mp4', kind: 'video' }} isZh onClose={() => {}} />);
  await waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole('button', { name: '放大视频' })); view.unmount();
  expect(document.querySelector('[data-video-player]')).toBeNull();
  expect(revokeObjectURL).toHaveBeenCalledOnce();
});
