import { readImplementationSource } from './implementation_source';
/** Read all live voice modules and unwrap their explicit turn-state accessors. */
export function readVoiceImplementationSource(): string {
  return readImplementationSource('server/socket/voice.ts', 'utf8');
}
