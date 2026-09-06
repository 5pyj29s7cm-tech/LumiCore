/** One microphone owner across Lumi, meetings and private avatar calls. */
let owner: { token: symbol; stop: () => void } | null = null;

export function claimVoiceCapture(token: symbol, stop: () => void): void {
  if (owner?.token === token) return;
  const previous = owner;
  owner = { token, stop };
  previous?.stop();
}

export function releaseVoiceCapture(token: symbol): void {
  if (owner?.token === token) owner = null;
}
