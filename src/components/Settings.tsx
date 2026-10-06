import { useApp } from "@/contexts/AppContext";
import { SettingsView } from './settings/navigation';



export function Settings(props: Parameters<typeof SettingsView>[0]) {
  const { user, workDomain, orgConnection } = useApp();
  return <SettingsView key={JSON.stringify([user?.uid, user?.role, workDomain, orgConnection?.orgId])} {...props} />;
}
