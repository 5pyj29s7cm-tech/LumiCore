import type { Server, Socket } from 'socket.io';
import { readDB } from '../../db_layer';
import { syncRuntimeScene } from '../scene/runtime_scene';
import { resolveSocketScope } from './scope';

export function registerSceneHandlers(
  socket: Socket,
  userIdFn: (socket: Socket) => string,
  _io: Server,
): void {
  const respond = (
    data: { currentRevision?: number; currentDigest?: string } = {},
    ack?: (payload: any) => void,
    forceSnapshot = false,
  ) => {
    const userId = userIdFn(socket);
    const scope = resolveSocketScope(socket, userId);
    try {
      const payload = syncRuntimeScene(readDB(), {
        userId,
        domain: scope.domain,
        orgId: scope.orgId,
        currentRevision: data.currentRevision,
        currentDigest: String(data.currentDigest || ''),
        forceSnapshot,
      });
      ack?.({ ok: true, ...payload });
    } catch (error: any) {
      ack?.({ ok: false, error: String(error?.message || error || 'scene_sync_failed') });
    }
  };

  socket.on('scene:sync', (data = {}, ack?: (payload: any) => void) => respond(data, ack, false));
  socket.on('scene:resync', (data = {}, ack?: (payload: any) => void) => respond(data, ack, true));
}
