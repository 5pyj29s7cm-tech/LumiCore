import type { ToolRegistry } from '../../../tools/registry';
import { catalog_contractsTools } from "./legal_tools/definitions_catalog_contracts";
import { case_researchTools } from "./legal_tools/definitions_case_research";
import { case_documentsTools } from "./legal_tools/definitions_case_documents";
import { material_intakeTools } from "./legal_tools/definitions_material_intake";
import { external_researchTools } from "./legal_tools/definitions_external_research";
import { authority_knowledgeTools } from "./legal_tools/definitions_authority_knowledge";

/** Public compatibility entry; definitions and handlers live with their legal responsibility. */
export function registerLegalTools(registry: ToolRegistry): void {
  for (const definition of catalog_contractsTools()) registry.register(definition);
  for (const definition of case_researchTools()) registry.register(definition);
  for (const definition of case_documentsTools()) registry.register(definition);
  for (const definition of material_intakeTools()) registry.register(definition);
  for (const definition of external_researchTools()) registry.register(definition);
  for (const definition of authority_knowledgeTools()) registry.register(definition);
}
