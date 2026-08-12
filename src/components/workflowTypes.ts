export interface WorkflowStep {
  id: string;
  type: 'thinking' | 'background' | 'confirmation' | 'tool_start' | 'tool_result' | 'response' | 'error';
  text: string;
  time: number;
  detail?: string;
}

export interface BackgroundWorkflowTask {
  id: string;
  title?: string;
  status: 'queued' | 'running' | 'cancelling' | 'completed' | 'failed' | 'cancelled';
  workerNames?: string[];
  toolCallsCount?: number;
  error?: string;
  resultPreview?: string;
  updatedAt?: string;
}
