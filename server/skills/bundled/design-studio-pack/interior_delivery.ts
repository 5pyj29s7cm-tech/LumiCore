export function splitInteriorList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).map(item => item.trim()).filter(Boolean);
  return String(value || '')
    .split(/\r?\n|,|;|\uFF0C|\uFF1B/)
    .map(item => item.trim())
    .filter(Boolean);
}

// i18n-allow: recognized input vocabulary; this literal does not render user-facing text.
const NEGATED_EVIDENCE_RE = /(?:^|[\s:：,，;；])(?:(?:no|none|not supplied|not provided|missing|without|unavailable|unknown)\b|无|未提供|没有|暂无|缺少|不含|未知)/i;
// i18n-allow: recognized input vocabulary; this literal does not render user-facing text.
const NON_SOURCE_DESCRIPTION_RE = /(?:仅有|只有|仅存在).*(?:需求|文字|描述|信息|面积)/i;
// i18n-allow: recognized input vocabulary; this literal does not render user-facing text.
const LINEAR_DIMENSION_RE = /(?:\d+(?:\.\d+)?(?:\s*[x×*]\s*\d+(?:\.\d+)?){0,2}\s*(?:mm|cm|m\b|毫米|厘米|米(?!方|²|2)))/i;

function isPositiveEvidenceClaim(value: string): boolean {
  const text = String(value || '').trim();
  return Boolean(text) && !NEGATED_EVIDENCE_RE.test(` ${text}`);
}

function isPositiveSourceReference(value: string): boolean {
  const text = String(value || '').trim();
  return isPositiveEvidenceClaim(text) && !NON_SOURCE_DESCRIPTION_RE.test(text);
}

function isVerifiedLinearDimension(value: string): boolean {
  const text = String(value || '').trim();
  if (!isPositiveEvidenceClaim(text)) return false;
// i18n-allow: recognized input vocabulary; this literal does not render user-facing text.
  if (/(?:平方米|平方公尺|m\s*[²2]|sq\.?\s*m)/i.test(text) && !/(?:mm|cm|毫米|厘米)/i.test(text)) return false;
  return LINEAR_DIMENSION_RE.test(text);
}

export function buildDrawingIngestQa(input: {
  projectName: string;
  sources: string | string[];
  knownDimensions?: string;
  evidenceNotes?: string;
  intendedUse?: string;
}) {
  const sourceClaims = splitInteriorList(input.sources);
  const dimensionClaims = splitInteriorList(input.knownDimensions);
  const sources = sourceClaims.filter(isPositiveSourceReference);
  const knownDimensions = dimensionClaims.filter(isVerifiedLinearDimension);
  const evidenceNotes = String(input.evidenceNotes || '').trim();
  const hasPositiveProvenance = isPositiveEvidenceClaim(evidenceNotes);
  const gaps = [
    ...(sources.length ? [] : ['No source drawing or scan was supplied.']),
    ...(knownDimensions.length ? [] : ['No independently verified dimension was supplied for scale calibration.']),
    ...(hasPositiveProvenance ? [] : ['No survey provenance, issue date, or drawing revision was supplied.']),
  ];
  return {
    projectName: input.projectName,
    scope: 'interior drawing intake and evidence QA',
    status: gaps.length ? 'needs_review' : 'ready_for_geometry_extraction',
    sources,
    intendedUse: input.intendedUse || 'space-planning base information',
    knownDimensions,
    evidenceNotes,
    evidenceGaps: gaps,
    rejectedEvidenceClaims: [
      ...sourceClaims.filter(value => !sources.includes(value)),
      ...dimensionClaims.filter(value => !knownDimensions.includes(value)),
      ...(!hasPositiveProvenance && evidenceNotes ? [evidenceNotes] : []),
    ],
    toolSequence: [
      'read_pdf or ocr_image_file for legible source evidence',
      'mcp_paddleocr-local_pp_structurev3 for complex scanned layout and table extraction',
      'floorplan_extract_geometry only after at least one known dimension is verified',
    ],
    checks: [
      'Record file name, drawing title, issue date, revision, page, and visible scale.',
      'Separate printed dimensions from OCR text and inferred geometry.',
      'Cross-check room labels, grid or wall continuity, openings, shafts, and level changes.',
      'Flag conflicting dimensions, clipped pages, perspective distortion, blur, and handwritten overrides.',
      'Do not mark geometry complete until deterministic checks and visual comparison pass.',
    ],
  };
}

