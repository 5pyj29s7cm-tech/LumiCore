import { useEffect, useLayoutEffect, useRef, useState, type DragEvent } from 'react';
import { listenForNativeChatFileDrop } from '../lib/chatAttachmentUploads';
import type { KnowledgeFileSource } from '../lib/knowledgeFileImport';

/** A visible drop zone owns both browser files and Tauri desktop paths. */
export function useFileDrop(onImport: (source: KnowledgeFileSource) => unknown, disabled = false) {
  const ref = useRef<HTMLDivElement>(null);
  const lastDrop = useRef(0);
  const current = useRef<typeof onImport | null>(onImport);
  const [dragging, setDragging] = useState(false);
  useLayoutEffect(() => { current.current = disabled ? null : onImport; }, [disabled, onImport]);
  useEffect(() => listenForNativeChatFileDrop(setDragging, lastDrop, async paths => {
    if (paths.length) await current.current?.(paths);
  }, ref), []);
  const isFile = (event: DragEvent) => Array.from(event.dataTransfer.types || []).includes('Files');
  return {
    dragging: dragging && !disabled,
    props: {
      ref, 'data-lumi-file-drop': true,
      onDragOver: (event: DragEvent) => {
        if (!isFile(event)) return;
        event.preventDefault(); event.stopPropagation();
        event.dataTransfer.dropEffect = disabled ? 'none' : 'copy';
        setDragging(!disabled);
      },
      onDragLeave: (event: DragEvent) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
      },
      onDrop: (event: DragEvent) => {
        if (!isFile(event)) return;
        event.preventDefault(); event.stopPropagation(); setDragging(false);
        if (Date.now() - lastDrop.current < 700) return;
        const files = Array.from(event.dataTransfer.files);
        if (files.length) void current.current?.(files);
      },
    },
  };
}
