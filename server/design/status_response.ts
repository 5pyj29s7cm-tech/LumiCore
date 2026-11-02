import type { ToolExecutionRecord } from '../tools/types';
import { formatDesignLedgerMessage, type DesignStageId } from '../regions/messages/design_status_messages';

function parseObject(value: unknown): Record<string, any> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, any>;
  if (typeof value !== 'string' || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, any>
      : {};
  } catch {
    return {};
  }
}

function requestedStage(text: unknown): DesignStageId | null {
  const value = String(text || '');
  if (/\bCAD\b|\bDXF\b|\bDWG\b/i.test(value)) return 'cad';
  // i18n-allow: localized stage names are input recognition, not displayed text.
  if (/\u6548\u679c\u56fe|\u6e32\u67d3|\b(?:visualization|render)\b/i.test(value)) return 'visualization';
  if (/\bPPT\b|\u63d0\u6848|\b(?:presentation|proposal)\b/i.test(value)) return 'presentation';
  // i18n-allow: localized stage names are input recognition, not displayed text.
  if (/\u4ea4\u4ed8\u4e2d\u5fc3|\u4ea4\u4ed8\u5305|\b(?:handoff|delivery)\b/i.test(value)) return 'handoff';
  // i18n-allow: localized stage names are input recognition, not displayed text.
  if (/\u8bbe\u8ba1\u9879\u76ee|\u9879\u76ee\u65b9\u6848|\bproject\s+(?:scheme|stage|status)\b/i.test(value)) return 'project';
  return null;
}

export function formatVerifiedDesignProjectStatus(
  record: ToolExecutionRecord | undefined,
  taskText = '',
): string | null {
  if (
    !record
    || record.name !== 'interior_design_project_status'
    || record.error
    || record.terminalVerification?.status !== 'verified'
  ) return null;
  const payload = parseObject(record.result);
  const project = parseObject(payload.project);
  const workflow = parseObject(payload.workflow);
  const stages = parseObject(workflow.stages);
  if (payload.ok !== true || payload.persisted !== true || !String(project.id || '').trim()) return null;

  return formatDesignLedgerMessage(project, workflow, requestedStage(taskText), !taskText || /[\u3400-\u9fff]/u.test(taskText) ? 'zh' : 'en');
}
