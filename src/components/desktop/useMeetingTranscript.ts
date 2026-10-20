import { type MeetingNote, type RefinedMeetingSegment } from './runtime_state';
import { useState, useEffect, useCallback, useRef, type Dispatch, type SetStateAction } from 'react';
import { toast } from 'sonner';
import { useSocket } from '@/hooks/useSocket';
import { type VoiceTranscriptMeta } from '@/hooks/useVoiceCall';
import { type OperationMode } from '@/contexts/AppContext';
import { uiMessage } from '../../i18n/uiMessages';
import { desktopWorkflowCopy } from '../../i18n/locales/desktopWorkflows';

export type MeetingRecord = {
  id: string; startedAt: number | null; notes: MeetingNote[]; report: string;
  caseId: string; caseTitle: string; readOnly: boolean;
  archiveReceipt?: { caseId: string; at: number };
};
type MeetingHistory = { activeId: string; records: MeetingRecord[] };
type MeetingStore = { scope: string; key: string; history: MeetingHistory; valid: boolean };
type useMeetingTranscriptInput = {
  workDomain: 'personal' | 'work';
  meetingStorageKeys: { identity: string; startedAt: string; notes: string; report: string };
  meetingPreferenceScopeKey: string; operationMode: OperationMode; lang: 'en' | 'zh';
  socket: ReturnType<typeof useSocket>;
};
const hasMeetingContent = (record: MeetingRecord) => record.notes.length > 0 || record.report.length > 0;
const emptyMeetingRecord = (): MeetingRecord => ({ id: crypto.randomUUID(), startedAt: null, notes: [], report: '', caseId: '', caseTitle: '', readOnly: false });
const object = (value: unknown): value is Record<string, any> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
function parseMeetingRecord(value: unknown): MeetingRecord {
  if (!object(value) || typeof value.id !== 'string' || !value.id.trim() || value.id.length > 200
    || !(value.startedAt === null || typeof value.startedAt === 'number' && Number.isFinite(value.startedAt) && value.startedAt >= 0)
    || typeof value.report !== 'string' || typeof value.caseId !== 'string' || typeof value.caseTitle !== 'string'
    || typeof value.readOnly !== 'boolean' || !Array.isArray(value.notes)) throw new Error('Invalid meeting record');
  const archiveReceipt = value.archiveReceipt;
  if (archiveReceipt !== undefined && (!object(archiveReceipt) || typeof archiveReceipt.caseId !== 'string' || !archiveReceipt.caseId
    || archiveReceipt.caseId !== value.caseId || typeof archiveReceipt.at !== 'number' || !Number.isFinite(archiveReceipt.at) || archiveReceipt.at < 0)) throw new Error('Invalid meeting archive receipt');
  const notes = value.notes.map((note: unknown): MeetingNote => {
    if (!object(note) || typeof note.id !== 'string' || !note.id || typeof note.text !== 'string'
      || !Number.isFinite(note.time) || typeof note.time !== 'number'
      || !(note.speakerLabel === undefined || note.speakerLabel === null || typeof note.speakerLabel === 'string')
      || !(note.speakerConfidence === undefined || typeof note.speakerConfidence === 'number' && Number.isFinite(note.speakerConfidence))
      || !(note.speakerSource === undefined || typeof note.speakerSource === 'string')
      || !(note.speakerMatched === undefined || typeof note.speakerMatched === 'boolean')) throw new Error('Invalid meeting note');
    return { id: note.id, text: note.text, time: note.time,
      ...(note.speakerLabel !== undefined ? { speakerLabel: note.speakerLabel } : {}),
      ...(note.speakerConfidence !== undefined ? { speakerConfidence: note.speakerConfidence } : {}),
      ...(note.speakerSource !== undefined ? { speakerSource: note.speakerSource } : {}),
      ...(note.speakerMatched !== undefined ? { speakerMatched: note.speakerMatched } : {}) };
  });
  return { id: value.id, startedAt: value.startedAt, notes, report: value.report, caseId: value.caseId, caseTitle: value.caseTitle, readOnly: value.readOnly,
    ...(archiveReceipt ? { archiveReceipt: { caseId: archiveReceipt.caseId, at: archiveReceipt.at } } : {}) };
}

