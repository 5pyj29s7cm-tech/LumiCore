import { CN_TASK_TARGET_ANCHOR_MESSAGES } from "../regions/messages/task_target_anchor_messages";
import { classifySkillAuthoringIntent } from "../skills/authoring_intent";
import { affirmativeActionClauses, normalizeActionIntent } from "../cognition/normalized_action_intent";
import { isArtifactProducerRecord } from "../tools/artifact_evidence";
import type { TaskTargetAnchorV1, AcceptedTaskTarget, TaskTargetEvidenceRecord, BuildTaskTargetAnchorInput, TaskTargetAnchorProjectionV1, EvidenceCandidate, TaskTargetToolCallGuardResult } from './targets/contracts';
import { primaryTaskText, parseTaskTargetJson, unique, normalizedIdentity, compact } from './targets/values';
import { explicitFile, excludedFileReferences, fileReferenceClauses, prefersCurrentWpsDocument, prefersCurrentAuthoringDocument, isFileTargetTask } from './targets/instruction_targets';
import { concreteTargetPath, displayableFileName, targetReferenceMatches, canonicalPathIdentity, fileName } from './targets/paths';
import { VALUE_CORRECTION_RE, EXCLUDED_FILE_CLAUSE_RE, WPS_RE, UNSTRUCTURED_FILE_ACCESS_TOOL_RE, DISCOVERY_TOOLS, DOCUMENT_INTERFACE_RE, CURRENT_DOCUMENT_INTERFACE_RE } from './targets/recognition';
import { verifiedProducedDocumentPath, callTarget, blocked, targetMatchesAnchor, targetKeepsAnchoredObjectIdentity, isVerifiedProducedDocumentTarget, argumentsWithAnchoredDocumentPath } from './targets/call_binding';
import { isUnconfirmedRuntimeCandidate, allowedTaskSearchRoots, isAllowedTaskSearchDirectory } from './targets/search_scope';
import { recordSucceeded, activeWindowCandidate, documentCandidate, candidateMatchesRequestedAuthoringApplication, runningAuthoringWindowCandidates, discoveryCandidate, requestedAuthoringApplication, supportedAuthoringApplication } from './targets/evidence_candidates';
import { capsuleTarget, mergeTarget, capsuleRejectedTargets, rejectedByIdentity } from './targets/capsule_targets';

export { TASK_TARGET_HISTORY_LIMIT } from './targets/contracts';
export type { TaskTargetAnchorStatus } from './targets/contracts';
export type { TaskTargetAnchorSource } from './targets/contracts';
export type { TaskTargetAnchorV1 } from './targets/contracts';
export type { AcceptedTaskTarget } from './targets/contracts';
export type { TaskTargetEvidenceRecord } from './targets/contracts';
export type { TaskTargetAnchorProjectionV1 } from './targets/contracts';
export type { BuildTaskTargetAnchorInput } from './targets/contracts';
export type { TaskTargetToolCallGuardResult } from './targets/contracts';
export { parseTaskTargetJson } from './targets/values';
export { canonicalPathIdentity } from './targets/paths';
export { sourceDocumentInstruction } from './targets/instruction_targets';
export { outputDocumentInstruction } from './targets/instruction_targets';
export { primaryTaskText } from './targets/values';
export { isFileTargetTask } from './targets/instruction_targets';
export { prefersCurrentWpsDocument } from './targets/instruction_targets';
export { prefersCurrentAuthoringDocument } from './targets/instruction_targets';
export { isUnconfirmedRuntimeCandidate } from './targets/search_scope';
export { allowedTaskSearchRoots } from './targets/search_scope';
export { isAllowedTaskSearchDirectory } from './targets/search_scope';
export { isVerifiedProducedDocumentTarget } from './targets/call_binding';

/** Resolve a referential file target once for routing, execution and finalization.
 * History must be loaded by the caller from this exact authorized conversation.
 * Recovering a target does not authorize an operation or resume an old task.
 */
