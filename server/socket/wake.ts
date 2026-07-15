import { Socket } from "socket.io";
import { createWakeDetector, isWakeWord } from "../stt/wake_detector";
import { isEchoText, isTtsPlaying } from "./voice";
import { logger } from "../../logger";

type WakeDetector = ReturnType<typeof createWakeDetector>;

interface ActiveWakeOwner {
  socketId: string;
  detector: WakeDetector;
}

// A desktop session can expose more than one webview/socket. Only one of them
// may own a paid realtime wake stream for a user at a time.
const wakeOwnerByUser = new Map<string, ActiveWakeOwner>();

export function registerWakeHandlers(socket: Socket, getUserId: (s: Socket) => string) {
  let wakeDetector: WakeDetector | null = null;
  let wakeStarting = false;

  const releaseOwnedDetector = (stop = true) => {
    const uid = getUserId(socket);
    const detector = wakeDetector;
    wakeDetector = null;
    const owner = wakeOwnerByUser.get(uid);
    if (owner?.socketId === socket.id && (!detector || owner.detector === detector)) {
      wakeOwnerByUser.delete(uid);
    }
    if (stop && detector) {
      try { detector.stop(); } catch {}
    }
  };

  socket.on("wake:start", async () => {
    const uid = getUserId(socket);
    try {
      const registeredOwner = wakeOwnerByUser.get(uid);
      if (wakeDetector && registeredOwner?.detector !== wakeDetector) {
        try { wakeDetector.stop(); } catch {}
        wakeDetector = null;
      }
      if (wakeDetector || wakeStarting) {
        socket.emit("wake:started", { reused: true });
        return;
      }
      const existingOwner = wakeOwnerByUser.get(uid);
      if (existingOwner && existingOwner.socketId !== socket.id) {
        logger.info(`[Wake] Socket ${socket.id} taking ownership from ${existingOwner.socketId} for user ${uid}`);
        wakeOwnerByUser.delete(uid);
        try { existingOwner.detector.stop(); } catch {}
      }
      wakeStarting = true;
      const detector = createWakeDetector(undefined, isEchoText);
      wakeDetector = detector;
      wakeOwnerByUser.set(uid, { socketId: socket.id, detector });

      detector.onWake((keyword: string) => {
        if (wakeDetector !== detector || wakeOwnerByUser.get(uid)?.detector !== detector) return;
        logger.info(`[Wake] "${keyword}" detected for user ${uid}`);
        socket.emit("wake:detected", { keyword, timestamp: new Date().toISOString() });
      });

      detector.onError((err: Error) => {
        if (wakeDetector !== detector || wakeOwnerByUser.get(uid)?.detector !== detector) return;
        logger.error(`[Wake] Error for user ${uid}:`, err.message);
        socket.emit("wake:error", { message: err.message });
        releaseOwnedDetector(true);
      });

      socket.emit("wake:started");
      logger.info(`[Wake] Started for user ${uid}`);
    } catch (err: any) {
      releaseOwnedDetector(true);
      socket.emit("wake:error", { message: err.message || 'Failed to start wake detector' });
    } finally {
      wakeStarting = false;
    }
  });

  socket.on("wake:audio", (data: { audio?: number[] } | Buffer | ArrayBuffer | Uint8Array) => {
    if (!wakeDetector) return;
    if (isTtsPlaying()) return;
    try {
      let buf: Buffer;
      if (Buffer.isBuffer(data)) {
        buf = data;
      } else if (data instanceof ArrayBuffer) {
        buf = Buffer.from(data);
      } else if (ArrayBuffer.isView(data)) {
        buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
      } else {
        buf = Buffer.from(new Int16Array(data.audio || []).buffer);
      }
      wakeDetector.sendAudio(buf);
    } catch {}
  });

  socket.on("wake:stop", () => {
    releaseOwnedDetector(true);
  });

  socket.on("disconnect", () => {
    releaseOwnedDetector(true);
  });
}
