import { Socket } from "socket.io";
import { createWakeDetector, isWakeWord } from "../stt/wake_detector";
import { isEchoText, isTtsPlaying } from "./voice";
import { logger } from "../../logger";

export function registerWakeHandlers(socket: Socket, getUserId: (s: Socket) => string) {
  let wakeDetector: ReturnType<typeof createWakeDetector> | null = null;
  let wakeStarting = false;

  socket.on("wake:start", async () => {
    const uid = getUserId(socket);
    try {
      if (wakeDetector || wakeStarting) {
        socket.emit("wake:started", { reused: true });
        return;
      }
      wakeStarting = true;
      wakeDetector = createWakeDetector(undefined, isEchoText);

      wakeDetector.onWake((keyword: string) => {
        logger.info(`[Wake] "${keyword}" detected for user ${uid}`);
        socket.emit("wake:detected", { keyword, timestamp: new Date().toISOString() });
      });

      wakeDetector.onError((err: Error) => {
        logger.error(`[Wake] Error for user ${uid}:`, err.message);
        socket.emit("wake:error", { message: err.message });
        if (wakeDetector) {
          try { wakeDetector.stop(); } catch {}
          wakeDetector = null;
        }
      });

      socket.emit("wake:started");
      logger.info(`[Wake] Started for user ${uid}`);
    } catch (err: any) {
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
    if (wakeDetector) {
      try { wakeDetector.stop(); } catch {}
      wakeDetector = null;
    }
  });

  socket.on("disconnect", () => {
    if (wakeDetector) {
      try { wakeDetector.stop(); } catch {}
      wakeDetector = null;
    }
  });
}
