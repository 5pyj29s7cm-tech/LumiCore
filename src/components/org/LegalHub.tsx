import { useApp } from "../../contexts/AppContext";
import { useLegalDocumentScope } from "../../hooks/useLegalDocument";
import { LegalHubScope } from './legal_hub/scope';



export function LegalHub() {
  const scopeKey = useLegalDocumentScope();
  const { workDomain, orgConnection } = useApp();
  return <LegalHubScope key={`${scopeKey}:${workDomain === 'work' && Boolean(orgConnection?.connected)}`} />;
}
