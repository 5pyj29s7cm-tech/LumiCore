import fs from "fs";
import path from "path";
import { collectFirstBootSnapshot } from "./system_explorer";

const outputPath = process.argv[2];
if (!outputPath) {
  throw new Error("System exploration worker requires an output path");
}

const resolvedOutput = path.resolve(outputPath);
fs.mkdirSync(path.dirname(resolvedOutput), { recursive: true });
const temporaryOutput = `${resolvedOutput}.${process.pid}.tmp`;

try {
  const snapshot = collectFirstBootSnapshot();
  fs.writeFileSync(temporaryOutput, `${JSON.stringify(snapshot)}\n`, "utf8");
  fs.renameSync(temporaryOutput, resolvedOutput);
} finally {
  try {
    fs.rmSync(temporaryOutput, { force: true });
  } catch {}
}
