import type { LumiActionContract } from './action_contract';

export interface ExactToolScope {
  toolNames: string[];
  category?: string;
  reason: string;
  replaceReasons?: boolean;
  iterations?: number | ((size: number) => number);
}

export interface ExactToolScopeInput {
  contract: LumiActionContract;
  available: Set<string>;
  runtimeWorkIntent: 'none' | 'status' | 'cancel';
  currentAppEdit: boolean;
  avatarAuthoring: boolean;
  desktopObservationToolNames: string[];
  cadGeometryExtractionTools: string[] | null;
  compositeCad: boolean;
  blankAutoCadDocument: boolean;
  desktopLaunchRequest: boolean;
  documentOpenAndReview: boolean;
  currentAuthoringDocumentInspection: boolean;
  trustedCurrentDocumentReadAnchor: boolean;
  confirmationOnlyExternalCommit: boolean;
  readOnlyKnowledgeInspection: boolean;
}

/** Pick one owner. Ledger control and signed registry work outrank incidental
 * application/domain words; remaining exact routes retain their prior order. */
export function resolveExactToolScope(input: ExactToolScopeInput): ExactToolScope | undefined {
  const { contract, available } = input;
  if (contract.kind === 'extension_registry') return {
    toolNames: [...contract.preferredTools, ...contract.verificationTools],
    category: 'extension_registry', replaceReasons: true, iterations: size => Math.max(2, size),
    reason: 'signed extension and Provider operations use only the transactional registry and its persistent receipts',
  };
  if (input.runtimeWorkIntent !== 'none' || contract.kind === 'task_control') return {
    toolNames: [input.runtimeWorkIntent === 'cancel' ? 'runtime_work_cancel' : 'runtime_work_status'],
    category: 'task_control', replaceReasons: true, iterations: 1,
    reason: 'runtime work status and cancellation use one exact unified-ledger tool without shell, process-list, or database fallbacks',
  };
  if (input.currentAppEdit) return undefined;
  if (input.avatarAuthoring) return {
    toolNames: ['memory_avatar_read', 'memory_avatar_create', 'memory_avatar_import_image', 'memory_avatar_configure_animation',
      'generate_image', 'ai_edit_image', 'get_image_generation_status', 'client_action'],
    category: 'memory_avatar', iterations: 16,
    reason: 'Memory person authoring uses the person store and image tools; no source-code or desktop-script workaround.',
  };
  if (input.desktopObservationToolNames.length) return {
    toolNames: input.desktopObservationToolNames.map(name => name === 'desktop_active_window'
      && !available.has(name) ? 'get_active_window_info' : name),
    category: 'desktop_observation', replaceReasons: true, iterations: input.desktopObservationToolNames.length + 1,
    reason: 'pure desktop observation uses only the exact read-only window and desktop-directory tools requested',
  };
  if (input.cadGeometryExtractionTools) return {
    toolNames: input.cadGeometryExtractionTools,
    reason: 'geometry-extraction-only requests use a hard read/observe allowlist and cannot generate files or operate AutoCAD',
  };
  if (input.compositeCad) return {
    toolNames: ['cad_draw_floorplan_in_autocad'], iterations: 2,
    reason: 'one composite CAD skill owns discovery, calibration, verified geometry, AutoCAD playback, resume, and acceptance for local floor-plan drawing',
  };
  if (input.blankAutoCadDocument) return {
    toolNames: ['mcp_cad-drafting_autocad_new_document'],
    reason: 'blank AutoCAD document requests use the dedicated COM document tool and never synthesize geometry',
  };
  if (input.desktopLaunchRequest) return {
    // Launch plus exact-window verification retains both steps.
    toolNames: [...contract.preferredTools,
      ...(contract.preferredTools.includes('browser_open_task') && available.has('browser_open_task') ? [] : ['desktop_open']),
      'desktop_active_window'],
    category: 'desktop_launch', replaceReasons: true, iterations: size => Math.max(2, size),
    reason: 'a launch-only request uses the exact target resolver and verification tools without unrelated production capabilities',
  };
  if (input.documentOpenAndReview) return {
    toolNames: ['desktop_list_files', 'search_files', 'desktop_path_info', 'desktop_open', 'desktop_active_window',
      'read_pdf', 'read_docx', 'read_xlsx', 'extract_document_text', 'ocr_screen', 'ocr_region'],
    category: 'document_open_and_review', replaceReasons: true, iterations: size => Math.max(3, size),
    reason: 'document presentation requires exact file discovery, opening, content extraction, and visible-target verification',
  };
  if (input.currentAuthoringDocumentInspection) return {
    // Shared preflight still requires an exact native observation before any file read.
    toolNames: ['desktop_running_processes', 'desktop_active_window', 'desktop_list_files', 'search_files',
      'desktop_path_info', 'read_file', 'extract_document_text', 'read_pdf', 'read_docx', 'read_xlsx'],
    category: 'current_document_inspection', replaceReasons: true, iterations: size => Math.max(3, size),
    reason: input.trustedCurrentDocumentReadAnchor
      ? 'a server-owned authoring-window anchor permits bounded discovery and read-only document extraction'
      : 'current-document inspection first observes native background WPS/Office document candidates; shared preflight permits bounded discovery and reading only after one exact candidate is anchored',
  };
  if (input.confirmationOnlyExternalCommit) return {
    toolNames: ['wechat_send_message'], category: 'messaging', iterations: 1,
    reason: 'confirmation-only external messaging exposes only the exact send adapter, which must stop at the confirmation gate',
  };
  if (input.readOnlyKnowledgeInspection) return {
    toolNames: ['knowledge_file_stats', 'knowledge_coverage_report'], category: 'knowledge', iterations: size => Math.max(2, size),
    reason: 'read-only knowledge inventory is isolated from client, system, document, and mutation routes',
  };
}
