import { Server, Socket } from 'socket.io';
import { updateClientState, ClientStateSnapshot } from '../client/self_model';

export function registerClientSelfHandlers(
  socket: Socket,
  getUserId: (socket: Socket) => string,
  io: Server,
) {
  socket.on('client:state', (state: ClientStateSnapshot) => {
    const uid = getUserId(socket);
    const snapshot = updateClientState(uid, {
      ...(state || {}),
      socketId: socket.id,
    });
    socket.emit('client:state_ack', {
      updatedAt: snapshot.updatedAt,
      mode: snapshot.mode,
    });
  });
}
