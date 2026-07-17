import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BACKGROUND_FACE_PRESENCE_ENABLED_KEY,
  isBackgroundFacePresenceEnabled,
} from '../src/services/sensorPermissionService';
import { samePresenceState } from '../src/hooks/usePresence';

function source(file: string) {
  return fs.readFileSync(path.join(process.cwd(), file), 'utf8');
}

describe('client runtime resource boundaries', () => {
  it('requires a dedicated background-presence opt-in', () => {
    const values = new Map<string, string>();
    const storage = {
      getItem(key: string) {
        return values.get(key) ?? null;
      },
    };

    expect(BACKGROUND_FACE_PRESENCE_ENABLED_KEY).toBe('lumi_background_face_presence_enabled');
    expect(isBackgroundFacePresenceEnabled(storage)).toBe(false);

    // General camera permission and enrollment do not grant permanent capture.
    values.set('lumi_camera_enabled', 'true');
    expect(isBackgroundFacePresenceEnabled(storage)).toBe(false);

    values.set(BACKGROUND_FACE_PRESENCE_ENABLED_KEY, 'true');
    expect(isBackgroundFacePresenceEnabled(storage)).toBe(true);
  });

  it('gates background recognition on opt-in, camera access, and enrolled templates', () => {
    const desktop = source('src/components/DesktopUI.tsx');
    const faceHook = source('src/hooks/useFaceRecognition.ts');
    const settings = source('src/components/Settings.tsx');

    expect(desktop).toContain('backgroundFaceRecognitionOptedIn &&');
    expect(desktop).toContain('cameraAccessEnabled &&');
    expect(desktop).toContain('enabled: facePresenceRequested && faceRecognition.hasTemplates');
    expect(desktop).not.toContain("enabled: sensorPrimerSeen && workDomain === 'personal'");
    expect(desktop).toContain('window.addEventListener(BACKGROUND_FACE_PRESENCE_CHANGED');
    expect(settings).toContain('setBackgroundFacePresenceEnabled(enabled)');
    expect(settings).toContain("settings.background-face-presence.c07ac0f5cb");
    expect(settings).toContain("if (enabled && camStatus !== 'granted')");
    expect(settings).toContain("await requestPermissions('camera')");

    const templatesIndex = faceHook.indexOf('const templates = await loadTemplates()');
    const acquireIndex = faceHook.indexOf('await mediaPipe.acquireFaceLandmarker()', templatesIndex);
    const cameraIndex = faceHook.indexOf('await requestCameraStream({', acquireIndex);
    expect(templatesIndex).toBeGreaterThan(-1);
    expect(acquireIndex).toBeGreaterThan(templatesIndex);
    expect(cameraIndex).toBeGreaterThan(acquireIndex);
    expect(faceHook).toContain('if (templates.length === 0) return');
  });

  it('uses low-frequency scheduling and closes every acquired face task', () => {
    const faceHook = source('src/hooks/useFaceRecognition.ts');
    const loader = source('src/lib/mediapipe/loader.ts');
    const mediaPipeInit = loader.slice(
      loader.indexOf('export async function initMediaPipe'),
      loader.indexOf('export type HandResult'),
    );

    expect(faceHook).not.toContain('requestAnimationFrame');
    expect(faceHook).toContain('window.setTimeout(runDetection');
    expect(faceHook).toContain('stopCameraStream(requestedStream)');
    expect(faceHook).toContain('releaseFaceLandmarker?.()');
    expect(loader).toContain('faceLandmarkerReferences += 1');
    expect(loader).toContain('faceLandmarkerReferences = Math.max(0, faceLandmarkerReferences - 1)');
    expect(loader).toContain('landmarker.close()');
    expect(mediaPipeInit).not.toContain('initFaceLandmarker');
  });

  it('does not publish duplicate presence state objects', () => {
    const current = { isAway: false, status: 'present' as const };
    expect(samePresenceState(current, { ...current })).toBe(true);
    expect(samePresenceState(current, { isAway: true, status: 'away' })).toBe(false);
    expect(source('src/hooks/usePresence.ts')).toContain(
      'setPresence(current => samePresenceState(current, next) ? current : next)',
    );
  });

  it('keeps the subtle desktop node map static', () => {
    const nodeMap = source('src/components/GlobalNodeMap.tsx');
    expect(nodeMap).toContain("variant === 'subtle' ? 30 : 60");
    expect(nodeMap).toContain("if (variant === 'subtle')");
    expect(nodeMap).toContain('style={{ ...style, opacity: dot.active ? 0.35 : 0.16 }}');
  });
});
