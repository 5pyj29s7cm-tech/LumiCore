import React, { useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { Plus, ArrowLeft, Check, Film, Image as ImageIcon, Loader2, Save, X } from 'lucide-react';
import { chatSongCopy } from '@/i18n/locales/chatSong';
import { apiFetch, apiJson } from '@/services/apiClient';
import { saveFileResource } from '@/services/fileResource';
import { openExternalHttpUrl } from '@/lib/externalNavigation';
import { useFileResource } from '@/hooks/useFileResource';
import { FileResourceImage, FileResourceVideo } from './FileResourceMedia';
import type { FileEntry } from './MemoryTree/types';
import type { MediaGenerationRequest } from './MediaGenerationStudio';
import { chatSongLyrics, chatSongSongCurrent, visibleChatSongLines, type ChatSongProject, type ChatSongLine, type ChatSongAssetKind, type ChatSongTiming } from '../../shared/chat_song';

const base = '/api/creative/chat-songs';
const fileUrl = (id: string, hash = "") => `/api/files/download/${encodeURIComponent(id)}?domain=personal&inline=1&v=${encodeURIComponent(hash)}`;
const json = (method: string, body: unknown): RequestInit => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const field = 'min-w-0 w-full rounded-xl border border-white/15 bg-white/5 px-3 py-2 text-sm text-white outline-none focus:border-amber-300/60';
const button = 'inline-flex shrink-0 whitespace-nowrap min-h-10 items-center justify-center gap-2 rounded-xl border border-white/15 bg-white/5 px-3 py-2 text-xs font-semibold text-white/85 hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-35';
const primary = `${button} !border-amber-200/30 !bg-amber-200 !text-slate-950 hover:!bg-amber-100`;
type Handoff = { lyrics: string; singing: string; prompts: { kind: ChatSongAssetKind; lineId: string; prompt: string }[] };
type Bundle = { fileId: string; url: string; timed: boolean; warnings: string[]; handoffs: { music: string; edit: string } };
export type ChatSongWorkbenchProps = {
  embedded?: boolean;
  locale: 'zh' | 'en'; files: FileEntry[]; libraryFailed?: boolean; busy: boolean;
  onRefreshLibrary: () => void; onClose: () => void;
  onGenerate: (request: MediaGenerationRequest) => void;
  onTask: (prompt: string) => Promise<string | undefined>;
};

export type ChatSongWorkbenchHandle = { prepareToLeave: () => Promise<boolean> };

const ChatSongWorkbench = React.forwardRef<ChatSongWorkbenchHandle, ChatSongWorkbenchProps>(function ChatSongWorkbench({ embedded = false, locale, files, libraryFailed, busy, onRefreshLibrary, onClose, onGenerate, onTask }, ref) {
  const c = chatSongCopy[locale];
  const [projects, setProjects] = useState<ChatSongProject[]>([]);
  const [project, setProject] = useState<ChatSongProject | null>(null);
  const [saved, setSaved] = useState('');
  const [tab, setTab] = useState(0);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [draft, setDraft] = useState<ChatSongLine[] | null>(null);
  const [handoff, setHandoff] = useState<Handoff | null>(null);
  const [bundle, setBundle] = useState<Bundle | null>(null);
  const [checks, setChecks] = useState([false, false, false, false]);
  const [timings, setTimings] = useState<ChatSongTiming[]>([]);
  const [seconds, setSeconds] = useState(0);
  const [songChoice, setSongChoice] = useState('');
  const audio = useRef<HTMLAudioElement>(null);
  const inFlight = useRef(false);
  const live = useRef(true);
  const controller = useRef<AbortController | null>(null);
  const savedProject = useMemo<ChatSongProject | null>(() => saved ? JSON.parse(saved) : null, [saved]);
  const contentDirty = Boolean(project && JSON.stringify(project) !== saved);
  const timingDirty = Boolean(savedProject && JSON.stringify(timings) !== JSON.stringify(savedProject.timings));
  const dirty = contentDirty || timingDirty;
  const songResource = useFileResource(project?.song ? fileUrl(project.song.fileId, project.song.sha256) : undefined);
  const disabled = working || busy;
  useEffect(() => {
    live.current = true;
    const abort = new AbortController();
    apiJson<{ projects: ChatSongProject[] }>(base, { signal: abort.signal }).then(result => {
      if (abort.signal.aborted) return;
      setProjects(result.projects);
      if (result.projects[0]) { setProject(result.projects[0]); setSaved(JSON.stringify(result.projects[0])); }
    }).catch(e => { if (!abort.signal.aborted) setError(String(e.message)); });
    return () => { live.current = false; abort.abort(); controller.current?.abort(); };
  }, []);
  useEffect(() => {
    if (!savedProject) return;
    const abort = new AbortController();
    setHandoff(null); setBundle(null); setChecks([false, false, false, false]);
    setTimings(savedProject.timings); setSeconds(0);
    apiJson<Handoff>(`${base}/${savedProject.id}/handoff`, { signal: abort.signal }).then(result => { if (!abort.signal.aborted) setHandoff(result); })
      .catch(e => { if (!abort.signal.aborted) setError(String(e.message)); });
    return () => abort.abort();
    // Refresh derived material only after a server revision, not on each keystroke.
  }, [savedProject]);
  async function run(fn: () => Promise<void>) {
    if (inFlight.current) return;
    inFlight.current = true; setWorking(true); setError(''); setNotice('');
    try { await fn(); } catch (e) { if (live.current) setError(e instanceof Error ? e.message : String(e)); }
    finally { inFlight.current = false; if (live.current) setWorking(false); }
  }
  function accept(value: ChatSongProject) {
    if (!live.current) return;
    setProject(value); setSaved(JSON.stringify(value));
    setProjects(all => [value, ...all.filter(item => item.id !== value.id)]);
  }
  async function persist(): Promise<ChatSongProject> {
    if (!project) throw new Error(c.empty);
    if (!contentDirty) return project;
    const result = await apiJson<ChatSongProject>(`${base}/${project.id}`, json('PATCH', { revision: project.revision, project: {
      title: project.title, brief: project.brief, lines: project.lines.map(({ id: _id, ...line }) => line),
    } }));
    accept(result); return result;
  }
  async function saveAll() {
    let current = await persist();
    if (timingDirty && chatSongSongCurrent(current) && current.scriptRevision === savedProject?.scriptRevision && current.song?.sha256 === savedProject?.song?.sha256) {
      current = await apiJson<ChatSongProject>(`${base}/${current.id}/action`, json('POST', { revision: current.revision, action: 'set-timings', value: timings }));
      accept(current);
    }
    return current;
  }
  useImperativeHandle(ref, () => ({
    async prepareToLeave() {
      let ready = false;
      await run(async () => { if (dirty) await saveAll(); ready = true; });
      return ready;
    },
  }));
  async function act(action: string, value?: unknown) {
    const current = action === 'set-timings' ? await persist() : await saveAll();
    accept(await apiJson<ChatSongProject>(`${base}/${current.id}/action`, json('POST', { revision: current.revision, action, value })));
  }
  async function create(reuse = false) {
    if (dirty) await saveAll();
    const next = await apiJson<ChatSongProject>(base, json('POST', { id: crypto.randomUUID(), title: `${c.defaultTitle} ${projects.length + 1}`, ...(reuse && project ? { templateId: project.id } : {}) }));
    accept(next); setDraft(null); setTab(0);
  }
  async function makeBundle(): Promise<Bundle> {
    const current = await saveAll();
    const result = await apiJson<Bundle>(`${base}/${current.id}/export`, json('POST', { revision: current.revision }));
    setBundle(result); onRefreshLibrary(); return result;
  }
  async function task(step: 'music' | 'edit') {
    const result = await makeBundle();
    if (!result.handoffs[step]) throw new Error(c.needTiming);
    const requestId = await onTask(result.handoffs[step]);
    if (!requestId) throw new Error(c.taskFailed);
    onClose();
  }
  function changeLine(index: number, patch: Partial<ChatSongLine>) {
    if (project) setProject({ ...project, lines: project.lines.map((line, i) => i === index ? { ...line, ...patch } : line) });
  }
  async function upload(file: File) {
    const form = new FormData(); form.append('files', file); form.append('domain', 'personal');
    const response = await apiFetch('/api/files/upload', { method: 'POST', body: form });
    const result = await response.json();
    if (!response.ok || result.success === false || !result.files?.length) throw new Error(result.error || 'Upload failed.');
    onRefreshLibrary(); setNotice(c.saved);
  }
  const imageFiles = files.filter(item => /\.(png|jpe?g|webp)$/i.test(item.id));
  const videoFiles = files.filter(item => /\.(mp4|webm|mov)$/i.test(item.id));
  const audioFiles = files.filter(item => /\.(mp3|wav|m4a|ogg|flac|aac)$/i.test(item.id));
  const currentSong = project ? chatSongSongCurrent(project) : false;
  const timed = Boolean(currentSong && project && project.timings.length === project.lines.length);
  const previewLines = project ? (timed ? visibleChatSongLines(project, seconds) : project.lines.filter(line => line.group === 1)) : [];
  const bg = project?.assets.find(asset => asset.kind === 'background');
  const visibleReaction = [...previewLines].reverse().map(line => project?.assets.find(asset => asset.kind === 'reaction' && asset.lineId === line.id)).find(Boolean);

  return <section aria-label={c.title} className={`${embedded ? 'relative min-h-0 flex-1' : 'absolute inset-0 z-[216]'} flex flex-col overflow-hidden bg-[#0b1017] text-white`}>
    <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-white/10 px-5 py-4">
      <div><h2 className="flex items-center gap-2 text-lg font-bold"><Film size={20} className="text-amber-200" />{c.title}<span className="rounded-md bg-amber-200/10 px-2 py-1 text-[10px] text-amber-200">{c.trial}</span></h2><p className="mt-1 max-w-2xl text-xs leading-5 text-white/50">{c.subtitle}</p></div>
      <div className="flex items-center gap-2">{project && <><span className="text-xs text-white/45">{dirty ? c.dirty : c.saved}</span><button className={primary} disabled={disabled || !dirty} onClick={() => void run(async () => { await saveAll(); })}><Save size={14} />{c.save}</button></>}
        {!embedded && <button className={button} disabled={working} onClick={() => void run(async () => { if (dirty) await saveAll(); onClose(); })}><ArrowLeft size={14} />{c.close}</button>}</div>
    </header>
    {(error || notice || working) && <div className={`flex shrink-0 items-center gap-2 border-b border-white/10 px-5 py-2 text-xs ${error ? 'bg-red-400/10 text-red-200' : 'text-amber-100'}`} role={error ? 'alert' : 'status'}>{working && <Loader2 size={14} className="animate-spin" />}{error || notice || c.loading}{error && project && <button className={button} disabled={working} onClick={() => void run(async () => { accept(await apiJson<ChatSongProject>(`${base}/${project.id}`)); setDraft(null); })}>{c.reload}</button>}</div>}
    <div className="flex min-h-0 flex-1 flex-col md:flex-row">
      <aside className="flex shrink-0 gap-2 overflow-auto border-b border-white/10 p-3 md:w-52 md:flex-col md:border-b-0 md:border-r">
        <button className={primary} disabled={disabled} onClick={() => void run(() => create())}><Plus size={14} />{c.newProject}</button>
        <p className="hidden py-2 text-[10px] uppercase tracking-widest text-white/40 md:block">{c.projects}</p>
        {projects.map(item => <button key={item.id} disabled={working} onClick={() => void run(async () => { if (dirty) await saveAll(); accept(await apiJson<ChatSongProject>(`${base}/${item.id}`)); setDraft(null); })} className={`min-w-32 rounded-xl border px-3 py-3 text-left text-xs ${project?.id === item.id ? 'border-amber-200/25 bg-amber-200/10 text-amber-100' : 'border-transparent text-white/55 hover:bg-white/5'}`}><span className="line-clamp-2 break-words font-semibold">{item.title}</span><span className="mt-1 block text-[10px] opacity-60">{item.updatedAt.slice(0, 10)}</span></button>)}
      </aside>
      {!project ? <div className="m-auto max-w-md p-8 text-center"><Film size={42} className="mx-auto mb-5 text-amber-200/70" /><h3 className="text-2xl font-bold">{c.empty}</h3><p className="mt-3 text-sm leading-6 text-white/50">{c.emptyHint}</p><button className={`${primary} mt-6`} disabled={disabled} onClick={() => void run(() => create())}>{c.newProject}</button></div> :
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <nav role="tablist" className="flex shrink-0 gap-1 overflow-x-auto border-b border-white/10 p-2">{c.tabs.map((name, i) => <button key={name} role="tab" aria-selected={tab === i} onClick={() => setTab(i)} className={`whitespace-nowrap rounded-lg px-4 py-2 text-xs ${tab === i ? 'bg-white/10 text-amber-100' : 'text-white/45'}`}>{name}</button>)}</nav>
        <div className="min-h-0 flex-1 overflow-auto p-4 md:p-6">
          {tab === 0 && <div className="mx-auto max-w-4xl space-y-5">
            <label className="block text-xs text-white/60">{c.projectName}<input className={`${field} mt-2`} value={project.title} disabled={disabled} onChange={e => setProject({ ...project, title: e.target.value })} maxLength={100} /></label>
            <div className="grid gap-4 sm:grid-cols-2">{(['theme', 'relationship', 'twist', 'visualStyle', 'musicStyle', 'targetSeconds', 'roleA', 'roleB'] as const).map(key => <label key={key} className="text-xs text-white/60">{c[key]}<input className={`${field} mt-2`} disabled={disabled} type={key === 'targetSeconds' ? 'number' : 'text'} min={10} max={300} value={project.brief[key]} onChange={e => setProject({ ...project, brief: { ...project.brief, [key]: key === 'targetSeconds' ? Number(e.target.value) : e.target.value } })} /></label>)}</div>
            <p className="text-xs leading-5 text-white/45">{c.official}</p>
            <button className={button} disabled={disabled} onClick={() => void run(async () => { const current = await saveAll(); controller.current = new AbortController(); const result = await apiJson<{ lines: ChatSongLine[] }>(`${base}/${current.id}/draft`, { ...json('POST', { revision: current.revision }), signal: controller.current.signal }); setDraft(result.lines); })}>{c.aiDraft}</button>
            {draft && <div className="space-y-3 rounded-xl border border-amber-200/20 bg-amber-200/5 p-4"><p className="text-xs text-amber-100">{c.draftNote}</p>{draft.map(line => <p key={line.id} className="text-sm">{line.role === 'A' ? project.brief.roleA : project.brief.roleB}：{line.text}</p>)}<div className="flex gap-2"><button className={primary} disabled={disabled} onClick={() => { setProject({ ...project, lines: draft }); setDraft(null); }}>{c.adopt}</button><button className={button} onClick={() => setDraft(null)}>{c.discard}</button></div></div>}
            <h3 className="font-semibold">{c.dialogue}</h3>
            {project.lines.map((line, index) => <div key={index} className="space-y-2 rounded-xl border border-white/10 bg-white/[0.025] p-3">
              <div className="flex items-center gap-2"><span className="w-6 text-xs text-white/30">{index + 1}</span><select aria-label={`${c.dialogue} ${index + 1}`} className={`${field} max-w-40`} disabled={disabled} value={line.role} onChange={e => changeLine(index, { role: e.target.value as 'A' | 'B' })}><option value="A">{project.brief.roleA}</option><option value="B">{project.brief.roleB}</option></select><label className="ml-auto flex items-center gap-2 text-xs text-white/45">{c.group}<input className={`${field} !w-16`} disabled={disabled} type="number" min={1} max={40} value={line.group} onChange={e => changeLine(index, { group: Number(e.target.value) })} /></label><button className={button} disabled={disabled} aria-label={`${c.remove} ${index + 1}`} onClick={() => setProject({ ...project, lines: project.lines.filter((_, i) => i !== index) })}><X size={14} /></button></div>
              <textarea aria-label={`${c.dialogue} ${index + 1} text`} className={field} rows={2} maxLength={100} disabled={disabled} value={line.text} onChange={e => changeLine(index, { text: e.target.value })} />
              <input aria-label={`${c.reaction} ${index + 1}`} placeholder={c.reaction} className={field} maxLength={180} disabled={disabled} value={line.reaction} onChange={e => changeLine(index, { reaction: e.target.value })} />
            </div>)}
            <div className="flex flex-wrap gap-2"><button className={button} disabled={disabled || project.lines.length >= 40} onClick={() => setProject({ ...project, lines: [...project.lines, { id: '', role: project.lines.at(-1)?.role === 'A' ? 'B' : 'A', text: '', group: project.lines.at(-1)?.group || 1, reaction: '' }] })}><Plus size={14} />{c.addLine}</button><button className={primary} disabled={disabled || (!dirty && project.scriptLocked)} onClick={() => void run(() => act('lock-script'))}>{project.scriptLocked && !dirty ? <Check size={14} /> : null}{project.scriptLocked && !dirty ? c.locked : c.lock}</button><button className={button} disabled={disabled} onClick={() => void run(() => create(true))}>{c.reuse}</button></div><p className="text-xs leading-5 text-white/40">{c.invalidation}</p>
          </div>}
          {tab === 1 && <div className="mx-auto max-w-4xl space-y-5"><p className="text-sm leading-6 text-white/60">{c.assetsHint}</p><p className="text-xs text-white/40">{c.fileLimit}</p><div className="flex gap-2"><label className={`${button} cursor-pointer`}>{c.upload}<input className="sr-only" type="file" accept=".png,.jpg,.jpeg,.webp,.mp4,.webm,.mov,.mp3,.wav,.m4a,.ogg,.flac,.aac" disabled={disabled} onChange={e => { const file = e.target.files?.[0]; e.target.value = ''; if (file) void run(() => upload(file)); }} /></label><button className={button} disabled={disabled} onClick={onRefreshLibrary}>{c.refresh}</button></div>{libraryFailed && <p role="alert">{c.libraryFailed}</p>}
            <div className="grid gap-4 lg:grid-cols-2">{handoff?.prompts.map(item => {
              const asset = project.assets.find(asset => asset.kind === item.kind && asset.lineId === item.lineId);
              const name = c[item.kind === 'reaction' ? 'reactionAsset' : item.kind];
              return <AssetSlot key={`${item.kind}:${item.lineId}`} name={`${name}${item.lineId ? ` · ${item.lineId}` : ''}`} locale={locale} files={item.kind === 'clip' ? videoFiles : imageFiles} asset={asset} disabled={disabled} onAttach={id => void run(() => act('attach-asset', { kind: item.kind, lineId: item.lineId, fileId: id }))} onRemove={() => void run(() => act('remove-asset', asset?.id))} onGenerate={() => void run(async () => {
                const current = await saveAll();
                const fresh = await apiJson<Handoff>(`${base}/${current.id}/handoff`);
                const prompt = fresh.prompts.find(p => p.kind === item.kind && p.lineId === item.lineId)?.prompt;
                if (!prompt) throw new Error(c.noLine);
                const mode = item.kind === 'clip' ? 'video' : 'image';
                await apiJson(`${base}/${current.id}/media-preflight`, json('POST', { mode }));
                onGenerate({ mode, operation: mode === 'video' ? 'text_to_video' : 'text_to_image', prompt, size: mode === 'video' ? '720x1280' : item.kind === 'background' ? '1024x1792' : '1024x1024', count: 1, duration: 6, officialOnly: true });
              })} />;
            })}</div>{!project.lines.some(line => line.reaction) && <p className="text-xs text-white/40">{c.noLine}</p>}
          </div>}
          {tab === 2 && <div className="mx-auto grid max-w-6xl gap-6 xl:grid-cols-[minmax(0,1fr)_300px]">
            <div className="min-w-0 space-y-4"><p className="text-sm leading-6 text-white/60">{c.songHint}</p><button className={button} onClick={() => void run(async () => { await openExternalHttpUrl('https://music.douyin.com/studio'); })}>{c.openMusic}</button>
              <div className="rounded-xl border border-white/10 p-4"><h3 className="mb-2 text-sm font-semibold">{c.lyrics}</h3><pre className="max-h-52 overflow-auto whitespace-pre-wrap text-sm leading-7 text-white/65">{chatSongLyrics(project.lines)}</pre><button className={`${button} mt-3`} disabled={disabled} onClick={() => void run(async () => { await navigator.clipboard.writeText(chatSongLyrics(project.lines)); setNotice(c.copied); })}>{c.copy}</button><p className="mt-4 text-xs leading-6 text-white/45">{handoff?.singing}</p></div>
              <label className={`${button} cursor-pointer`}>{c.upload}<input className="sr-only" type="file" accept=".mp3,.wav,.m4a,.ogg,.flac,.aac" disabled={disabled} onChange={e => { const file = e.target.files?.[0]; e.target.value = ''; if (file) void run(() => upload(file)); }} /></label>
              <div className="flex gap-2"><select aria-label={c.song} className={field} value={songChoice} disabled={disabled} onChange={e => setSongChoice(e.target.value)}><option value="">{c.choose}</option>{audioFiles.map(file => <option key={file.id} value={file.id}>{file.displayName || file.name}</option>)}</select><button className={button} disabled={disabled || !songChoice || !project.scriptLocked || dirty} onClick={() => void run(() => act('select-song', { fileId: songChoice }))}>{c.selectSong}</button></div>
              {!project.scriptLocked && <p className="text-xs text-amber-200">{c.needLock}</p>}
              {project.song && <><p className="break-all text-xs text-white/60">{project.song.name} · {project.song.duration.toFixed(1)}s</p>{songResource.error && <p role="alert">{songResource.error.message}</p>}<audio ref={audio} src={songResource.url} controls className="sticky top-0 z-10 w-full" onTimeUpdate={e => setSeconds(e.currentTarget.currentTime)} />
                <fieldset disabled={disabled || currentSong || dirty} className="space-y-2 rounded-xl border border-white/10 p-4"><legend className="px-2 text-sm">{currentSong ? c.songConfirmed : c.checkLyrics}</legend>{c.checks.map((label, index) => <label key={label} className="flex items-center gap-2 text-xs text-white/65"><input type="checkbox" checked={currentSong || checks[index]} onChange={e => setChecks(values => values.map((value, i) => i === index ? e.target.checked : value))} />{label}</label>)}<button className={`${primary} mt-2`} disabled={disabled || currentSong || !checks.every(Boolean)} onClick={() => void run(() => act('confirm-song', { noOmissions: true, noRewrites: true, noRepeats: true, correctOrder: true }))}>{currentSong ? c.songConfirmed : c.confirmSong}</button></fieldset>
              </>}
              <h3 className="font-semibold">{c.timings}</h3><p className="text-xs leading-5 text-white/45">{c.timingHint}</p>{currentSong ? <><div className="space-y-3">{project.lines.map((line, index) => <div key={line.id} className="rounded-xl border border-white/10 p-3"><p className="mb-2 text-sm text-white/70">{line.id} · {line.text}</p><div className="grid grid-cols-2 gap-3">{(['start', 'end'] as const).map(key => {
                const change = (value: number) => setTimings(all => project.lines.map((l, i) => ({ lineId: l.id, start: all[i]?.start ?? 0, end: all[i]?.end ?? 0, ...(i === index ? { [key]: value } : {}) })));
                return <label key={key} className="text-[10px] text-white/45">{c[key]}<div className="mt-1 flex gap-1"><input className={field} type="number" min={0} step={0.1} disabled={disabled || contentDirty} value={timings[index]?.[key] ?? ''} onChange={e => change(Number(e.target.value))} /><button className={button} disabled={disabled || contentDirty || !songResource.url} onClick={() => change(Math.round((audio.current?.currentTime || 0) * 100) / 100)}>{key === 'start' ? c.markStart : c.markEnd}</button></div></label>;
              })}</div></div>)}</div><button className={primary} disabled={disabled || contentDirty} onClick={() => void run(() => act('set-timings', timings))}>{c.saveTiming}</button></> : <p className="text-xs text-amber-200">{c.needSong}</p>}
            </div>
            <div className="order-first w-full max-w-[340px] self-start justify-self-center xl:sticky xl:top-0 xl:order-none"><h3 className="mb-3 text-sm font-semibold">{c.preview}</h3><div className="relative aspect-[3/4] overflow-hidden rounded-2xl border border-white/15 bg-[#263338]">
              {bg && <FileResourceImage src={fileUrl(bg.fileId, bg.sha256)} alt="" className="absolute inset-0 h-full w-full scale-110 object-cover opacity-40 blur-sm" />}
              <div className="relative space-y-1.5 px-3 pt-8">{previewLines.map(line => {
                const avatar = project.assets.find(asset => asset.kind === `avatar${line.role}`);
                return <div key={line.id} className={`flex items-start gap-1.5 bg-[#ededed] px-2 py-2 ${line.role === 'B' ? 'flex-row-reverse' : ''}`}>
                  {avatar ? <FileResourceImage src={fileUrl(avatar.fileId, avatar.sha256)} alt="" className="h-7 w-7 shrink-0 rounded object-cover" /> : <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded bg-slate-600 text-[10px]">{line.role}</span>}
                  <p className={`max-w-[82%] whitespace-pre-wrap break-words rounded px-2 py-1.5 text-[11px] leading-4 text-black ${line.role === 'B' ? 'bg-[#9eea6a]' : 'bg-white'}`}>{line.text}</p>
                </div>;
              })}</div>{visibleReaction && <FileResourceImage src={fileUrl(visibleReaction.fileId, visibleReaction.sha256)} alt="" className="relative mx-auto mt-4 max-h-28 w-2/5 rounded-lg object-contain" />}
            </div><p className="mt-3 text-xs leading-5 text-white/40">{c.previewHint}</p></div>
          </div>}
          {tab === 3 && <div className="mx-auto max-w-3xl space-y-5"><div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5"><h3 className="mb-3 text-lg font-bold">{project.title}</h3><div className="space-y-2 text-sm text-white/60"><p>{project.scriptLocked && !dirty ? c.locked : c.needLock}</p><p>{currentSong ? c.songConfirmed : c.needSong}</p><p>{timed ? c.saved : c.needTiming}</p></div></div><p className="text-sm leading-6 text-white/60">{c.bundleHint}</p><div className="flex flex-wrap gap-2"><button className={primary} disabled={disabled || !project.scriptLocked || dirty} onClick={() => void run(async () => { const result = await makeBundle(); await saveFileResource(result.url, result.fileId); })}>{c.export}</button><button className={button} disabled={disabled || !project.scriptLocked || dirty} onClick={() => void run(() => task('music'))}>{c.musicTask}</button><button className={button} disabled={disabled || !timed || dirty} onClick={() => void run(() => task('edit'))}>{c.editTask}</button></div>
            {bundle && <div className="space-y-2 rounded-xl border border-emerald-200/20 p-4"><p className="text-sm text-emerald-200">{c.exported}</p>{bundle.warnings.map(warning => <p key={warning} className="text-xs text-amber-100">{warning}</p>)}<button className={button} onClick={() => void run(() => saveFileResource(bundle.url, bundle.fileId))}>{c.download}</button></div>}
            <p className="text-xs leading-6 text-white/50">{c.handoffHint}</p><p className="rounded-xl border border-amber-200/15 bg-amber-200/5 p-4 text-xs leading-6 text-amber-100/80">{c.externalLimit}</p>
          </div>}
        </div>
      </div>}
    </div>
  </section>;
});

export default ChatSongWorkbench;

function AssetSlot({ name, locale, files, asset, disabled, onAttach, onGenerate, onRemove }: {
  name: string; locale: 'zh' | 'en'; files: FileEntry[]; asset?: ChatSongProject['assets'][number]; disabled: boolean;
  onAttach: (id: string) => void; onGenerate: () => void; onRemove: () => void;
}) {
  const c = chatSongCopy[locale], [choice, setChoice] = useState('');
  return <article className="space-y-3 rounded-2xl border border-white/10 bg-white/[0.025] p-4"><h3 className="text-sm font-semibold">{name}</h3>
    <div className="flex h-32 items-center justify-center overflow-hidden rounded-xl bg-black/20">{asset ? asset.kind === 'clip' ? <FileResourceVideo controls src={fileUrl(asset.fileId, asset.sha256)} className="h-full max-w-full" /> : <FileResourceImage src={fileUrl(asset.fileId, asset.sha256)} alt={name} className="h-full w-full object-contain" /> : <ImageIcon className="text-white/15" size={32} />}</div>
    {asset && <div className="flex items-center justify-between gap-2"><p className="truncate text-[10px] text-white/40">{c.selected} · {asset.name}</p><button className={button} disabled={disabled} onClick={onRemove} aria-label={`${c.remove} ${name}`}><X size={12} /></button></div>}
    <select aria-label={name} className={field} disabled={disabled} value={choice} onChange={e => setChoice(e.target.value)}><option value="">{c.choose}</option>{files.map(file => <option key={file.id} value={file.id}>{file.displayName || file.name}</option>)}</select>
    <div className="flex flex-wrap gap-2"><button className={button} disabled={disabled || !choice} onClick={() => onAttach(choice)}>{c.attach}</button><button className={button} disabled={disabled} onClick={onGenerate}>{c.generate}</button></div>
  </article>;
}