export function buildIfcSpaceAuditPlan(input: {
  modelPath: string;
  scope?: string;
  checks?: string | string[];
  constraints?: string;
}) {
  const requestedChecks = splitInteriorList(input.checks);
  return {
    scope: input.scope || 'interior spaces and building-condition coordination',
    modelPath: input.modelPath,
    requestedChecks: requestedChecks.length
      ? requestedChecks
      : ['space and room inventory', 'levels and containment', 'materials', 'relationships', 'validation issues', 'clashes'],
    constraints: input.constraints || '',
    readOnlyToolSequence: [
      'mcp_ifc-readonly_ifc_load',
      'mcp_ifc-readonly_ifc_summary',
      'mcp_ifc-readonly_ifc_tree',
      'mcp_ifc-readonly_ifc_select',
      'mcp_ifc-readonly_ifc_info',
      'mcp_ifc-readonly_ifc_relations',
      'mcp_ifc-readonly_ifc_materials',
      'mcp_ifc-readonly_ifc_validate',
      'mcp_ifc-readonly_ifc_clash when explicitly relevant',
      'mcp_ifc-readonly_ifc_plot or mcp_ifc-readonly_ifc_render for visual evidence',
    ],
    prohibitedOperations: ['ifc_new', 'ifc_save', 'ifc_shape', 'ifc_edit', 'ifc_quantify'],
    deliverableFields: ['finding', 'element ids', 'source query', 'impact on interior design', 'required verifier', 'recommended next action'],
    stopConditions: [
      'Stop if the model path is outside the approved Lumi project data root.',
      'Stop if schema, units, coordinates, level mapping, or model revision is unknown.',
      'Do not describe a model as coordinated or clash-free without the corresponding query result.',
    ],
  };
}

export function buildRevitReadOnlyPlan(input: {
  objective: string;
  targetScope?: string;
  activeView?: string;
  requiredEvidence?: string | string[];
}) {
  return {
    objective: input.objective,
    targetScope: input.targetScope || 'active view and user-selected interior elements',
    activeView: input.activeView || 'use the active Revit view only after confirming its name and type',
    requiredEvidence: splitInteriorList(input.requiredEvidence),
    mode: 'read-only',
    querySequence: [
      'mcp_revit-readonly_revit_get_current_view_info',
      'mcp_revit-readonly_revit_get_selected_elements when the user has selected a review set',
      'mcp_revit-readonly_revit_ai_element_filter for an explicit, bounded element query',
      'mcp_revit-readonly_revit_get_element_details for cited element ids',
      'mcp_revit-readonly_revit_capture_view_image when visual evidence is required',
    ],
    blockedOperations: [
      'revit_send_code_to_revit',
      'revit_list_baked_tools',
      'revit_run_baked_tool',
      'revit_list_bake_suggestions',
      'any model write, family edit, parameter mutation, transaction, sync, save, or publish operation',
    ],
    stopConditions: [
      'Stop if the Revit add-in does not report a live read-only connection.',
      'Stop when the target model, view, phase, design option, link, or selection is ambiguous.',
      'Do not claim that a room, material, dimension, or coordination issue was verified without returned element evidence.',
    ],
  };
}

const CN_SCHEDULE_FIELDS = {
  furniture: '\u5bb6\u5177', // i18n-allow -- recognized source-schedule input label.
  fixedEquipment: '\u56fa\u5b9a\u8bbe\u5907', // i18n-allow -- recognized source-schedule input label.
  equipment: '\u8bbe\u5907', // i18n-allow -- recognized source-schedule input label.
  lighting: '\u706f\u5177', // i18n-allow -- recognized source-schedule input label.
  material: '\u6750\u6599', // i18n-allow -- recognized source-schedule input label.
  finish: '\u9970\u9762', // i18n-allow -- recognized source-schedule input label.
  category: '\u7c7b\u522b', // i18n-allow -- recognized source-schedule input label.
  currency: '\u5e01\u79cd', // i18n-allow -- recognized source-schedule input label.
  code: '\u7f16\u53f7', // i18n-allow -- recognized source-schedule input label.
  name: '\u540d\u79f0', // i18n-allow -- recognized source-schedule input label.
  space: '\u7a7a\u95f4', // i18n-allow -- recognized source-schedule input label.
  quantity: '\u6570\u91cf', // i18n-allow -- recognized source-schedule input label.
  dimensions: '\u5c3a\u5bf8', // i18n-allow -- recognized source-schedule input label.
  finishOrMaterial: '\u6750\u8d28', // i18n-allow -- recognized source-schedule input label.
  manufacturer: '\u5382\u5546', // i18n-allow -- recognized source-schedule input label.
  model: '\u578b\u53f7', // i18n-allow -- recognized source-schedule input label.
  unitPrice: '\u5355\u4ef7', // i18n-allow -- recognized source-schedule input label.
  leadTime: '\u4ea4\u671f', // i18n-allow -- recognized source-schedule input label.
  status: '\u72b6\u6001', // i18n-allow -- recognized source-schedule input label.
  notes: '\u5907\u6ce8', // i18n-allow -- recognized source-schedule input label.
} as const;

