import type { ToolRegistry } from '../registry';
import { registerSelfExtensionLearningTools } from './self_extension_learning_tools';
import { registerSelfExtensionProgramTools } from './self_extension_program_tools';
import { registerSelfExtensionStagingTools } from './self_extension_staging_tools';

export function registerSelfExtensionTools(registry: ToolRegistry): void {
  registerSelfExtensionLearningTools(registry);
  registerSelfExtensionProgramTools(registry);
  registerSelfExtensionStagingTools(registry);
}