export function useMeetingTranscript({ workDomain, meetingStorageKeys, meetingPreferenceScopeKey, operationMode, lang, socket }: useMeetingTranscriptInput) {
  const historyKey = meetingStorageKeys.notes + '_history';
  const loadHistory = (): MeetingStore => {
    const empty = emptyMeetingRecord();
    const store: MeetingStore = { scope: meetingPreferenceScopeKey, key: historyKey, history: { activeId: empty.id, records: [empty] }, valid: true };
    try {
      const saved = localStorage.getItem(historyKey);
      if (saved !== null) {
        const history = JSON.parse(saved);
        if (!object(history) || typeof history.activeId !== 'string' || !Array.isArray(history.records) || !history.records.length) throw new Error('Invalid meeting history');
        const records = history.records.map(parseMeetingRecord).map((record: MeetingRecord) => hasMeetingContent(record) ? { ...record, readOnly: true } : record);
        if (new Set(records.map(record => record.id)).size !== records.length || !records.some(record => record.id === history.activeId)) throw new Error('Invalid active meeting');
        store.history = { activeId: history.activeId, records };
      } else {
        const legacy = (key: string) => localStorage.getItem(key);
        const notes = JSON.parse(legacy(meetingStorageKeys.notes) || '[]');
        const rawStartedAt = legacy(meetingStorageKeys.startedAt);
        const report = legacy(meetingStorageKeys.report) || '';
        const record = parseMeetingRecord({ ...empty, notes, report, startedAt: rawStartedAt ? Number(rawStartedAt) : null,
          caseId: '', caseTitle: '', readOnly: notes.length > 0 || Boolean(report) });
        store.history = { activeId: record.id, records: [record] };
      }
    } catch { store.valid = false; store.history.records[0].readOnly = true; }
    return store;
  };
  const storeRef = useRef<MeetingStore | null>(null);
  if (!storeRef.current || storeRef.current.scope !== meetingPreferenceScopeKey || storeRef.current.key !== historyKey) storeRef.current = loadHistory();
  const [, renderHistory] = useState(0);
  const currentRecord = storeRef.current.history.records.find(record => record.id === storeRef.current!.history.activeId)!;
  const meetingNotes = currentRecord.notes, meetingReport = currentRecord.report, meetingStartedAt = currentRecord.startedAt;
  const meetingCaseId = currentRecord.caseId;
  const meetingArchiveReceipt = currentRecord.archiveReceipt || null;
  const meetingRecordId = currentRecord.id, meetingHistoryReadOnly = currentRecord.readOnly || !storeRef.current.valid;
  const meetingHistory = storeRef.current.history.records.filter(record => record.id === meetingRecordId || hasMeetingContent(record));
  const [meetingNotesOpen, setMeetingNotesOpen] = useState(false);
  const [meetingPaused, setMeetingPaused] = useState(true);
  const [meetingSpeakerCount, setMeetingSpeakerCount] = useState(0);
  const [meetingReportGenerating, setMeetingReportGenerating] = useState(false);
  const [caseCaption, setCaseCaption] = useState({ scope: meetingPreferenceScopeKey, title: currentRecord.caseTitle });
  const legalMeetingCaseTitle = caseCaption.scope === meetingPreferenceScopeKey ? caseCaption.title : currentRecord.caseTitle;
  const caseCaptionRef = useRef({ scope: meetingPreferenceScopeKey, title: currentRecord.caseTitle });
  if (caseCaptionRef.current.scope !== meetingPreferenceScopeKey) caseCaptionRef.current = { scope: meetingPreferenceScopeKey, title: currentRecord.caseTitle };
  const setLegalMeetingCaseTitleState = useCallback((title: string) => {
    caseCaptionRef.current = { scope: meetingPreferenceScopeKey, title };
    setCaseCaption({ scope: meetingPreferenceScopeKey, title });
  }, [meetingPreferenceScopeKey]);
  const meetingIdentityRef = useRef<{ scope: string; meetingId: string; refinementId: string }>({ scope: meetingPreferenceScopeKey, meetingId: crypto.randomUUID(), refinementId: '' });
  const meetingRefinementCancelRef = useRef<(() => void) | null>(null);
  const meetingCaptureResetRef = useRef<((previousMeetingId: string) => void) | null>(null);
  const meetingModeRef = useRef(operationMode === 'meeting');
  const meetingPausedRef = useRef(meetingPaused);
  const meetingVoiceActiveRef = useRef(false);
  const lastMeetingTranscriptRef = useRef<{ text: string; at: number; speakerKey: string }>({ text: '', at: 0, speakerKey: '' });
  const lastLegalMeetingArchiveRef = useRef('');
  const storageFailed = useCallback(() => {
    meetingPausedRef.current = true; setMeetingPaused(true);
    toast.error(desktopWorkflowCopy(lang).legalMeeting.storageFailed);
  }, [lang]);
  const commitHistory = useCallback((history: MeetingHistory, requireSaved = false): boolean => {
    const current = storeRef.current!;
    if (current.scope !== meetingPreferenceScopeKey || current.key !== historyKey) return false;
    let saved = false;
    try {
      if (!current.valid) throw new Error('Existing meeting history is unreadable');
      localStorage.setItem(historyKey, JSON.stringify(history)); saved = true;
    } catch { storageFailed(); }
    if (!saved && requireSaved) return false;
    storeRef.current = { ...current, history };
    renderHistory(value => value + 1);
    return saved;
  }, [historyKey, meetingPreferenceScopeKey, storageFailed]);
  const updateCurrent = useCallback((update: (record: MeetingRecord) => MeetingRecord) => {
    const current = storeRef.current!;
    if (current.scope !== meetingPreferenceScopeKey || current.key !== historyKey) return;
    const record = current.history.records.find(item => item.id === current.history.activeId)!;
    if (record.id !== meetingRecordId || record.readOnly) return;
    const next = update(record);
    if (next === record) return;
    commitHistory({ ...current.history, records: current.history.records.map(item => item.id === record.id ? next : item) });
  }, [commitHistory, historyKey, meetingPreferenceScopeKey, meetingRecordId]);
  const setMeetingNotes: Dispatch<SetStateAction<MeetingNote[]>> = useCallback(action => {
    updateCurrent(record => {
      const notes = typeof action === 'function' ? action(record.notes) : action;
      if (JSON.stringify(notes) === JSON.stringify(record.notes)) return record;
      return { ...record, notes, report: '', archiveReceipt: undefined, startedAt: record.startedAt ?? notes[0]?.time ?? null };
    });
  }, [updateCurrent]);
  const setMeetingReport: Dispatch<SetStateAction<string>> = useCallback(action => {
    updateCurrent(record => {
      const report = typeof action === 'function' ? action(record.report) : action;
      return report === record.report ? record : { ...record, report, archiveReceipt: undefined };
    });
  }, [updateCurrent]);
  const setMeetingStartedAt: Dispatch<SetStateAction<number | null>> = useCallback(action => {
    updateCurrent(record => ({ ...record, startedAt: typeof action === 'function' ? action(record.startedAt) : action }));
  }, [updateCurrent]);
  const setLegalMeetingCaseTitle: Dispatch<SetStateAction<string>> = useCallback(action => {
    if (storeRef.current!.scope !== meetingPreferenceScopeKey || storeRef.current!.history.activeId !== meetingRecordId) return;
    const title = typeof action === 'function' ? action(caseCaptionRef.current.title) : action;
    setLegalMeetingCaseTitleState(title);
    if (title) updateCurrent(record => ({ ...record, caseTitle: title, caseId: record.caseId }));
  }, [meetingPreferenceScopeKey, meetingRecordId, setLegalMeetingCaseTitleState, updateCurrent]);
  const renewMeetingIdentity = useCallback(() => {
    const previousMeetingId = meetingIdentityRef.current.meetingId;
    meetingRefinementCancelRef.current?.();
    meetingIdentityRef.current = { scope: meetingPreferenceScopeKey, meetingId: crypto.randomUUID(), refinementId: '' };
    setMeetingReportGenerating(false);
    meetingCaptureResetRef.current?.(previousMeetingId);
  }, [meetingPreferenceScopeKey]);
  // Fence old callbacks before effects load the next scope.
  if (meetingIdentityRef.current.scope !== meetingPreferenceScopeKey) {
    meetingIdentityRef.current = { scope: meetingPreferenceScopeKey, meetingId: crypto.randomUUID(), refinementId: '' };
  }
  useEffect(() => () => {
    meetingIdentityRef.current = { ...meetingIdentityRef.current, refinementId: '' };
    meetingRefinementCancelRef.current?.();
  }, [meetingPreferenceScopeKey]);
  useEffect(() => {
    meetingPausedRef.current = true; setMeetingPaused(true);
    setMeetingSpeakerCount(new Set(currentRecord.notes.map(note => note.speakerLabel).filter(Boolean)).size);
    setLegalMeetingCaseTitleState(currentRecord.caseTitle);
    lastMeetingTranscriptRef.current = { text: '', at: 0, speakerKey: '' };
    lastLegalMeetingArchiveRef.current = '';
    if (!storeRef.current!.valid) storageFailed();
  }, [meetingPreferenceScopeKey, meetingRecordId, storageFailed]);
  useEffect(() => { meetingModeRef.current = operationMode === 'meeting'; }, [operationMode]);
  useEffect(() => { meetingPausedRef.current = meetingPaused; }, [meetingPaused]);
  const finishSelection = useCallback((record: MeetingRecord) => {
    renewMeetingIdentity();
    meetingPausedRef.current = true; setMeetingPaused(true);
    setMeetingSpeakerCount(new Set(record.notes.map(note => note.speakerLabel).filter(Boolean)).size);
    setLegalMeetingCaseTitleState(record.caseTitle);
    lastMeetingTranscriptRef.current = { text: '', at: 0, speakerKey: '' }; lastLegalMeetingArchiveRef.current = '';
  }, [renewMeetingIdentity, setLegalMeetingCaseTitleState]);
  const bindMeetingCase = useCallback((caseId: string, caseTitle: string): boolean => {
    const current = storeRef.current!;
    if (current.scope !== meetingPreferenceScopeKey || current.history.activeId !== meetingRecordId) return false;
    const record = current.history.records.find(item => item.id === meetingRecordId)!;
    if (record.readOnly || !caseId || (record.caseId && record.caseId !== caseId)) return false;
    const next = { ...record, caseId, caseTitle: caseTitle || record.caseTitle };
    if (!commitHistory({ ...current.history, records: current.history.records.map(item => item.id === record.id ? next : item) }, true)) return false;
    setLegalMeetingCaseTitleState(next.caseTitle); return true;
  }, [commitHistory, meetingPreferenceScopeKey, meetingRecordId, setLegalMeetingCaseTitleState]);
  const recordMeetingArchive = useCallback((caseId: string, caseTitle: string, expected: Pick<MeetingRecord, 'notes' | 'report'>): boolean => {
    const current = storeRef.current!;
    if (current.scope !== meetingPreferenceScopeKey || current.key !== historyKey || current.history.activeId !== meetingRecordId) return false;
    const record = current.history.records.find(item => item.id === meetingRecordId)!;
    if (!caseId || !caseTitle || !expected || record.notes !== expected.notes || record.report !== expected.report || (record.caseId && record.caseId !== caseId)) return false;
    const next = { ...record, caseId, caseTitle, archiveReceipt: { caseId, at: Date.now() } };
    if (!commitHistory({ ...current.history, records: current.history.records.map(item => item.id === record.id ? next : item) }, true)) return false;
    setLegalMeetingCaseTitleState(caseTitle); return true;
  }, [commitHistory, historyKey, meetingPreferenceScopeKey, meetingRecordId, setLegalMeetingCaseTitleState]);
  const createMeetingRecord = useCallback((caseInput?: { id: string; title: string }): boolean => {
    const current = storeRef.current!;
    if (current.scope !== meetingPreferenceScopeKey) return false;
    if (caseInput && (!caseInput.id || !caseInput.title)) return false;
    const record = { ...emptyMeetingRecord(), ...(caseInput ? { caseId: caseInput.id, caseTitle: caseInput.title } : {}) };
    const records = current.history.records.filter(hasMeetingContent).map(item => item.id === current.history.activeId ? { ...item, readOnly: true } : item);
    if (!commitHistory({ activeId: record.id, records: [...records, record] }, true)) return false;
    finishSelection(record); return true;
  }, [commitHistory, finishSelection, meetingPreferenceScopeKey]);
  const selectMeetingRecord = useCallback((id: string): boolean => {
    const current = storeRef.current!;
    if (current.scope !== meetingPreferenceScopeKey) return false;
    const target = current.history.records.find(item => item.id === id);
    if (!target) return false;
    const selected = { ...target, readOnly: true };
    const records = current.history.records.filter(item => item.id === id || hasMeetingContent(item))
      .map(item => item.id === id ? selected : item.id === current.history.activeId ? { ...item, readOnly: true } : item);
    if (!commitHistory({ activeId: id, records }, true)) return false;
    finishSelection(selected); return true;
  }, [commitHistory, finishSelection, meetingPreferenceScopeKey]);
  const importMeetingRecords = useCallback((text: string): boolean => {
    const current = storeRef.current!;
    if (current.scope !== meetingPreferenceScopeKey) return false;
    try {
      const value = JSON.parse(text);
      if (!object(value) || value.scope !== meetingPreferenceScopeKey || !Array.isArray(value.records)) throw new Error('Invalid meeting import scope');
      const records = new Map(current.history.records.map(record => [record.id, record]));
      for (const raw of value.records) {
        const record = { ...parseMeetingRecord(object(raw) ? { ...raw, archiveReceipt: undefined } : raw), readOnly: true };
        if (!records.has(record.id)) records.set(record.id, record);
      }
      return commitHistory({ activeId: current.history.activeId, records: [...records.values()] }, true);
    } catch { storageFailed(); return false; }
  }, [commitHistory, meetingPreferenceScopeKey, storageFailed]);

  const meetingSpeakerLabel = useCallback((note: Pick<MeetingNote, 'speakerLabel' | 'speakerMatched'>) => {
    if (note.speakerLabel) return note.speakerLabel;
    return uiMessage('desktop-ui.unknown-speaker.6e99efa536', (lang === 'zh') ? 'zh' : 'en');
  }, [lang]);

  const meetingNoteHasSpeakerInfo = useCallback((note: MeetingNote) => (
    note.speakerMatched !== undefined ||
    typeof note.speakerConfidence === 'number' ||
    Boolean(note.speakerLabel)
  ), []);

  const formatMeetingNoteForExport = useCallback((note: MeetingNote) => {
    const speaker = meetingNoteHasSpeakerInfo(note) ? `${meetingSpeakerLabel(note)}: ` : '';
    return `${speaker}${note.text}`;
  }, [meetingNoteHasSpeakerInfo, meetingSpeakerLabel]);

  const appendMeetingTranscript = useCallback((text: string, isFinal: boolean, meta?: VoiceTranscriptMeta) => {
    if (!meetingModeRef.current || meetingPausedRef.current || !isFinal) return;
    const clean = text.trim();
    if (!clean) return;
    const now = Date.now();
    const speakerConfidence = typeof meta?.speakerConfidence === 'number' ? meta.speakerConfidence : undefined;
    const speakerMatched = meta?.speakerMatched === true && Boolean(meta.speakerLabel);
    const speakerLabel = String(meta?.speakerLabel || '').trim() || null;
    const speakerKey = speakerLabel || (speakerMatched ? 'matched' : 'unknown');
    if (
      lastMeetingTranscriptRef.current.text === clean &&
      lastMeetingTranscriptRef.current.speakerKey === speakerKey &&
      now - lastMeetingTranscriptRef.current.at < 4000
    ) return;
    lastMeetingTranscriptRef.current = { text: clean, at: now, speakerKey };
    setMeetingNotes(prev => {
      const next = [...prev, {
        id: `${now}-${Math.random().toString(36).slice(2, 8)}`,
        text: clean,
        time: now,
        speakerLabel,
        speakerConfidence,
        speakerSource: meta?.speakerSource,
        speakerMatched,
      }];
      return next;
    });
  }, [setMeetingNotes]);
  const applyRefinedMeetingTranscript = useCallback((data: { meetingId?: string; refinementId?: string; text?: string; provider?: string; model?: string; durationMs?: number; startedAt?: number; segments?: RefinedMeetingSegment[]; speakerCount?: number }) => {
    const identity = meetingIdentityRef.current;
    if (identity.scope !== meetingPreferenceScopeKey || data.meetingId !== identity.meetingId || data.refinementId !== identity.refinementId) return null;
    const clean = String(data.text || '').trim();
    if (!clean) return null;
    const now = Date.now();
    const startedAt = data.startedAt || meetingStartedAt || now;
    const speakerSource = data.provider ? `${data.provider}/${data.model || ''}` : 'dashscope';
    const segments = Array.isArray(data.segments) ? data.segments : [];
    const nextFromSegments = segments
      .map((segment, index): MeetingNote | null => {
        const text = String(segment?.text || '').trim();
        if (!text) return null;
        const numericSpeaker = typeof segment.speakerId === 'number' ? segment.speakerId : null;
        const speakerLabel = String(segment.speakerLabel || (numericSpeaker !== null ? `\u8bf4\u8bdd\u4eba${numericSpeaker + 1}` : '')).trim();
        return {
          id: `refined-${now}-${index}-${Math.random().toString(36).slice(2, 8)}`,
          text,
          time: startedAt + Math.max(0, Number(segment.beginMs || 0)),
          speakerLabel: speakerLabel || null,
          speakerSource,
          speakerMatched: false,
        };
      })
      .filter((note): note is MeetingNote => Boolean(note));
    const next: MeetingNote[] = nextFromSegments.length > 0 ? nextFromSegments : [{
      id: `refined-${now}-${Math.random().toString(36).slice(2, 8)}`,
      text: clean,
      time: startedAt,
      speakerSource,
    }];
    setMeetingNotes(next);
    const separatedSpeakerCount = Number(data.speakerCount) || new Set(
      next.map(note => note.speakerLabel).filter(Boolean),
    ).size;
    setMeetingSpeakerCount(separatedSpeakerCount);
    toast.success(uiMessage('desktop-ui.meeting-transcript-refined-with-the.0e4e859506', (lang === 'zh') ? 'zh' : 'en'));
    return next;
  }, [lang, meetingStartedAt, meetingPreferenceScopeKey, setMeetingNotes]);

  const waitForMeetingRefinement = useCallback((identity: { scope: string; meetingId: string; refinementId: string }) => new Promise<MeetingNote[] | null>((resolve) => {
    if (!socket?.connected) { resolve(null); return; }
    meetingRefinementCancelRef.current?.();
    let settled = false;
    const isCurrent = () => meetingIdentityRef.current === identity;
    const matches = (data?: { meetingId?: string; refinementId?: string }) => data?.meetingId === identity.meetingId && data.refinementId === identity.refinementId;
    const cleanup = () => {
      socket.off('meeting:refined_transcript', onRefined);
      socket.off('meeting:refine_error', onError);
      socket.off('meeting:refine_status', onStatus);
      socket.off('audio:error', onAudioError);
      window.removeEventListener('lumi:domain-changed', onDomainChanged);
      window.clearTimeout(timeout);
      if (meetingRefinementCancelRef.current === cancel) meetingRefinementCancelRef.current = null;
    };
    const finish = (value: MeetingNote[] | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const cancel = () => finish(null);
    const onStatus = (data?: { meetingId?: string; refinementId?: string; message?: string }) => {
      if (!matches(data) || !isCurrent()) return;
      toast.info(data?.message || uiMessage('desktop-ui.refining-the-meeting-recording-with.1e8a392145', lang === 'zh' ? 'zh' : 'en'));
    };
    const onRefined = (data: Parameters<typeof applyRefinedMeetingTranscript>[0]) => {
      if (!matches(data)) return;
      finish(isCurrent() ? applyRefinedMeetingTranscript(data) : null);
    };
    const onError = (data: { meetingId?: string; refinementId?: string; message?: string; reason?: string }) => {
      if (!matches(data)) return;
      if (data.reason === 'authorization_revoked' && isCurrent()) {
        meetingIdentityRef.current = { ...identity, refinementId: '' };
        setMeetingReportGenerating(false);
      }
      if (isCurrent()) toast.error(data.message || uiMessage('desktop-ui.high-accuracy-meeting-transcription-failed.06ae217f12', lang === 'zh' ? 'zh' : 'en'));
      finish(null);
    };
    const onAudioError = (data?: { code?: string }) => {
      if (data?.code !== 'ORGANIZATION_ACCESS_CHANGED' || !isCurrent()) return;
      meetingIdentityRef.current = { ...identity, refinementId: '' };
      setMeetingReportGenerating(false);
      cancel();
    };
    const onDomainChanged = () => {
      if (isCurrent()) {
        meetingIdentityRef.current = { ...identity, refinementId: '' };
        setMeetingReportGenerating(false);
      }
      cancel();
    };
    const timeout = window.setTimeout(() => {
      if (isCurrent()) toast.error(uiMessage('desktop-ui.high-accuracy-meeting-transcription-timed.4ade09a115', lang === 'zh' ? 'zh' : 'en'));
      finish(null);
    }, 60 * 60 * 1000);
    socket.on('meeting:refined_transcript', onRefined);
    socket.on('meeting:refine_error', onError);
    socket.on('meeting:refine_status', onStatus);
    socket.on('audio:error', onAudioError);
    window.addEventListener('lumi:domain-changed', onDomainChanged, { once: true });
    meetingRefinementCancelRef.current = cancel;
  }), [applyRefinedMeetingTranscript, lang, socket]);
return { appendMeetingTranscript, meetingCaptureResetRef, meetingVoiceActiveRef, setMeetingPaused, meetingIdentityRef, meetingPaused, setMeetingStartedAt, meetingStartedAt, legalMeetingCaseTitle, meetingReport, meetingNotes, formatMeetingNoteForExport, setMeetingReport, setMeetingReportGenerating, lastLegalMeetingArchiveRef, setLegalMeetingCaseTitle, waitForMeetingRefinement, setMeetingNotesOpen, renewMeetingIdentity, setMeetingNotes, setMeetingSpeakerCount, lastMeetingTranscriptRef, meetingHistory, meetingRecordId, meetingCaseId, meetingArchiveReceipt, recordMeetingArchive, bindMeetingCase, meetingHistoryReadOnly, createMeetingRecord, selectMeetingRecord, importMeetingRecords, meetingModeRef, meetingNotesOpen, meetingReportGenerating, meetingSpeakerCount, meetingNoteHasSpeakerInfo, meetingSpeakerLabel };
}
