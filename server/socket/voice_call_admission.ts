/** A reservation precedes every await: a late start cannot steal a newer call. */
export function createVoiceCallAdmission() {
  let current: { token: symbol; lane: string; stop: () => Promise<void> } | null = null;
  return {
    hasCall: () => current !== null,
    claim(stop: () => Promise<void>, lane = 'avatar') {
      const previous = current;
      const reservation = { token: Symbol('voice-call'), lane, stop };
      current = reservation;
      const handle = {
        isCurrent: () => current === reservation,
        release: () => { if (current === reservation) current = null; },
      };
      // Standard Lumi already owns precise same-lane stop/start generations.
      // Keep that admission synchronous; only cross-lane handovers wait here.
      if (!previous || (lane === 'lumi' && previous.lane === 'lumi')) return handle;
      return previous.stop().then(() => handle, error => {
        if (current === reservation) current = null;
        throw error;
      });
    },
  };
}

export type VoiceCallAdmission = ReturnType<typeof createVoiceCallAdmission>;
