/** One microphone owner across Lumi, meetings and private avatar calls. */
let owner: { token: symbol; stop: () => void } | null = null;
const listeners = new Set<() => void>();

export function hasVoiceCapture(): boolean { return owner !== null; }
export function subscribeVoiceCapture(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function claimVoiceCapture(token: symbol, stop: () => void): void {
  if (owner?.token === token) return;
  const previous = owner;
  owner = { token, stop };
  previous?.stop();
  for (const listener of listeners) listener();
}

export function releaseVoiceCapture(token: symbol): void {
  if (owner?.token === token) {
    owner = null;
    for (const listener of listeners) listener();
  }
}
