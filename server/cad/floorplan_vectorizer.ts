import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';

export interface FloorplanVectorizerInput {
  imagePath: string;
  crop: { left: number; top: number; width: number; height: number };
  physicalWidth: number;
  physicalHeight: number;
}

function resolveVectorizerScript(): string {
  const candidates = [
    path.join(process.cwd(), 'server', 'cad', 'floorplan_vectorizer.py'),
    path.join(process.cwd(), '..', 'server', 'cad', 'floorplan_vectorizer.py'),
  ];
  const script = candidates.find(candidate => fs.existsSync(candidate));
  if (!script) throw new Error('Floor-plan vectorizer runtime asset is missing.');
  return script;
}

function runPython(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, {
      timeout: 90_000,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
      env: {
        ...process.env,
        PYTHONIOENCODING: 'utf-8',
        PYTHONUTF8: '1',
      },
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(String(stderr || error.message || error).trim()));
        return;
      }
      resolve(stdout);
    });
  });
}

export async function vectorizeFloorplanLinework(input: FloorplanVectorizerInput): Promise<Record<string, any>> {
  const script = resolveVectorizerScript();
  const python = process.env.LUMI_CAD_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  let stdout: string;
  try {
    stdout = await runPython(python, [
      script,
      '--image', path.resolve(input.imagePath),
      '--left', String(Math.round(input.crop.left)),
      '--top', String(Math.round(input.crop.top)),
      '--crop-width', String(Math.round(input.crop.width)),
      '--crop-height', String(Math.round(input.crop.height)),
      '--physical-width', String(input.physicalWidth),
      '--physical-height', String(input.physicalHeight),
    ]);
  } catch (error: any) {
    const message = String(error?.message || error);
    if (/opencv|cv2|no module named/i.test(message)) {
      throw new Error('Deterministic floor-plan tracing requires the local OpenCV runtime (Python package opencv-python). CAD execution remains blocked until it is available.');
    }
    throw new Error(`Deterministic floor-plan tracing failed: ${message}`);
  }
  let parsed: Record<string, any>;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error('Deterministic floor-plan tracing returned invalid JSON.');
  }
  if (parsed?.kind !== 'lumi_floorplan_opencv_vectorization'
    || !Array.isArray(parsed.outerBoundary)
    || parsed.outerBoundary.length < 4
    || !Array.isArray(parsed.polylines)
    || parsed.polylines.length < 8) {
    throw new Error('Deterministic floor-plan tracing did not produce a credible boundary and source linework.');
  }
  return parsed;
}
