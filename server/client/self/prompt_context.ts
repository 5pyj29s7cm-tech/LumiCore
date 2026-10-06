import { isCapabilityLearningRecordVerified, listCapabilityLearningRecords } from "../../self_extension/capability_memory";
import type { ClientStateSnapshot } from './contracts';

export function formatLearnedCapabilityRoutes(
  userId: string,
  scope: { domain: 'personal' | 'work'; orgId: string },
): string[] {
  try {
    const records = listCapabilityLearningRecords({
      userId,
      scopeDomain: scope.domain,
      orgId: scope.domain === 'work' ? scope.orgId : '',
      limit: 8,
    })
      .filter(isCapabilityLearningRecordVerified);
    if (!records.length) {
      return [scope.domain === 'work'
        ? '- No organization-scoped learned routes yet. The current work workspace does not expose any member\'s personal learned routes.'
        : '- No persisted learned capability routes yet. When a capability gap appears, use capability_gap_autofix to create one.'];
    }
    return records.map(record => [
      `- ${record.selectedRoute.label} (${record.domain}/${record.status})`,
      `Goal: ${record.goal}`,
      record.nextUse.preferredTools.length ? `Preferred tools: ${record.nextUse.preferredTools.slice(0, 7).join(', ')}` : '',
      `First step: ${record.nextUse.firstStep}`,
      record.selectedRoute.avoid.length ? `Avoid: ${record.selectedRoute.avoid.slice(0, 3).join('; ')}` : '',
      record.experiment.summary ? `Experiment: ${record.experiment.summary}` : '',
    ].filter(Boolean).join(' | '));
  } catch {
    return ['- Learned capability routes unavailable until the local database is initialized.'];
  }
}

export function formatWallpaperState(state: ClientStateSnapshot | null | undefined): string {
  const enabled = Boolean(state?.surfaces?.wallpaperMode);
  if (!enabled) return 'false';
  return `true(presentation=${state?.surfaces?.wallpaperPresentation || 'unknown'}, workspace=${state?.surfaces?.wallpaperWorkspace || 'unknown'})`;
}

export function formatActiveWallpaperBoundary(
  state: ClientStateSnapshot | null | undefined,
  isWork: boolean,
): string {
  if (!state?.surfaces?.wallpaperMode) return '';
  const presentation = state.surfaces.wallpaperPresentation || 'unknown';
  const workspace = state.surfaces.wallpaperWorkspace || 'unknown';
  if (presentation === 'desktop-control') {
    return '- Wallpaper boundary: desktop-control is a temporary click-through presentation for visible external-app operation. It is not a new operation mode; restore the previous workspace presentation when the operation finishes.';
  }
  if (isWork || workspace === 'organization') {
    return '- Wallpaper boundary: organization workbench uses only the authenticated member role, active organization scope, and organization-authorized data. Never load or expose personal memories, private conversations, local learning, or personal files.';
  }
  if (workspace === 'command-center') {
    return '- Wallpaper boundary: command-center workbench must continue the same current task and preserve its receipts, blockers, corrections, and next step. It is a presentation, not a new task, operation mode, or agent.';
  }
  return '- Wallpaper boundary: personal workbench is a private local-machine focus surface for this user. It is a presentation, not a new task, operation mode, or agent.';
}
