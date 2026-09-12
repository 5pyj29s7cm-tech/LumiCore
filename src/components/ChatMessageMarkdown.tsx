import React, { useMemo } from 'react';
import Markdown, { defaultUrlTransform, type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { safeMarkdownComponents } from '@/lib/externalNavigation';
import { chatArtifactFromLink } from '@/lib/chatArtifactLinks';
import type { ChatPreviewFile } from './ChatFilePreview';
import { FileResourceImage } from './FileResourceMedia';

export function ChatMessageMarkdown({ children, conversationId, onPreview }: {
  children: string; conversationId?: string; onPreview: (file: ChatPreviewFile) => void;
}) {
  const components = useMemo<Components>(() => ({
    ...safeMarkdownComponents,
    a: props => {
      const file = chatArtifactFromLink(props.href, conversationId, true);
      if (file) return <button type="button" className="text-emerald-500 underline underline-offset-4" onClick={() => onPreview(file)}>{props.children || file.fileName}</button>;
      const SafeLink = safeMarkdownComponents.a as React.ComponentType<typeof props>;
      return <SafeLink {...props} />;
    },
    code: ({ children: content, node: _node, ...props }) => {
      const file = typeof content === 'string' && !props.className ? chatArtifactFromLink(content, conversationId) : null;
      return file ? <button type="button" className="break-all text-left underline" onClick={() => onPreview(file)}><code>{content}</code></button> : <code {...props}>{content}</code>;
    },
    img: ({ src, alt }) => {
      const file = chatArtifactFromLink(src, conversationId, true);
      if (file) return <button type="button" onClick={() => onPreview(file)}><FileResourceImage src={file.url} alt={alt || file.fileName} className="max-h-64 max-w-full rounded-xl object-contain" /></button>;
      return <img src={src} alt={alt || ''} loading="lazy" />;
    },
  }), [conversationId, onPreview]);
  return <Markdown components={components} remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}
    urlTransform={url => chatArtifactFromLink(url, conversationId, true) ? url : defaultUrlTransform(url)}>{children}</Markdown>;
}
