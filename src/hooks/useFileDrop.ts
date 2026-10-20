import { useState, type DragEvent } from 'react';

/** The desktop shell and browser both deliver the same user-dropped file bytes. */
export function useFileDrop(onImport: (files: File[]) => unknown, disabled = false) {
  const [dragging, setDragging] = useState(false);
  const isFile = (event: DragEvent) => Array.from(event.dataTransfer.types || []).includes('Files');
  return {
    dragging: dragging && !disabled,
    props: {
      'data-lumi-file-drop': true,
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
        const files = Array.from(event.dataTransfer.files);
        if (!disabled && files.length) void onImport(files);
      },
    },
  };
}