const FFE_CATEGORY_MAP: Record<string, string> = {
  furniture: 'furniture',
  [CN_SCHEDULE_FIELDS.furniture]: 'furniture',
  fixture: 'fixture',
  fixtures: 'fixture',
  [CN_SCHEDULE_FIELDS.fixedEquipment]: 'fixture',
  equipment: 'equipment',
  [CN_SCHEDULE_FIELDS.equipment]: 'equipment',
  lighting: 'lighting',
  light: 'lighting',
  [CN_SCHEDULE_FIELDS.lighting]: 'lighting',
  finish: 'finish',
  finishes: 'finish',
  [CN_SCHEDULE_FIELDS.material]: 'finish',
  [CN_SCHEDULE_FIELDS.finish]: 'finish',
};

export function normalizeFfeSchedule(input: { recordsJson: string; defaultCurrency?: string }) {
  let records: unknown;
  try {
    records = JSON.parse(input.recordsJson);
  } catch (error: any) {
    return {
      status: 'needs_review',
      records: [],
      errors: [`Invalid JSON: ${String(error?.message || error)}`],
      safeguards: ['No source record was changed or discarded.'],
    };
  }
  if (!Array.isArray(records)) {
    return {
      status: 'needs_review',
      records: [],
      errors: ['recordsJson must contain a JSON array.'],
      safeguards: ['No source record was changed or discarded.'],
    };
  }

  const normalized = records.map((record, index) => {
    const source: Record<string, unknown> = record && typeof record === 'object'
      ? record as Record<string, unknown>
      : { value: record };
    const rawCategory = String(source.category || source.type || source[CN_SCHEDULE_FIELDS.category] || '').trim();
    const category = FFE_CATEGORY_MAP[rawCategory.toLowerCase()] || rawCategory || 'unclassified';
    const currency = String(source.currency || source[CN_SCHEDULE_FIELDS.currency] || input.defaultCurrency || '').trim().toUpperCase();
    return {
      row: index + 1,
      itemCode: String(source.itemCode || source.code || source.sku || source[CN_SCHEDULE_FIELDS.code] || '').trim(),
      itemName: String(source.itemName || source.name || source[CN_SCHEDULE_FIELDS.name] || '').trim(),
      category,
      roomOrZone: String(source.roomOrZone || source.room || source.zone || source[CN_SCHEDULE_FIELDS.space] || '').trim(),
      quantity: source.quantity ?? source.qty ?? source[CN_SCHEDULE_FIELDS.quantity] ?? '',
      dimensions: source.dimensions ?? source.size ?? source[CN_SCHEDULE_FIELDS.dimensions] ?? '',
      finishOrMaterial: source.finishOrMaterial ?? source.material ?? source.finish ?? source[CN_SCHEDULE_FIELDS.finishOrMaterial] ?? '',
      manufacturer: source.manufacturer ?? source.brand ?? source[CN_SCHEDULE_FIELDS.manufacturer] ?? '',
      model: source.model ?? source[CN_SCHEDULE_FIELDS.model] ?? '',
      unitPrice: source.unitPrice ?? source.price ?? source[CN_SCHEDULE_FIELDS.unitPrice] ?? '',
      currency,
      leadTime: source.leadTime ?? source[CN_SCHEDULE_FIELDS.leadTime] ?? '',
      status: source.status ?? source[CN_SCHEDULE_FIELDS.status] ?? '',
      notes: source.notes ?? source.remark ?? source[CN_SCHEDULE_FIELDS.notes] ?? '',
      sourceRecord: source,
    };
  });

  return {
    status: normalized.length ? 'normalized_for_review' : 'needs_review',
    recordCount: normalized.length,
    records: normalized,
    safeguards: [
      'Source records are preserved in sourceRecord.',
      'Dimensions, quantities, and prices are not converted, calculated, or guessed.',
      'Unrecognized categories remain visible instead of being silently remapped.',
    ],
  };
}

export function buildSiteSurveyReport(input: {
  projectName: string;
  observations: string | string[];
  reportedInfo?: string | string[];
  photos?: string | string[];
  limitations?: string | string[];
  followups?: string | string[];
}) {
  const observations = splitInteriorList(input.observations);
  const reportedInfo = splitInteriorList(input.reportedInfo);
  const photos = splitInteriorList(input.photos);
  const limitations = splitInteriorList(input.limitations);
  const followups = splitInteriorList(input.followups);
  return {
    projectName: input.projectName,
    reportType: 'interior site survey evidence register',
    directObservations: observations,
    reportedButNotObserved: reportedInfo,
    photoReferences: photos,
    accessAndMeasurementLimitations: limitations,
    followups,
    status: observations.length && photos.length ? 'draft_for_review' : 'evidence_incomplete',
    rules: [
      'Do not merge reported information into direct observations.',
      'Link each material finding to a photo, sketch, measurement, or named source where available.',
      'Record inaccessible areas, concealed conditions, temporary obstructions, and unverified services.',
      'Escalate structural, fire, MEP, hazardous-material, and code questions to qualified professionals.',
    ],
  };
}
