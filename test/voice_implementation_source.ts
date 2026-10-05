import { readFileSync } from 'node:fs';
/** Read the complete production implementation after its responsibility split. */
export function readVoiceImplementationSource(): string {
  return ['voice_transport_runtime','voice_turn_policy','voice_side_response','voice_conversation_turn','voice_input_pipeline','voice']
    .map(name => readFileSync('server/socket/' + name + '.ts', 'utf8')).join('\n');
}
