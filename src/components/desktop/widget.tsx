import React, { lazy, useRef, useState, useCallback, useEffect } from "react";
import { type PetConfig } from "../../pets/types";
import { type OperationMode } from "@/contexts/AppContext";
import { getDefaultPets } from "../../pets/defaults";
import { uiMessage, formatUiMessage } from "../../i18n/uiMessages";
import { toast } from "sonner";
import { motion, AnimatePresence } from "motion/react";
import { Upload, Maximize2, Brush, Minus, Sparkles, RefreshCw, Mic } from "lucide-react";
import { PetAvatar } from "../SpriteAnimator";

export const LumiCoreAvatar = lazy(() => import("../LumiCoreAvatar").then(m => ({ default: m.LumiCoreAvatar })));


export function DesktopWidgetPanel({
  t,
  lang,
  selectedPet,
  equippedAccessories,
  petReaction,
  callState,
  audioLevel,
  transcript,
  operationMode,
  workDomain,
  wakeEnabled,
  wakeListening,
  wakeError,
  onStartVoice,
  onEndVoice,
  onExpand,
  onHide,
  onOpenPersonalization,
}: {
  t: any;
  lang: 'en' | 'zh';
  selectedPet: PetConfig | null;
  equippedAccessories: string[];
  petReaction: { animation: string; until: number } | null;
  callState: string;
  audioLevel: number;
  transcript: string;
  operationMode: OperationMode;
  workDomain: 'personal' | 'work';
  wakeEnabled: boolean;
  wakeListening: boolean;
  wakeError?: string | null;
  onStartVoice: () => void;
  onEndVoice: () => void;
  onExpand: () => void;
  onHide: () => void;
  onOpenPersonalization: () => void;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const nativeDropHandledAtRef = useRef(0);
  const [uploading, setUploading] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const isCallActive = callState !== 'idle';
  const widgetPet = selectedPet || getDefaultPets()[0] || null;
  const widgetAccessories = selectedPet ? equippedAccessories : [];
  const statusLabel = isCallActive
    ? (operationMode === 'meeting' ? (uiMessage('desktop-ui.meeting.984f831252', (lang === 'zh') ? 'zh' : 'en')) : callState)
    : wakeEnabled && wakeListening
      ? (uiMessage('desktop-ui.wake-ready.0bf5093bf8', (lang === 'zh') ? 'zh' : 'en'))
      : (uiMessage('desktop-ui.ready.0e6f84aaa2', (lang === 'zh') ? 'zh' : 'en'));
  const reactionAnimation = petReaction?.animation === 'jump' ? 'wave' : petReaction?.animation;
  const petAnimation = reactionAnimation ? reactionAnimation as any :
    callState === 'speaking' ? 'wave' :
    callState === 'listening' ? 'idle' :
    callState !== 'idle' ? 'wave' :
    dragActive || uploading ? 'wave' :
    'idle';
  const speechText = operationMode === 'meeting'
    ? (wakeError ? `Wake: ${wakeError}` : '')
    : transcript || (wakeError ? `Wake: ${wakeError}` : '');
  const showWidgetChrome = isCallActive || dragActive || uploading || Boolean(speechText);
  const chromeVisibility = showWidgetChrome
    ? 'opacity-100 pointer-events-auto'
    : 'opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto';

  const uploadKnowledgeFiles = useCallback(async (files: FileList | null) => {
    if (!files || files.length === 0 || uploading) return;
    setUploading(true);
    try {
      const formData = new FormData();
      Array.from(files).forEach(file => formData.append('files', file));
      const res = await fetch(`/api/files/upload?domain=${encodeURIComponent(workDomain)}`, {
        method: 'POST',
        body: formData,
        credentials: 'include',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || (uiMessage('desktop-ui.upload-failed.89491ff4a3', (lang === 'zh') ? 'zh' : 'en')));
      const count = Array.isArray(data.files) ? data.files.length : files.length;
      toast.success(formatUiMessage('desktop-ui.fed-value0-file-s.8357f1bc3f', { value0: count }, (lang === 'zh') ? 'zh' : 'en'));
      window.dispatchEvent(new CustomEvent('lumi:knowledge-updated', {
        detail: {
          domain: workDomain,
          files: (data.files || []).map((file: any) => ({ id: file.id, name: file.name, displayName: file.displayName })),
        },
      }));
      window.dispatchEvent(new CustomEvent('lumi:client-state-refresh'));
    } catch (err: any) {
      toast.error(err?.message || (uiMessage('desktop-ui.upload-failed.89491ff4a3', (lang === 'zh') ? 'zh' : 'en')));
    } finally {
      setUploading(false);
      setDragActive(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }, [lang, uploading, workDomain]);

  const uploadKnowledgePaths = useCallback(async (paths: string[]) => {
    const importPaths = paths.map(p => String(p || '').trim()).filter(Boolean);
    if (importPaths.length === 0 || uploading) return;
    setUploading(true);
    try {
      const res = await fetch(`/api/files/import-paths?domain=${encodeURIComponent(workDomain)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Lumi-Desktop-Import': 'file-drop' },
        body: JSON.stringify({ paths: importPaths }),
        credentials: 'include',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || (uiMessage('desktop-ui.feed-failed.1e27b5712f', (lang === 'zh') ? 'zh' : 'en')));
      const count = Array.isArray(data.files) ? data.files.length : importPaths.length;
      const skipped = Array.isArray(data.skipped) ? data.skipped.length : 0;
      toast.success(
        formatUiMessage('desktop-ui.fed-value0-file-s-value1.167b70a2bd', { value0: count, value1: { en: skipped ? `, skipped ${skipped}` : '', zh: skipped ? `，跳过 ${skipped} 个` : '' } }, (lang === 'zh') ? 'zh' : 'en'),
      );
      window.dispatchEvent(new CustomEvent('lumi:knowledge-updated', {
        detail: {
          domain: workDomain,
          files: (data.files || []).map((file: any) => ({ id: file.id, name: file.name, displayName: file.displayName })),
        },
      }));
      window.dispatchEvent(new CustomEvent('lumi:client-state-refresh'));
    } catch (err: any) {
      toast.error(err?.message || (uiMessage('desktop-ui.feed-failed.1e27b5712f', (lang === 'zh') ? 'zh' : 'en')));
    } finally {
      setUploading(false);
      setDragActive(false);
    }
  }, [lang, uploading, workDomain]);

  useEffect(() => {
    if (typeof window === 'undefined' || !(window as any).__TAURI_INTERNALS__) return;
    let cancelled = false;
    let unlisten: (() => void) | undefined;

    const setupDropListener = async () => {
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        if (cancelled) return;
        unlisten = await getCurrentWindow().onDragDropEvent((event: any) => {
          const payload = event?.payload;
          if (payload?.type === 'over') {
            setDragActive(true);
            return;
          }
          if (payload?.type === 'drop') {
            nativeDropHandledAtRef.current = Date.now();
            setDragActive(false);
            const paths = Array.isArray(payload.paths) ? payload.paths : [];
            void uploadKnowledgePaths(paths);
            return;
          }
          setDragActive(false);
        });
        if (cancelled) unlisten?.();
      } catch {}
    };

    void setupDropListener();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [uploadKnowledgePaths]);

  const handleDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (!dragActive) setDragActive(true);
  };

  const handleDragLeave = (event: React.DragEvent<HTMLDivElement>) => {
    const nextTarget = event.relatedTarget as Node | null;
    if (!nextTarget || !event.currentTarget.contains(nextTarget)) {
      setDragActive(false);
    }
  };

  const handleDrop = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setDragActive(false);
    if (Date.now() - nativeDropHandledAtRef.current < 700) return;
    void uploadKnowledgeFiles(event.dataTransfer.files);
  };

  const handleWidgetDragStart = async (event: React.PointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest('[data-widget-action="true"]')) return;
    try {
      const windowApi = await import('@tauri-apps/api/window');
      await windowApi.getCurrentWindow().startDragging();
    } catch {}
  };

  return (
    <div className="fixed inset-0 overflow-hidden bg-transparent text-white">
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(event) => void uploadKnowledgeFiles(event.currentTarget.files)}
      />
      <motion.div
        initial={{ opacity: 0, scale: 0.96, y: 10 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        className="group relative h-full w-full overflow-hidden bg-transparent"
        onDragEnter={handleDragOver}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onPointerDown={handleWidgetDragStart}
      >
        <div data-tauri-drag-region className="absolute inset-0 z-0 cursor-grab active:cursor-grabbing" />

        <AnimatePresence>
          {dragActive && (
            <motion.div
              initial={{ opacity: 0, scale: 0.94 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.94 }}
              className="absolute inset-5 z-40 flex items-center justify-center rounded-[28px] border border-cyan-300/35 bg-cyan-300/10 text-cyan-100 shadow-[0_0_24px_rgba(34,211,238,0.16)] backdrop-blur-md"
            >
              <Upload size={30} />
            </motion.div>
          )}
        </AnimatePresence>

        <motion.div
          data-tauri-drag-region
          className={`absolute left-1/2 top-2 z-20 flex -translate-x-1/2 cursor-move items-center gap-1.5 rounded-full border border-white/8 bg-black/28 px-2.5 py-1 text-[10px] font-black text-white/65 shadow-lg backdrop-blur-lg transition-opacity duration-200 ${chromeVisibility}`}
        >
          <span className={`h-2 w-2 rounded-full ${isCallActive ? 'bg-celestial-saturn shadow-[0_0_14px_rgba(255,204,0,0.85)]' : 'bg-emerald-400'}`} />
          <span className="max-w-[104px] truncate">{statusLabel}</span>
        </motion.div>

        <AnimatePresence>
          {speechText && (
            <motion.div
              initial={{ opacity: 0, y: 8, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 8, scale: 0.96 }}
              className={`absolute left-3 right-11 top-10 z-20 rounded-2xl border px-2.5 py-1.5 text-[11px] leading-4 shadow-xl backdrop-blur-lg ${
                wakeError && !transcript
                  ? 'border-red-300/18 bg-red-950/45 text-red-100/78'
                  : 'border-white/10 bg-black/42 text-white/72'
              }`}
            >
              <p className="line-clamp-2">{speechText}</p>
            </motion.div>
          )}
        </AnimatePresence>

        <div className={`absolute right-1.5 top-12 z-30 flex flex-col gap-1.5 transition-opacity duration-200 ${chromeVisibility}`}>
          <button
            data-widget-action="true"
            onClick={onExpand}
            className="flex h-8 w-8 items-center justify-center rounded-full border border-white/8 bg-black/30 text-white/58 shadow-lg backdrop-blur-lg transition-colors hover:bg-white/12 hover:text-white"
            title={uiMessage('desktop-ui.expand-lumi.b72aee2f04', (lang === 'zh') ? 'zh' : 'en')}
          >
            <Maximize2 size={14} />
          </button>
          <button
            data-widget-action="true"
            onClick={onOpenPersonalization}
            className="flex h-8 w-8 items-center justify-center rounded-full border border-fuchsia-300/14 bg-fuchsia-300/9 text-fuchsia-100/72 shadow-lg backdrop-blur-lg transition-colors hover:bg-fuchsia-300/18 hover:text-white"
            title={t.personalization || 'Personalization'}
          >
            <Brush size={14} />
          </button>
          <button
            data-widget-action="true"
            onClick={onHide}
            className="flex h-8 w-8 items-center justify-center rounded-full border border-white/8 bg-black/30 text-white/52 shadow-lg backdrop-blur-lg transition-colors hover:bg-white/12 hover:text-white"
            title={uiMessage('desktop-ui.hide-to-background.2db659458c', (lang === 'zh') ? 'zh' : 'en')}
          >
            <Minus size={14} />
          </button>
        </div>

        <div
          data-tauri-drag-region
          className="absolute left-1/2 top-[47%] z-10 flex h-40 w-40 -translate-x-1/2 -translate-y-1/2 cursor-grab items-center justify-center rounded-full transition-transform hover:scale-[1.03] active:cursor-grabbing active:scale-95"
          title={widgetPet?.name || (uiMessage('desktop-ui.drag-lumi.37ae7800b2', (lang === 'zh') ? 'zh' : 'en'))}
        >
          <motion.div
            className="absolute inset-7 rounded-full bg-cyan-200/7 blur-xl"
            animate={{
              scale: isCallActive ? [1, 1.12 + audioLevel * 0.35, 1] : 1,
              opacity: isCallActive ? [0.2, 0.5, 0.2] : 0,
            }}
            transition={{ duration: isCallActive ? 0.9 : 0.2, repeat: isCallActive ? Infinity : 0 }}
          />
          {widgetPet ? (
            <PetAvatar
              pet={widgetPet}
              animation={petAnimation}
              accessoryIds={widgetAccessories}
              scale={0.68}
              audioLevel={audioLevel}
              callState={callState}
              behavior="default"
            />
          ) : (
            <Sparkles size={54} className="text-celestial-saturn/80 drop-shadow-[0_0_18px_rgba(255,204,0,0.32)]" />
          )}
        </div>

        <div className={`absolute bottom-3 left-1/2 z-30 flex -translate-x-1/2 items-center gap-2.5 transition-opacity duration-200 ${chromeVisibility}`}>
          <button
            data-widget-action="true"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            className="flex h-10 w-10 items-center justify-center rounded-full border border-cyan-300/18 bg-cyan-300/10 text-cyan-100 shadow-lg backdrop-blur-lg transition-colors hover:bg-cyan-300/20 disabled:opacity-60"
            title={uiMessage('desktop-ui.feed-files.f5edc50e24', (lang === 'zh') ? 'zh' : 'en')}
          >
            {uploading ? <RefreshCw size={17} className="animate-spin" /> : <Upload size={18} />}
          </button>
          <button
            data-widget-action="true"
            onClick={() => (isCallActive ? onEndVoice() : onStartVoice())}
            className={`flex h-12 w-12 items-center justify-center rounded-full border shadow-xl backdrop-blur-lg transition-colors ${
              isCallActive
                ? 'border-red-300/32 bg-red-500/20 text-red-100 hover:bg-red-500/28'
                : 'border-celestial-saturn/28 bg-celestial-saturn/16 text-celestial-saturn hover:bg-celestial-saturn/24'
            }`}
            title={isCallActive ? (uiMessage('desktop-ui.end-voice.d265560105', (lang === 'zh') ? 'zh' : 'en')) : (uiMessage('desktop-ui.voice.fee5489af0', (lang === 'zh') ? 'zh' : 'en'))}
          >
            <Mic size={20} className={isCallActive ? 'animate-pulse' : ''} />
          </button>
        </div>
      </motion.div>
    </div>
  );
}
