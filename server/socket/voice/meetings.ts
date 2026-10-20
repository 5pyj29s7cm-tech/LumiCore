import fs from "fs";
import { getMember } from "../../org/db";
import { beginMeetingCapture, type MeetingRecording, readMeetingPcm, removeMeetingRecordingFiles } from "../meeting_recordings";
import { getMeetingAudioDir } from "../../stt/artifact_paths";
import { Server, Socket } from "socket.io";
import { captureChatAuthorization } from "../chat_authorization";
import { transcribeAudioFile } from "../../stt/file_transcription";
import path from "path";
import { logger } from "../../../logger";
import { type AudioSession, normalizeVoiceSessionId } from "./session";
function writePcm16Wav(rawPath: string, wavPath: string, sampleRate = 16000): void {
  const pcm = fs.readFileSync(rawPath);
  const header = Buffer.alloc(44);
  const dataSize = pcm.length;
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);
  fs.writeFileSync(wavPath, Buffer.concat([header, pcm]));
}


export function meetingAuthorizationKey(userId: string, scope: { domain: string; orgId: string }): string {
  const member = scope.domain === 'work' ? getMember(scope.orgId, userId) : undefined;
  return JSON.stringify([userId, scope.domain, scope.orgId, member?.id || '', member?.role || '']);
}


export function startMeetingPcmRecording(session: AudioSession): void {
  const originalAuthorization = session.authorization;
  const capture = beginMeetingCapture(getMeetingAudioDir({ userId: session.userId, domain: session.domain, orgId: session.orgId }),
    session.meetingId || normalizeVoiceSessionId(session.sessionId), normalizeVoiceSessionId(session.sessionId), meetingAuthorizationKey(session.userId, session), () => originalAuthorization?.isCurrent() !== false);
  session.meetingCapture = capture;
  session.meetingPcmPath = capture.path;
  session.meetingPcmBytes = 0;
  session.meetingStartedAt = capture.recording.startedAt;
}


export async function refineMeetingTranscript(io: Server, socket: Socket, session: AudioSession, recording: MeetingRecording, refinementId: string): Promise<void> {
  const authorization = session.authorization || captureChatAuthorization(session.userId, session);
  const controller = new AbortController();
  const stopWatch = authorization.watch(controller);
  const identity = { meetingId: recording.meetingId, refinementId, sessionId: session.sessionId };
  const emit = (event: string, payload: any) => {
    if (!authorization.isCurrent()) return;
    const result = { ...payload, ...identity };
    if (socket.connected) socket.emit(event, result);
    else {
      const room = session.domain === 'work' && session.orgId
        ? `user:${session.userId}:org:${session.orgId}` : `user:${session.userId}:personal`;
      io.to(room).emit(event, result);
    }
  };
  const bytes = recording.segments.reduce((sum, segment) => sum + segment.bytes, 0);
  const rawPath = recording.segments[0]?.path;
  try {
    authorization.assertCurrent();
    if (!recording.isAuthorized()) throw new DOMException('Meeting authorization changed.', 'AbortError');
    if (bytes < 16000 || !rawPath) {
      emit('meeting:refine_error', { message: 'Meeting recording is too short for high-accuracy transcription.' });
      return;
    }
    const wavPath = rawPath.replace(/\.pcm$/i, '.wav');
    emit('meeting:refine_status', { status: 'transcribing', bytes });
    const pcm = readMeetingPcm(recording);
    // Only this detached recording owns these files. A resumed capture uses a new path.
    fs.writeFileSync(rawPath, pcm);
    writePcm16Wav(rawPath, wavPath);
    removeMeetingRecordingFiles(recording);
    const result = await transcribeAudioFile(fs.readFileSync(wavPath), {
      fileName: path.basename(wavPath), language: 'zh',
      allowLocal: true, signal: controller.signal,
      onProgress: message => emit('meeting:refine_status', { status: 'transcribing', bytes, message }),
    });
    authorization.assertCurrent();
    if (!recording.isAuthorized()) throw new DOMException('Meeting authorization changed.', 'AbortError');
    emit('meeting:refined_transcript', {
      text: result.text, provider: result.provider, model: result.model, segments: result.segments,
      speakerCount: result.speakerCount, taskId: result.taskId, durationMs: result.durationMs,
      audioPath: wavPath, startedAt: recording.startedAt,
    });
  } catch (err: any) {
    if (authorization.isCurrent()) {
      logger.error('[Meeting Refine Error]:', err);
      emit('meeting:refine_error', { message: err?.message || String(err) });
    } else if (socket.connected) {
      socket.emit('meeting:refine_error', { ...identity, reason: 'authorization_revoked', message: 'Organization access changed. Meeting refinement was cancelled.' });
    }
  } finally {
    stopWatch();
    removeMeetingRecordingFiles(recording);
  }
}
