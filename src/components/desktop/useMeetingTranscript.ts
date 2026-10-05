

import { type MeetingNote, type RefinedMeetingSegment } from "./runtime_state";

import { useState, useEffect, useCallback, useRef } from 'react';

import { toast } from 'sonner';

import { useSocket } from '@/hooks/useSocket';

import { type VoiceTranscriptMeta } from '@/hooks/useVoiceCall';
import { type OperationMode } from '@/contexts/AppContext';

import { getLegalCaseLabel, getLegalConsultationCase } from '@/lib/legalCaseStore';

import { uiMessage } from "../../i18n/uiMessages";

type useMeetingTranscriptInput = {
workDomain: "personal" | "work";
meetingStorageKeys: { identity: string; startedAt: string; notes: string; report: string; };
meetingPreferenceScopeKey: string;
operationMode: OperationMode;
lang: "en" | "zh";
socket: ReturnType<typeof useSocket>;
};
export function useMeetingTranscript({ workDomain, meetingStorageKeys, meetingPreferenceScopeKey, operationMode, lang, socket }: useMeetingTranscriptInput) {

  const readMeetingItem = useCallback((scopedKey: string, legacyKey: string): string | null => (
    localStorage.getItem(scopedKey)
      ?? (workDomain === 'personal' ? localStorage.getItem(legacyKey) : null)
  ), [workDomain]);
  const [meetingNotesOpen, setMeetingNotesOpen] = useState(false);
  const [meetingPaused, setMeetingPaused] = useState(false);
  const [meetingStartedAt, setMeetingStartedAt] = useState<number | null>(() => {
    const saved = readMeetingItem(meetingStorageKeys.startedAt, 'lumi_meeting_started_at');
    return saved ? Number(saved) || null : null;
  });
  const [meetingNotes, setMeetingNotes] = useState<MeetingNote[]>(() => {
    try { return JSON.parse(readMeetingItem(meetingStorageKeys.notes, 'lumi_meeting_notes') || '[]'); } catch { return []; }
  });
  const [meetingSpeakerCount, setMeetingSpeakerCount] = useState(0);
  const [meetingReport, setMeetingReport] = useState<string>(() => readMeetingItem(meetingStorageKeys.report, 'lumi_meeting_report') || '');
  const [meetingReportGenerating, setMeetingReportGenerating] = useState(false);
  const meetingIdentityRef = useRef({ scope: meetingPreferenceScopeKey, meetingId: localStorage.getItem(meetingStorageKeys.identity) || crypto.randomUUID(), refinementId: '' });
  const meetingRefinementCancelRef = useRef<(() => void) | null>(null);
  const meetingCaptureResetRef = useRef<((previousMeetingId: string) => void) | null>(null);
  const renewMeetingIdentity = useCallback(() => {
    const previousMeetingId = meetingIdentityRef.current.meetingId;
    meetingRefinementCancelRef.current?.();
    meetingIdentityRef.current = { scope: meetingPreferenceScopeKey, meetingId: crypto.randomUUID(), refinementId: '' };
    localStorage.setItem(meetingStorageKeys.identity, meetingIdentityRef.current.meetingId);
    setMeetingReportGenerating(false);
    meetingCaptureResetRef.current?.(previousMeetingId);
  }, [meetingPreferenceScopeKey, meetingStorageKeys.identity]);
  // Fence callbacks immediately on a scope render, before effect cleanup runs.
  if (meetingIdentityRef.current.scope !== meetingPreferenceScopeKey) {
    meetingIdentityRef.current = { scope: meetingPreferenceScopeKey, meetingId: localStorage.getItem(meetingStorageKeys.identity) || crypto.randomUUID(), refinementId: '' };
  }
  useEffect(() => { localStorage.setItem(meetingStorageKeys.identity, meetingIdentityRef.current.meetingId); }, [meetingStorageKeys.identity]);
  useEffect(() => () => {
    meetingIdentityRef.current = { ...meetingIdentityRef.current, refinementId: '' };
    meetingRefinementCancelRef.current?.();
  }, [meetingPreferenceScopeKey]);

  const [legalMeetingCaseTitle, setLegalMeetingCaseTitle] = useState(() => getLegalCaseLabel(getLegalConsultationCase()));
  const meetingModeRef = useRef(operationMode === 'meeting');
  const meetingPausedRef = useRef(meetingPaused);
  const meetingVoiceActiveRef = useRef(false);
  const lastMeetingTranscriptRef = useRef<{ text: string; at: number; speakerKey: string }>({ text: '', at: 0, speakerKey: '' });
  const lastLegalMeetingArchiveRef = useRef('');
  useEffect(() => {
    const savedStartedAt = readMeetingItem(meetingStorageKeys.startedAt, 'lumi_meeting_started_at');
    let savedNotes: MeetingNote[] = [];
    try {
      const parsed = JSON.parse(readMeetingItem(meetingStorageKeys.notes, 'lumi_meeting_notes') || '[]');
      savedNotes = Array.isArray(parsed) ? parsed : [];
    } catch {}
    setMeetingPaused(false);
    setMeetingStartedAt(savedStartedAt ? Number(savedStartedAt) || null : null);
    setMeetingNotes(savedNotes);
    setMeetingSpeakerCount(new Set(savedNotes.map(note => note.speakerLabel).filter(Boolean)).size);
    setMeetingReport(readMeetingItem(meetingStorageKeys.report, 'lumi_meeting_report') || '');
    setLegalMeetingCaseTitle(workDomain === 'personal' ? getLegalCaseLabel(getLegalConsultationCase()) : '');
    lastMeetingTranscriptRef.current = { text: '', at: 0, speakerKey: '' };
    lastLegalMeetingArchiveRef.current = '';
  }, [
    meetingPreferenceScopeKey,
    meetingStorageKeys.notes,
    meetingStorageKeys.report,
    meetingStorageKeys.startedAt,
    readMeetingItem,
    workDomain,
  ]);
  useEffect(() => {
    meetingModeRef.current = operationMode === 'meeting';
  }, [operationMode]);
  useEffect(() => {
    meetingPausedRef.current = meetingPaused;
  }, [meetingPaused]);

  const persistMeetingNotes = useCallback((notes: MeetingNote[]) => {
    localStorage.setItem(meetingStorageKeys.notes, JSON.stringify(notes.slice(-300)));
  }, [meetingStorageKeys.notes]);

  const resetMeetingCapture = useCallback((startedAt = Date.now()) => {
    renewMeetingIdentity();
    setMeetingPaused(false);
    setMeetingNotes([]);
    setMeetingSpeakerCount(0);
    setMeetingReport('');
    setMeetingStartedAt(startedAt);
    localStorage.setItem(meetingStorageKeys.notes, '[]');
    localStorage.removeItem(meetingStorageKeys.report);
    localStorage.setItem(meetingStorageKeys.startedAt, String(startedAt));
    lastMeetingTranscriptRef.current = { text: '', at: 0, speakerKey: '' };
  }, [meetingStorageKeys, renewMeetingIdentity]);

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
    setMeetingReport('');
    localStorage.removeItem(meetingStorageKeys.report);
    setMeetingStartedAt(prev => {
      if (prev) return prev;
      localStorage.setItem(meetingStorageKeys.startedAt, String(now));
      return now;
    });
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
      persistMeetingNotes(next);
      return next;
    });
  }, [meetingStorageKeys.report, meetingStorageKeys.startedAt, persistMeetingNotes]);
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
    persistMeetingNotes(next);
    setMeetingReport('');
    localStorage.removeItem(meetingStorageKeys.report);
    toast.success(uiMessage('desktop-ui.meeting-transcript-refined-with-the.0e4e859506', (lang === 'zh') ? 'zh' : 'en'));
    return next;
  }, [lang, meetingStartedAt, meetingStorageKeys.report, meetingPreferenceScopeKey, persistMeetingNotes]);

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
return { appendMeetingTranscript, meetingCaptureResetRef, meetingVoiceActiveRef, setMeetingPaused, meetingIdentityRef, meetingPaused, setMeetingStartedAt, meetingStartedAt, legalMeetingCaseTitle, meetingReport, meetingNotes, formatMeetingNoteForExport, setMeetingReport, setMeetingReportGenerating, lastLegalMeetingArchiveRef, setLegalMeetingCaseTitle, waitForMeetingRefinement, setMeetingNotesOpen, renewMeetingIdentity, setMeetingNotes, setMeetingSpeakerCount, lastMeetingTranscriptRef, resetMeetingCapture, meetingModeRef, meetingNotesOpen, meetingReportGenerating, meetingSpeakerCount, meetingNoteHasSpeakerInfo, meetingSpeakerLabel };
}
