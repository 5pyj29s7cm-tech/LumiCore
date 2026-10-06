import { type AudioSession, getAudioSession } from "../session";
import { logger } from "../../../../logger";
import { releasePausedMeetingRecording } from "../../meeting_recordings";
import { getMeetingAudioDir } from "../../../stt/artifact_paths";
import type { VoiceConnectionRuntime } from './connection';

export function registerVoiceConnectionCleanup(runtime: VoiceConnectionRuntime) {


  runtime.socket.on("audio:switch-personality", (data: { personalityId: string }) => {
    const session = getAudioSession(runtime.socket);
    if (session.isActive) {
      session.personalityId = data.personalityId;
      logger.info(`[Audio] Personality switched to ${data.personalityId} mid-call`);
    }
  });

  runtime.socket.on("disconnect", async () => {
    if (runtime.pendingStandardStart) runtime.pendingStandardStart.cancelled = true;
    runtime.pendingStandardStart = undefined;
    const pausedSession = getAudioSession(runtime.socket);
    if (pausedSession.userId && pausedSession.meetingId) {
      releasePausedMeetingRecording(getMeetingAudioDir({ userId: pausedSession.userId, domain: pausedSession.domain, orgId: pausedSession.orgId }), pausedSession.meetingId);
    }

    const session = runtime.socket.data.audioSession as AudioSession | undefined;
    if (session) {
      await runtime.stopVoiceCall(session, { source: 'voice_disconnected', publish: false });
    }
    console.log(`[Socket] Client disconnected: ${runtime.socket.id}`);
  });
}
