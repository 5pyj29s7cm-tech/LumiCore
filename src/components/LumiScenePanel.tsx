import React from 'react';
import { Boxes, CheckCircle2, CircleAlert, Layers3 } from 'lucide-react';
import type { LumiSceneNode, LumiSceneSnapshot, LumiSceneTone } from '../../shared/lumi_scene';
import { lumiSceneCopy } from '@/i18n/locales/lumiScene';

function toneClass(tone: LumiSceneTone | undefined): string {
  if (tone === 'success') return 'border-emerald-300/16 bg-emerald-300/[0.05] text-emerald-100';
  if (tone === 'warning') return 'border-amber-300/16 bg-amber-300/[0.05] text-amber-100';
  if (tone === 'danger') return 'border-red-300/16 bg-red-300/[0.05] text-red-100';
  if (tone === 'info') return 'border-cyan-300/16 bg-cyan-300/[0.05] text-cyan-100';
  return 'border-white/8 bg-white/[0.025] text-white/70';
}

function nodeTitle(title: string): string {
  const labels = lumiSceneCopy().labels as Record<string, string>;
  return labels[title] || title;
}

function SceneNodeView({ node, compact = false }: { node: LumiSceneNode; compact?: boolean }) {
  const isGroup = node.kind === 'group';
  return (
    <div className={`rounded-xl border ${toneClass(node.tone)} ${compact ? 'p-2' : 'p-3'}`}>
      <div className="flex min-w-0 items-center gap-2">
        {isGroup ? <Layers3 size={12} className="shrink-0 opacity-65" /> : node.tone === 'danger' || node.tone === 'warning' ? <CircleAlert size={12} className="shrink-0" /> : <CheckCircle2 size={12} className="shrink-0 opacity-70" />}
        <span className="min-w-0 flex-1 truncate text-[11px] font-bold">{nodeTitle(node.title)}</span>
        {node.value !== undefined && (
          <span className="shrink-0 rounded-md border border-current/15 bg-black/10 px-1.5 py-0.5 text-[9px] font-black uppercase">
            {String(node.value)}
          </span>
        )}
      </div>
      {node.detail && <div className="mt-1 truncate pl-5 text-[10px] opacity-55" title={node.detail}>{node.detail}</div>}
      {node.children && node.children.length > 0 && (
        <div className={`mt-2 grid gap-1.5 ${compact ? '' : 'md:grid-cols-2'}`}>
          {node.children.slice(0, compact ? 3 : 12).map(child => (
            <SceneNodeView key={child.id} node={child} compact />
          ))}
        </div>
      )}
    </div>
  );
}

export function LumiScenePanel({
  scene,
  loading = false,
  error = '',
  compact = false,
}: {
  scene: LumiSceneSnapshot | null;
  loading?: boolean;
  error?: string;
  compact?: boolean;
}) {
  const copy = lumiSceneCopy();
  if (!scene) {
    if (!loading && !error) return null;
    return <div className="rounded-xl border border-white/10 bg-white/[0.025] px-3 py-2 text-xs text-white/38">{loading ? copy.syncing : copy.unavailable}</div>;
  }
  const visibleNodes = compact
    ? scene.nodes.filter(node => node.id === 'runtime.overall' || node.id === 'runtime.tasks').slice(0, 2)
    : scene.nodes;
  return (
    <section className="rounded-xl border border-violet-300/12 bg-violet-300/[0.035] p-3">
      <div className="flex min-w-0 items-center gap-2 text-violet-100/75">
        <Boxes size={14} />
        <span className="text-[10px] font-black uppercase tracking-widest">{copy.title}</span>
        <span className="min-w-0 flex-1 truncate text-right font-mono text-[9px] text-white/28">
          {copy.revision} {scene.revision} · {scene.digest.slice(0, 10)}
        </span>
      </div>
      <div className={`mt-3 grid gap-2 ${compact ? '' : 'xl:grid-cols-2'}`}>
        {visibleNodes.map(node => <SceneNodeView key={node.id} node={node} compact={compact} />)}
      </div>
    </section>
  );
}
