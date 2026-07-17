import { describe, expect, it, vi } from 'vitest';

const taskMocks = vi.hoisted(() => ({
  close: vi.fn(),
  createFaceLandmarker: vi.fn(),
}));

vi.mock('@mediapipe/tasks-vision', () => {
  taskMocks.createFaceLandmarker.mockImplementation(async () => ({
    close: taskMocks.close,
    detectForVideo: vi.fn(() => ({ faceLandmarks: [] })),
  }));
  return {
    FilesetResolver: {
      forVisionTasks: vi.fn().mockResolvedValue({}),
    },
    FaceLandmarker: {
      createFromOptions: taskMocks.createFaceLandmarker,
    },
    FaceDetector: {
      createFromOptions: vi.fn(),
    },
    HandLandmarker: {
      createFromOptions: vi.fn(),
    },
  };
});

describe('shared MediaPipe face task lifecycle', () => {
  it('keeps the task alive until the final consumer releases it, then closes it once', async () => {
    const { acquireFaceLandmarker, isFaceLandmarkerReady } = await import('../src/lib/mediapipe/loader');

    const releaseFirst = await acquireFaceLandmarker();
    const releaseSecond = await acquireFaceLandmarker();
    expect(taskMocks.createFaceLandmarker).toHaveBeenCalledTimes(1);
    expect(isFaceLandmarkerReady()).toBe(true);

    releaseFirst();
    releaseFirst();
    expect(taskMocks.close).not.toHaveBeenCalled();
    expect(isFaceLandmarkerReady()).toBe(true);

    releaseSecond();
    expect(taskMocks.close).toHaveBeenCalledTimes(1);
    expect(isFaceLandmarkerReady()).toBe(false);

    const releaseThird = await acquireFaceLandmarker();
    expect(taskMocks.createFaceLandmarker).toHaveBeenCalledTimes(2);
    releaseThird();
    expect(taskMocks.close).toHaveBeenCalledTimes(2);
  });
});
