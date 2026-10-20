import type { ToolRegistry } from '../../../tools/registry';
import type { ToolDefinition } from '../../../tools/types';
import { catalog_contractsTools } from "./legal_tools/definitions_catalog_contracts";
import { case_researchTools } from "./legal_tools/definitions_case_research";
import { case_documentsTools } from "./legal_tools/definitions_case_documents";
import { material_intakeTools } from "./legal_tools/definitions_material_intake";
import { external_researchTools } from "./legal_tools/definitions_external_research";
import { authority_knowledgeTools } from "./legal_tools/definitions_authority_knowledge";

/** Public compatibility entry; definitions and handlers live with their legal responsibility. */
export function legalToolDefinitions(): ToolDefinition[] {
  return [
    ...catalog_contractsTools(), ...case_researchTools(), ...case_documentsTools(),
    ...material_intakeTools(), ...external_researchTools(), ...authority_knowledgeTools(),
  ];
}

export function registerLegalTools(registry: ToolRegistry): void {
  for (const definition of legalToolDefinitions()) registry.register(definition);
}
