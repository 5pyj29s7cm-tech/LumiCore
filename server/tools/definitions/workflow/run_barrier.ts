import { blockWorkflowRun, persistWorkflowRuntimeBarrier } from "../../../workflows/runtime";

export async function durablyBlockWorkflowRun(input: Parameters<typeof blockWorkflowRun>[0]) {
  const run = blockWorkflowRun(input);
  await persistWorkflowRuntimeBarrier();
  return run;
}
