import type { ToolRegistry } from '../registry';
import { registerWorkTakeoverTaskTools } from './work_takeover_task_tools';
import { registerWorkTakeoverPreparationTools } from './work_takeover_preparation_tools';
import { registerWorkTakeoverCoordinationTools } from './work_takeover_coordination_tools';
import { registerWorkTakeoverExecutionTools } from './work_takeover_execution_tools';
import { registerWorkTakeoverEvidenceTools } from './work_takeover_evidence_tools';

export function registerWorkTakeoverTools(registry: ToolRegistry): void {
  registerWorkTakeoverTaskTools(registry);
  registerWorkTakeoverPreparationTools(registry);
  registerWorkTakeoverCoordinationTools(registry);
  registerWorkTakeoverExecutionTools(registry);
  registerWorkTakeoverEvidenceTools(registry);
}
