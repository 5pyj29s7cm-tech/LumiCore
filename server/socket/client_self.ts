import { Server, Socket } from 'socket.io';
import { updateClientState, ClientStateSnapshot } from '../client/self_model';
import { disconnectClientState } from '../client/self/state';

export function registerClientSelfHandlers(
  socket: Socket,
  getUserId: (socket: Socket) => string,
  io: Server,
) {
  let reportedUserId: string | undefined;
  socket.on('disconnect', () => {
    if (reportedUserId) disconnectClientState(reportedUserId, socket.id);
  });
  socket.on('client:state', (state: ClientStateSnapshot) => {
    const uid = getUserId(socket);
    reportedUserId = uid;
    const snapshot = updateClientState(uid, {
      ...(state || {}),
      socketId: socket.id,
      connected: true,
    });
    socket.emit('client:state_ack', {
      updatedAt: snapshot.updatedAt,
      mode: snapshot.mode,
    });
  });
}