export function resolveAcceptedTaskTarget(input: {
  text: string;
  persistedHistory?: ReadonlyArray<{ id?: string; role?: string; message?: string; content?: string; requestId?: string; toolCalls?: unknown }>;
  previousTask?: { taskId?: string; target?: Partial<TaskTargetAnchorV1> } | null;
}): AcceptedTaskTarget | undefined {
  const current = primaryTaskText(input.text);
  const named = explicitFile(current);
  const unresolved = (): AcceptedTaskTarget => ({
    target: { label: '', application: '', window: '', object: '', path: '', location: '', status: 'unresolved', source: 'unknown' },
    source: 'current_turn', sourceId: '',
  });
  const make = (value: string, source: AcceptedTaskTarget['source'], sourceId = ''): AcceptedTaskTarget | undefined => {
    if (!concreteTargetPath(value) || !displayableFileName(value)) return undefined;
    const target = buildTaskTargetAnchorProjection({ taskText: value }).target;
    if (!target.path || target.status === 'rejected') return undefined;
    return { target, source, sourceId };
  };
  if (concreteTargetPath(named)) return make(named, 'current_turn');
  const authoringIntent = classifySkillAuthoringIntent(current);
  if (authoringIntent !== 'none' && authoringIntent !== 'use') return undefined;
  // A produced/new version is not the old input file. Recover it only from
  // request-bound persisted tool receipts, never assistant prose.
  // i18n-allow: produced-file and plural-target input recognition.
  const producedReference = /(?:刚才|刚刚|之前|上次)?(?:生成|创建|另存|导出|保存)(?:的|好|完).{0,12}(?:文件|文档|表格|副本)|(?:新版|新生成|输出|结果)(?:的)?(?:文件|文档|表格)|\b(?:generated|created|exported|saved|output|new\s+version)\b.{0,25}\b(?:file|document|spreadsheet|copy)\b/iu.test(current);
  // i18n-allow: plural file-reference input recognition.
  const pluralReference = /(?:两|二|多|几|这些|上述|所有)(?:个|份|张)?(?:文件|文档|表格)|\b(?:both|these|all|multiple)\b.{0,15}\b(?:files|documents|spreadsheets)\b/iu.test(current);
  if (pluralReference) return unresolved();
  // i18n-allow: referential task recognition, not user-facing copy.
  const refersToPrior = /(?:刚才|刚刚|之前|上面|前面|继续|接着|原文件|这(?:个|份|张)|该(?:文件|文档|表格)|其余|其他不变)|\b(?:previous|earlier|same|that|this|continue|resume|original)\b/iu.test(current);
  // i18n-allow: value-correction and file-operation input recognition.
  const valueCorrection = VALUE_CORRECTION_RE.test(current);
  // Generic "continue/this" in a different topic does not select an old file.
  // i18n-allow: semantic file-operation input recognition.
  if (!named && !valueCorrection && !/(?:读取|读一下|查看|检查|分析|计算|核算|汇总|算出|重新算|原文件|文件|文档|表格)|按.{0,15}计划.{0,8}执行|\b(?:read|inspect|analy[sz]e|calculate|compute|file|document|spreadsheet)\b|\b(?:execute|run|follow)\b.{0,25}\bplan\b/iu.test(current)) return undefined;
  if (!named && !refersToPrior && !valueCorrection && !producedReference) return undefined;
  // "Keep the original unchanged" protects the selected input; it does not
  // select an older pre-generation source instead of the current workbook.
  // i18n-allow: original-file preservation clauses are not positive target selection.
  const originalSelectionText = current.replace(/(?:不|不要|别|请勿|勿)\s*(?:修改|改动|改写|覆盖)\s*(?:原|源)(?:文件|文档|表格)|(?:保持|保留)\s*(?:原|源)(?:文件|文档|表格)(?:原样|不变)|(?:原|源)(?:文件|文档|表格)\s*(?:不动|不变|保持原样)|\b(?:do\s+not|don't|without)\s+(?:modify|modifying|edit|editing|change|changing|overwrite|overwriting)\s+(?:the\s+)?(?:original|source)\s+(?:file|document|spreadsheet)\b/giu, ' ');
  // i18n-allow: affirmative original-file input recognition.
  const explicitlyOriginal = /(?:原|源)(?:文件|文档|表格)|\b(?:original|source)\s+(?:file|document|spreadsheet)\b/iu.test(originalSelectionText);
  // A reference to a previously read file format selects that input, even
  // after another format was produced. Do not treat the output as the input.
  // i18n-allow: explicit prior-read format recognition, not display text.
  const priorReadFormat = current.match(/(?:刚才|刚刚|之前|上次)(?:读取|读过|查看)(?:的)?(?:那|这)?(?:一)?(?:份|个)?\s*(CSV|PDF|Excel|Word)\b|\b(?:previously|earlier)\s+read\s+(CSV|PDF|Excel|Word)\b/iu);
  const selectedFormat = (priorReadFormat?.[1] || priorReadFormat?.[2] || '').toLowerCase();
  const selectedExtensions: Record<string, RegExp> = { csv: /\.csv$/iu, pdf: /\.pdf$/iu, excel: /\.xlsx?$/iu, word: /\.docx?$/iu };
  const matchesSelectedFormat = (value: string) => !selectedFormat || selectedExtensions[selectedFormat].test(value);
  const rejected = excludedFileReferences(current);
  for (const record of [...(input.persistedHistory || [])].reverse()) {
    if (record.role === 'assistant' && !explicitlyOriginal) {
      const calls = parseTaskTargetJson(record.toolCalls);
      if (selectedFormat && record.requestId && Array.isArray(calls)) {
        const observed = unique(calls.filter((call): call is TaskTargetEvidenceRecord => Boolean(
          call && typeof call === 'object' && call.requestId === record.requestId
          && /^(?:read_file|read_xlsx|read_docx|read_pdf)$/u.test(String(call.name || ''))
          && !call.error && call.outcome !== 'failure' && call.terminalVerification?.status === 'verified',
        )).map(call => {
          const args = call.arguments || {};
          return String(args.filePath || args.path || '');
        }).filter(value => concreteTargetPath(value) && displayableFileName(value)
          && matchesSelectedFormat(value) && !rejected.some(reference => targetReferenceMatches(value, reference))));
        if (observed.length > 1) return unresolved();
        if (observed.length === 1) {
          const accepted = make(observed[0], 'prior_tool_receipt', record.id || record.requestId);
          if (accepted) accepted.target.source = 'tool_receipt';
          return accepted || unresolved();
        }
      }
      const producers = (Array.isArray(calls) ? calls : [])
        .filter((call): call is TaskTargetEvidenceRecord => Boolean(call && typeof call === 'object' && isArtifactProducerRecord({ name: String(call.name || ''), capability: call.capability })));
      if (producers.length) {
        if (!record.requestId || producers.some(call => call.requestId !== record.requestId)) return unresolved();
        const paths = producers.map(verifiedProducedDocumentPath);
        if (paths.some(value => !value)) return unresolved();
        const distinct = unique(paths).filter(value => matchesSelectedFormat(value) && !rejected.some(reference => targetReferenceMatches(value, reference)));
        if (selectedFormat && distinct.length === 0) continue;
        if (distinct.length !== 1 || (named && !targetReferenceMatches(distinct[0], named))) return unresolved();
        const accepted = make(distinct[0], 'prior_tool_receipt', record.id || record.requestId);
        if (accepted) accepted.target.source = 'tool_receipt';
        return accepted || unresolved();
      }
      continue;
    }
    if (record.role !== 'user') continue;
    const priorText = primaryTaskText(String(record.message || record.content || ''));
    // An intervening output-producing request changes the possible referent.
    // This resolver has no producer receipt, so it must not silently skip that
    // request and reselect an older input when the user then edits "it".
    // i18n-allow: prior artifact creation and explicit original-file recognition.
    const priorProducedArtifact = /(?:生成|创建|新建|另存|导出).{0,45}(?:文件|文档|表格|副本|xlsx|csv)|\b(?:create|generate|export|save\s+as)\b.{0,50}\b(?:file|document|spreadsheet|copy|xlsx|csv)\b/iu.test(priorText);
    if (!named && priorProducedArtifact && !explicitlyOriginal && !selectedFormat) return unresolved();
    rejected.push(...excludedFileReferences(priorText));
    const references = fileReferenceClauses(priorText)
      .filter(clause => !EXCLUDED_FILE_CLAUSE_RE.test(clause))
      .map(clause => explicitFile(clause)).filter(Boolean);
    const distinct = new Set(references.map(reference => canonicalPathIdentity(reference) || normalizedIdentity(reference)));
    if (!named && distinct.size > 1) return unresolved();
    const prior = explicitFile(priorText);
    if (!prior) continue;
    if (!matchesSelectedFormat(prior)) continue;
    if (producedReference && !explicitlyOriginal) return unresolved();
    if (rejected.some(reference => targetReferenceMatches(prior, reference))) continue;
    if (named && !targetReferenceMatches(prior, named)) continue;
    const resolved = make(prior, 'prior_user_message', record.id || '');
    if (resolved) return resolved;
    // The most recent user reference did not resolve. Do not silently fall
    // through to a different older document with an unrelated identity.
    if (!named) return undefined;
  }
  if (producedReference) return unresolved();
  const previous = input.previousTask?.target;
  if (previous?.status === 'rejected' || !previous?.path) return undefined;
  if (!matchesSelectedFormat(previous.path)) return unresolved();
  if (rejected.some(reference => targetReferenceMatches(previous.path, reference))) return unresolved();
  if (named && !targetReferenceMatches(previous.path, named)) return undefined;
  return make(previous.path, 'task', input.previousTask?.taskId || '');
}

export function buildTaskTargetAnchorProjection(
  input: BuildTaskTargetAnchorInput,
): TaskTargetAnchorProjectionV1 {
  const taskText = String(input.taskText || '');
  const sourcePaths = unique(input.sourcePaths || [], 8);
  const ignoredCandidates = sourcePaths.filter(candidate => isUnconfirmedRuntimeCandidate(candidate, taskText));
  const safePaths = sourcePaths.filter(candidate => !ignoredCandidates.includes(candidate));
  const evidence = (input.evidence || []).filter(recordSucceeded);
  const activeCandidates = evidence.map(activeWindowCandidate).filter((item): item is EvidenceCandidate => Boolean(item));
  const documentCandidates = evidence.map(documentCandidate).filter((item): item is EvidenceCandidate => Boolean(item));
  const previous = input.previousTarget || capsuleTarget(taskText);
  const userFile = explicitFile(taskText);
  const currentWps = prefersCurrentWpsDocument(taskText, input.applicationHint || previous?.application || '');
  const currentAuthoringDocument = prefersCurrentAuthoringDocument(
    taskText,
    input.applicationHint || previous?.application || '',
  );
  const verifiedActiveCandidates = evidence
    .filter(record => record.terminalVerification?.status === 'verified')
    .map(activeWindowCandidate)
    .filter((item): item is EvidenceCandidate => Boolean(item));
  const latestActive = currentAuthoringDocument
    ? [...verifiedActiveCandidates].reverse().find(candidate => (
        Boolean(candidate.object)
        && candidateMatchesRequestedAuthoringApplication(
          candidate,
          taskText,
          input.applicationHint || previous?.application || '',
        )
      ))
    : [...activeCandidates].reverse().find(candidate => (
        !currentWps || WPS_RE.test(`${candidate.application} ${candidate.window}`)
      ));
  const backgroundCandidates = evidence
    .flatMap(record => runningAuthoringWindowCandidates(
      record,
      taskText,
      input.applicationHint || previous?.application || '',
    ))
    .filter((candidate, index, all) => all.findIndex(item => (
      normalizedIdentity(`${item.application}|${item.object}`)
      === normalizedIdentity(`${candidate.application}|${candidate.object}`)
    )) === index);
  // The actual foreground authoring document is authoritative when present.
  // Background enumeration is a fallback and must yield exactly one distinct
  // supported document; choosing from two visible documents would guess.
  const backgroundCandidate = !latestActive && backgroundCandidates.length === 1
    ? backgroundCandidates[0]
    : null;
  const currentWindowCandidate = latestActive || backgroundCandidate;
  const ambiguousBackgroundCandidates = Boolean(
    currentAuthoringDocument
    && !latestActive
    && backgroundCandidates.length > 1,
  );
  const preferredName = displayableFileName(userFile)
    || displayableFileName(previous?.object || previous?.label || previous?.path)
    || displayableFileName(currentWindowCandidate?.object || currentWindowCandidate?.label)
    || displayableFileName(safePaths.at(-1));
  const preferredReference = userFile
    || previous?.path
    || previous?.object
    || previous?.label
    || currentWindowCandidate?.path
    || currentWindowCandidate?.object
    || currentWindowCandidate?.label
    || safePaths.at(-1)
    || preferredName;
  const discoveryCandidates = evidence
    .map(record => discoveryCandidate(record, taskText, preferredName, preferredReference, sourcePaths))
    .filter((item): item is EvidenceCandidate => Boolean(item));
  const distinctDiscoveryCandidates = discoveryCandidates.filter((candidate, index, all) => all.findIndex(item => (
    canonicalPathIdentity(item.path) === canonicalPathIdentity(candidate.path)
  )) === index);
  const latestDiscovery = distinctDiscoveryCandidates.length === 1
    ? distinctDiscoveryCandidates[0]
    : undefined;
  const ambiguousDiscoveryCandidates = distinctDiscoveryCandidates.length > 1;
  const latestDocument = [...documentCandidates].reverse().find(candidate => (
    !preferredName
    || !candidate.object
    || targetReferenceMatches(candidate.path || candidate.object, preferredReference)
  ));

  let target: TaskTargetAnchorV1;
  const priorCorrection = previous?.source === 'user_correction' ? previous : null;
  const authoritativeCorrection = userFile
    ? mergeTarget({
        label: fileName(userFile),
        object: fileName(userFile),
        path: concreteTargetPath(userFile) ? userFile : '',
        application: input.applicationHint || previous?.application || '',
        status: 'candidate',
        source: 'user_correction',
      }, previous)
    : priorCorrection
      ? mergeTarget(priorCorrection)
      : null;
  const windowMatchesCorrection = Boolean(
    authoritativeCorrection
    && currentWindowCandidate?.object
    && targetReferenceMatches(
      currentWindowCandidate.path || currentWindowCandidate.object,
      authoritativeCorrection.path || authoritativeCorrection.object || authoritativeCorrection.label,
    ),
  );
  if (authoritativeCorrection) {
    const matchingReceipt = latestDiscovery || latestDocument || (windowMatchesCorrection ? currentWindowCandidate : null);
    target = matchingReceipt
      ? mergeTarget(matchingReceipt, authoritativeCorrection)
      : authoritativeCorrection;
    target.application = target.application || (currentWps ? 'WPS' : '');
    if (windowMatchesCorrection && currentWindowCandidate) target.window = currentWindowCandidate.window;
  } else if (currentAuthoringDocument && currentWindowCandidate) {
    const durableExactTarget = previous
      && concreteTargetPath(previous.path || '')
      && targetReferenceMatches(
        previous.path || previous.object || previous.label || '',
        currentWindowCandidate.object,
      )
      ? previous
      : null;
    target = mergeTarget(
      latestDiscovery || latestDocument || durableExactTarget || currentWindowCandidate,
      currentWindowCandidate,
    );
    target.application = currentWindowCandidate.application;
    target.window = currentWindowCandidate.window || target.window;
    target.source = latestDiscovery?.source || latestDocument?.source || currentWindowCandidate.source;
  } else if (
    currentAuthoringDocument
    && previous
    && concreteTargetPath(previous.path || '')
    && !isUnconfirmedRuntimeCandidate(previous.path || previous.label || '', taskText)
  ) {
    target = mergeTarget(previous);
  } else if (currentAuthoringDocument) {
    const requestedApplication = requestedAuthoringApplication(
      taskText,
      input.applicationHint || previous?.application || '',
    );
    target = mergeTarget({
      application: requestedApplication === 'any'
        ? input.applicationHint || previous?.application || ''
        : requestedApplication,
      status: 'unresolved',
      source: 'unknown',
    });
  } else if (latestDiscovery || latestDocument) {
    target = mergeTarget(latestDiscovery || latestDocument!, previous);
  } else if (previous && !isUnconfirmedRuntimeCandidate(previous.path || previous.label || '', taskText)) {
    target = mergeTarget(previous);
  } else if (safePaths.length) {
    const sourcePath = safePaths.at(-1)!;
    target = mergeTarget({
      label: displayableFileName(sourcePath),
      object: displayableFileName(sourcePath),
      path: sourcePath,
      application: input.applicationHint || '',
      status: displayableFileName(sourcePath) ? 'confirmed' : 'unresolved',
      source: 'durable_state',
    });
  } else {
    target = mergeTarget({
      application: input.applicationHint || previous?.application || (currentWps ? 'WPS' : ''),
      status: 'unresolved',
      source: 'unknown',
    });
  }

  const rejectedTargets = unique([...(input.rejectedTargets || []), ...capsuleRejectedTargets(taskText)], 12);
  if (rejectedByIdentity(target, rejectedTargets)) target.status = 'rejected';
  if (isUnconfirmedRuntimeCandidate(target.path || target.object || target.label, taskText)) {
    ignoredCandidates.push(target.path || target.object || target.label);
    target = mergeTarget({
      application: target.application || (currentWps ? 'WPS' : ''),
      window: currentWindowCandidate?.window || '',
      status: 'unresolved',
      source: 'unknown',
    });
  }

  const finalName = displayableFileName(target.object || target.label || target.path);
  if (!finalName && target.status !== 'rejected' && isFileTargetTask(taskText)) {
    target.status = 'unresolved';
  }
  // Window provenance and path provenance are independent. Once bounded
  // discovery resolves a path, target.source legitimately changes to the
  // discovery receipt; that must not erase the already verified native
  // window. Conversely, a concrete path alone cannot prove that it is the
  // document currently open in the requested authoring application.
  const windowVerified = Boolean(
    currentAuthoringDocument
    && currentWindowCandidate
    && supportedAuthoringApplication(currentWindowCandidate.application)
    && supportedAuthoringApplication(target.application) === supportedAuthoringApplication(currentWindowCandidate.application)
    && targetReferenceMatches(
      target.path || target.object || target.label,
      currentWindowCandidate.object || currentWindowCandidate.label,
    )
    && !ambiguousDiscoveryCandidates
    && !(currentWindowCandidate.source === 'running_window' && ambiguousBackgroundCandidates)
    && target.status !== 'rejected',
  );
  const pathResolved = Boolean(
    target.status !== 'rejected'
    && concreteTargetPath(target.path)
    && !ambiguousDiscoveryCandidates,
  );
  const analysisReady = target.status !== 'rejected'
    && Boolean(finalName)
    && !ambiguousDiscoveryCandidates
    && Boolean(pathResolved || target.source === 'document_interface');
  const nextAction: TaskTargetAnchorProjectionV1['nextAction'] = analysisReady
    ? 'analyze'
    : windowVerified
      ? 'search_bounded_roots'
      : finalName && target.source === 'user_correction'
        ? 'search_bounded_roots'
      : currentAuthoringDocument
        ? 'inspect_active_document'
        : finalName
          ? 'search_bounded_roots'
          : 'clarify_target';
  // This is returned as structured preflight data; channels may localize it later.
  const clarification = nextAction === 'inspect_active_document'
    ? CN_TASK_TARGET_ANCHOR_MESSAGES.inspectActiveDocument
    : finalName
      ? CN_TASK_TARGET_ANCHOR_MESSAGES.locateNamedFile(finalName)
      : CN_TASK_TARGET_ANCHOR_MESSAGES.unresolvedTarget;

  return {
    target: { ...target, label: finalName || target.label, object: finalName || target.object },
    allowedSearchRoots: allowedTaskSearchRoots(taskText, sourcePaths),
    windowVerified,
    pathResolved,
    analysisReady,
    nextAction,
    clarification,
    ignoredCandidates: unique(ignoredCandidates, 8),
  };
}

/**
 * Shared chat/voice/task preflight for real file targets. It uses only the
 * current user contract and server-owned tool records; assistant prose is not
 * target evidence.
 */
export function guardTaskTargetToolCall(input: {
  taskText: string;
  toolName: string;
  arguments?: Record<string, unknown>;
  toolRecords?: TaskTargetEvidenceRecord[];
  acceptedTaskTarget?: AcceptedTaskTarget;
  /** Registry-owned capability metadata says this call can read a local file. */
  enforceStructuredFileRead?: boolean;
  /** Registry-owned capability metadata says this call can execute a process. */
  forbidUnstructuredExecution?: boolean;
  /** Set only from the registry-owned, I/O-free QuickJS capability. */
  isolatedCalculation?: boolean;
  /** Exact registered CLI capability plus an explicit user delegation, set by execution_engine only. */
  externalCliDelegation?: boolean;
}): TaskTargetToolCallGuardResult {
  if (!isFileTargetTask(input.taskText) && !input.acceptedTaskTarget) return { allowed: true, reason: '' };
  const toolName = compact(input.toolName, 160);
  // Authoring a reviewed, isolated draft is not execution against the example
  // business file. Only this fixed handler is exempt; reads and general script
  // tools below still require the normal target, and registry privacy/approval
  // and installation checks remain authoritative.
  const authoringIntent = classifySkillAuthoringIntent(primaryTaskText(input.taskText));
  if (toolName === 'generate_skill' && authoringIntent === 'generate') {
    return { allowed: true, reason: '' };
  }
  const args = input.arguments || {};
  const target = callTarget(args);
  const requestedRead = DOCUMENT_INTERFACE_RE.test(toolName) && !CURRENT_DOCUMENT_INTERFACE_RE.test(toolName) && concreteTargetPath(target)
    ? affirmativeActionClauses(primaryTaskText(input.taskText)).find(probe => {
        const intent = normalizeActionIntent(probe);
        return intent.rule === 'explicit-local-artifact-read' && canonicalPathIdentity(intent.target || '') === canonicalPathIdentity(target);
      }) : undefined;
  const projection = buildTaskTargetAnchorProjection({
    taskText: requestedRead || input.taskText,
    evidence: input.toolRecords || [],
    previousTarget: requestedRead ? undefined : input.acceptedTaskTarget?.target,
  });
  const currentWps = prefersCurrentWpsDocument(input.taskText, projection.target.application);
  const currentAuthoringDocument = prefersCurrentAuthoringDocument(
    input.taskText,
    projection.target.application,
  );
  const hasVerifiedActiveAuthoringDocument = (input.toolRecords || [])
    .filter(record => record.terminalVerification?.status === 'verified')
    .map(activeWindowCandidate)
    .some(candidate => Boolean(
      candidate
      && candidate.object
      && candidateMatchesRequestedAuthoringApplication(
        candidate,
        input.taskText,
        projection.target.application,
      ),
    ));
  const hasVerifiedAuthoringDocumentWindow = projection.windowVerified;
  const hasTrustedCurrentAuthoringPath = Boolean(
    currentAuthoringDocument
    && projection.windowVerified
    && projection.pathResolved
    && projection.analysisReady
    && concreteTargetPath(projection.target.path),
  );

  // This reviewed adapter owns workspace/anchor binding, provider identity,
  // process lifecycle and output verification. It is not arbitrary shell text.
  // Registry authorization, privacy and confirmation remain mandatory.
  if (input.externalCliDelegation === true && toolName === 'external_cli_run') {
    return { allowed: true, reason: '', anchor: projection };
  }
  if (input.forbidUnstructuredExecution || (UNSTRUCTURED_FILE_ACCESS_TOOL_RE.test(toolName)
    && !(toolName === 'code_execution' && input.isolatedCalculation === true))) {
    return blocked(
      'unstructured_file_access_forbidden',
      `Target anchor blocked ${toolName}: file-target work cannot use a general command, script, interpreter, or unstructured desktop executor. Use a structured file/document capability bound to the canonical target.`,
      projection,
      projection.clarification,
    );
  }

  if (DISCOVERY_TOOLS.has(toolName.toLowerCase())) {
    if (currentAuthoringDocument && !hasVerifiedAuthoringDocumentWindow) {
      return blocked(
        'active_document_required',
        `Target anchor blocked ${toolName}: verify exactly one supported WPS/Office document window with desktop_running_processes or desktop_active_window before searching for a file described as the current document.`,
        projection,
        projection.clarification,
      );
    }
    if (!target) {
      return blocked(
        'search_scope_required',
        `${toolName} requires an explicit bounded directory. The process working directory is never an implicit user-material source.`,
        projection,
        projection.clarification,
      );
    }
    if (!isAllowedTaskSearchDirectory(target, input.taskText)) {
      return blocked(
        isUnconfirmedRuntimeCandidate(target, input.taskText)
          ? 'runtime_candidate_forbidden'
          : 'search_scope_forbidden',
        `${toolName} is limited to Desktop, Documents, Downloads, or a directory explicitly named by the user. Rejected directory: ${target}`,
        projection,
        projection.clarification,
      );
    }
    return { allowed: true, reason: '', anchor: projection };
  }

  if (toolName === 'desktop_capture_screen' && currentWps && !hasVerifiedActiveAuthoringDocument) {
    return blocked(
      'active_document_required',
      'Observe desktop_active_window and verify the current WPS document before capturing or interpreting its screen.',
      projection,
      projection.clarification,
    );
  }

  if (toolName === 'desktop_path_info' && currentAuthoringDocument) {
    const anchoredPath = projection.target.path;
    if (!concreteTargetPath(anchoredPath)) {
      return blocked(
        'target_unresolved',
        'Path verification is blocked until bounded discovery resolves the one anchored WPS/Office document to an exact path.',
        projection,
        projection.clarification,
      );
    }
    if (target && !targetMatchesAnchor(target, projection.target) && !(
      hasTrustedCurrentAuthoringPath
      && targetKeepsAnchoredObjectIdentity(target, projection.target)
    )) {
      return blocked(
        'target_mismatch',
        `Path verification target does not match the anchored file ${projection.target.object}: ${target}`,
        projection,
        projection.clarification,
      );
    }
    return {
      allowed: true,
      reason: '',
      normalizedArguments: { ...args, target: anchoredPath },
      anchor: projection,
    };
  }

  if (input.enforceStructuredFileRead || DOCUMENT_INTERFACE_RE.test(toolName)) {
    if (target && isVerifiedProducedDocumentTarget(target, input.toolRecords || [])) {
      return { allowed: true, reason: '', normalizedArguments: args, anchor: projection };
    }
    if (input.acceptedTaskTarget?.target.status === 'unresolved' && !input.acceptedTaskTarget.target.path) {
      return blocked('target_unresolved', 'The current file reference is ambiguous or names an unbound produced file. Ask for its exact path; do not substitute the previous source.', projection, CN_TASK_TARGET_ANCHOR_MESSAGES.unresolvedTarget);
    }
    const directVerifiedWpsDocumentRead = Boolean(
      currentWps
      && projection.target.source === 'active_window'
      && projection.target.object
      && CURRENT_DOCUMENT_INTERFACE_RE.test(toolName),
    );
    if (!projection.analysisReady && !directVerifiedWpsDocumentRead) {
      return blocked(
        projection.nextAction === 'inspect_active_document' ? 'active_document_required' : 'target_unresolved',
        `Document analysis is blocked until the target has a displayable final filename and trusted application/window/object/path anchor. ${projection.clarification}`,
        projection,
        projection.clarification,
      );
    }
    const trustedAnchoredArguments = hasTrustedCurrentAuthoringPath
      && targetKeepsAnchoredObjectIdentity(target, projection.target)
      ? argumentsWithAnchoredDocumentPath(toolName, args, projection.target.path)
      : null;
    if (trustedAnchoredArguments) {
      return {
        allowed: true,
        reason: '',
        normalizedArguments: trustedAnchoredArguments,
        anchor: projection,
      };
    }
    if (target) {
      if (isUnconfirmedRuntimeCandidate(target, input.taskText)) {
        return blocked(
          'runtime_candidate_forbidden',
          `Document analysis rejected an inferred runtime/project artifact: ${target}`,
          projection,
          projection.clarification,
        );
      }
      if (!targetMatchesAnchor(target, projection.target)) {
        return blocked(
          'target_mismatch',
          `Document analysis target does not match the anchored file ${projection.target.object || projection.target.label}: ${target}. Read the anchored source path instead: ${projection.target.path || '(resolve the exact source from the accepted task anchor)'}. Save-as destinations are not input files.`,
          projection,
          projection.clarification,
        );
      }
      const anchoredPath = projection.target.path;
      const normalizedArguments = concreteTargetPath(anchoredPath)
        ? argumentsWithAnchoredDocumentPath(toolName, args, anchoredPath)
        : null;
      if (normalizedArguments) {
        return {
          allowed: true,
          reason: '',
          normalizedArguments,
          anchor: projection,
        };
      }
    } else {
      const anchoredPath = projection.target.path;
      const normalizedArguments = concreteTargetPath(anchoredPath)
        ? argumentsWithAnchoredDocumentPath(toolName, args, anchoredPath)
        : null;
      if (normalizedArguments) {
        return {
          allowed: true,
          reason: '',
          normalizedArguments,
          anchor: projection,
        };
      }
      if (!directVerifiedWpsDocumentRead) {
        return blocked(
          'target_unresolved',
          `Document analysis requires the anchored path ${projection.target.path || projection.target.object || projection.target.label}.`,
          projection,
          projection.clarification,
        );
      }
    }
  }

  if (toolName === 'desktop_open' && target && displayableFileName(target)) {
    const rejected = capsuleRejectedTargets(input.taskText);
    if (rejected.some(item => normalizedIdentity(item) === normalizedIdentity(target)
      || normalizedIdentity(fileName(item)) === normalizedIdentity(fileName(target)))) {
      return blocked(
        'rejected_target',
        `The user already rejected this exact file target; do not open it again: ${target}`,
        projection,
        projection.clarification,
      );
    }
    if (projection.target.object && !targetMatchesAnchor(target, projection.target)) {
      return blocked(
        'target_mismatch',
        `The requested open target does not match the anchored file ${projection.target.object}: ${target}`,
        projection,
        projection.clarification,
      );
    }
  }

  return { allowed: true, reason: '', anchor: projection };
}
