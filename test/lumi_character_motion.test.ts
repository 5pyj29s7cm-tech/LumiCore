import { expect, it } from 'vitest';
import { LumiCharacterMotion } from '../src/lib/lumiCharacterMotion';

it('does not invent mouth motion from speaking state, and closes promptly after interrupted audio', () => {
  const driver = new LumiCharacterMotion();
  for (let i = 0; i < 300; i++) expect(driver.step(1 / 60, 0, false, 'speaking').mouth).toBe(0);
  let frame = driver.step(1 / 60, 0.2, false);
  for (let i = 0; i < 60; i++) frame = driver.step(1 / 60, 0.2, false);
  expect(frame.mouth).toBeGreaterThan(0.4); expect(frame.gesture).toBeGreaterThan(0.3);
  for (let i = 0; i < 40; i++) frame = driver.step(1 / 60, 0, false, 'speaking');
  expect(frame.mouth).toBe(0); expect(frame.gesture).toBeLessThan(0.08);
});

it('bounds corrupt audio and pointer inputs without producing invalid bone transforms', () => {
  const driver = new LumiCharacterMotion();
  for (const invalid of [NaN, Infinity, -Infinity, -100, 100]) {
    const frame = driver.step(100, invalid, false, 'thinking', invalid, invalid);
    expect(Object.values(frame).every(Number.isFinite)).toBe(true);
    expect(frame.mouth).toBeGreaterThanOrEqual(0); expect(frame.mouth).toBeLessThanOrEqual(0.85);
  }
});

it('reduced motion stops body, gesture and blink motion while retaining audio articulation', () => {
  const driver = new LumiCharacterMotion();
  for (let i = 0; i < 60; i++) driver.step(1 / 60, 0.2, false, 'listening', 1, 1);
  const frame = driver.step(1 / 60, 0.2, true, 'listening', 1, 1);
  expect(frame).toMatchObject({ breath: 0, sway: 0, headX: 0, headY: 0, headZ: 0, gesture: 0, blink: 0 });
  expect(frame.mouth).toBeGreaterThan(0.4);
});
