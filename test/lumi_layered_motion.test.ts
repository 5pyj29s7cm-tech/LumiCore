import { expect, it } from 'vitest';
import { LumiLayeredMotion } from '../src/lib/lumiLayeredMotion';

it('retains audio articulation and closes the mouth after playback stops', () => {
  const face = new LumiLayeredMotion();
  let frame = face.step(0, 0, false);
  for (let i = 0; i < 90; i++) frame = face.step(1 / 60, .25, false);
  expect(frame.mouth).toBeGreaterThan(.4);
  for (let i = 0; i < 90; i++) frame = face.step(1 / 60, 0, false);
  expect(frame.mouth).toBe(0);
});

it('keeps blinking available and honors reduced motion without muting the mouth', () => {
  const face = new LumiLayeredMotion();
  let maximumBlink = 0;
  for (let i = 0; i < 480; i++) maximumBlink = Math.max(maximumBlink, face.step(1 / 60, 0, false).blink);
  expect(maximumBlink).toBeGreaterThan(.9);
  const reduced = face.step(1 / 60, .3, true);
  expect(reduced.blink).toBe(0);
  expect(reduced.mouth).toBeGreaterThan(0);
});
