import { formatConversationActionTaskStatus, type ConversationActionContinuationState } from "../../cognition/action_continuation";
import { normalizeActionIntent } from "../../cognition/normalized_action_intent";
import { conversationTaskStatusOwnsExecutionLease } from "../../cognition/task_execution_ledger";
import { CN_ACTION_LEDGER_MESSAGES } from "../../regions/messages/action_ledger_messages";
import { detectLanguage } from "../../utils/language";
import type { ConversationActionTaskRow, ConversationActionReceiptRow } from './contracts';
import { parseObject } from './serialization';
import { findConversationActionTask, conversationActionStateFromTask } from './queries';
export function formatEnglishPreviousActionLedgerStatus(task: ConversationActionTaskRow, state: ConversationActionContinuationState, taskReceipts: ConversationActionReceiptRow[], query = ''): string {
    const receipt = taskReceipts
        .map((candidate, insertionOrder) => ({ candidate, insertionOrder }))
        .sort((left, right) => (right.candidate.createdAt.localeCompare(left.candidate.createdAt)
        || right.insertionOrder - left.insertionOrder))[0]?.candidate;
    const envelope = parseObject(receipt?.envelope);
    const result = parseObject(envelope.result);
    const expectation = parseObject(result.expectation);
    const verification = parseObject(result.verification);
    const envelopeVerification = parseObject(envelope.verification);
    const action = String(result.action
        || expectation.action
        || receipt?.toolName
        || task.operation
        || task.intentKind
        || '').trim();
    const target = String(result.target
        || expectation.target
        || receipt?.targetIdentity
        || task.target
        || state.appTarget
        || '').trim();
    const section = String(result.section || expectation.section || '').trim();
    const processName = String(result.processName || result.process_name || '').trim();
    const windowTitle = String(result.windowTitle
        || result.window_title
        || result.title
        || '').trim();
    const asksForWindowDetails = /\b(?:observed\s+window|window\s+title|actual\s+process)\b/iu.test(query);
    const verificationStatus = String(verification.status
        || envelopeVerification.status
        || (receipt?.outcome === 'verified_success' ? 'verified' : receipt?.outcome || '')).trim();
    const matchedEvidence = Array.isArray(verification.matched)
        ? verification.matched
            .map(value => String(value || '').replace(/\s+/gu, ' ').trim().slice(0, 240))
            .filter(Boolean)
            .slice(0, 8)
        : [];
    const verificationReason = String(envelopeVerification.reason || '').replace(/\s+/gu, ' ').trim().slice(0, 500);
    const blocker = String(task.blocker || state.latestBlocker || '')
        .replace(/^[A-Za-z0-9_.:-]+:\s*/, '')
        .replace(/\s+/gu, ' ')
        .trim()
        .slice(0, 500);
    const durableVerified = receipt?.outcome === 'verified_success' && verificationStatus === 'verified';
    const finalStatus = task.status === 'completed'
        ? durableVerified
            ? 'completed (durable receipt verified)'
            : state.completionSource === 'user_observation'
                ? 'completed (confirmed by user observation)'
                : 'completed (no verified terminal receipt recorded)'
        : task.status === 'waiting_confirmation'
            ? 'waiting for confirmation'
            : task.status === 'blocked'
                ? `blocked${blocker ? ` — ${blocker}` : ''}`
                : task.status === 'cancelled'
                    ? `cancelled${blocker ? ` — ${blocker}` : ''}`
                    : `${task.status} (no verified terminal receipt yet)`;
    return [
        `Executed action: ${action || 'not recorded'}`,
        target ? `Target: ${target}` : '',
        section ? `Target section: ${section}` : '',
        asksForWindowDetails && processName ? `Observed process: ${processName}` : '',
        asksForWindowDetails ? `Observed window title: ${windowTitle || 'not recorded'}` : '',
        `Verification status: ${verificationStatus || 'not recorded'}`,
        matchedEvidence.length
            ? `Verification evidence: ${matchedEvidence.join('; ')}`
            : verificationReason
                ? `Verification evidence: ${verificationReason}`
                : '',
        receipt ? '' : 'Durable receipt: none recorded',
        `Final status: ${finalStatus}`,
    ].filter(Boolean).join('\n');
}
export function formatConversationActionLedgerStatus(db: any, input: {
    conversationId: string;
    userId: string;
    query?: string;
    taskId?: string;
}): string | null {
    const task = findConversationActionTask(db, input);
    const state = conversationActionStateFromTask(task);
    if (!state)
        return null;
    const query = String(input.query || '');
    const taskReceipts = task
        ? (db.conversationActionReceipts as ConversationActionReceiptRow[])
            .filter(receipt => receipt.taskId === task.id)
        : [];
    const activeRequestId = String(state.activeRequestId || task?.activeRequestId || '').trim();
    const executionActive = Boolean(task
        && activeRequestId
        && conversationTaskStatusOwnsExecutionLease(task.status)
        && (db.conversationActionTurns || []).some((turn: any) => {
            if (turn.conversationId !== input.conversationId
                || turn.userId !== input.userId
                || turn.taskId !== task.id
                || turn.requestId !== activeRequestId
                || !['accepted', 'leased'].includes(String(turn.status || '')))
                return false;
            if (turn.status === 'accepted')
                return true;
            const expiresAt = Date.parse(String(turn.leaseExpiresAt || ''));
            return Number.isFinite(expiresAt) && expiresAt > Date.now();
        }));
    const formatAuthoritativeStatus = () => formatConversationActionTaskStatus(state, {
        executionActive,
    });
    const normalizedQueryIntent = normalizeActionIntent(query);
    const asksForPreviousAction = normalizedQueryIntent.kind === 'status_query'
        && normalizedQueryIntent.target === 'previous_action';
    const asksForArtifactReceiptChain = /(?:\u5199\u5165|\u56de\u8bfb|\u6700\u7ec8\u72b6\u6001)|\b(?:written|read\s*back|final\s+status)\b/iu.test(query);
    if (task && asksForArtifactReceiptChain) {
        const writeIndex = taskReceipts.map(receipt => (receipt.outcome === 'verified_success'
            && /^(?:write_file|create_docx|create_xlsx|create_ppt|create_pdf|modify_docx|modify_xlsx)$/i.test(receipt.toolName)
            && /(?:^[A-Za-z]:[\\/]|^\/).+\.[A-Za-z0-9]{1,12}$/u.test(receipt.targetIdentity))).lastIndexOf(true);
        const writeReceipt = writeIndex >= 0 ? taskReceipts[writeIndex] : undefined;
        const asksForSourceRead = /(?:\u6e90\u6587\u4ef6\u8bfb\u53d6|\u8bfb\u53d6\u6e90\u6587\u4ef6|\u4e09\u6b65|source\s+file\s+read)/iu.test(query);
        const sourceReadReceipt = writeReceipt && writeIndex > 0
            ? [...taskReceipts.slice(0, writeIndex)].reverse().find(receipt => (receipt.outcome === 'verified_success'
                && /^(?:read_file|read_docx|read_xlsx|read_pdf|extract_document_text)$/i.test(receipt.toolName)
                && Boolean(receipt.targetIdentity)
                && receipt.targetIdentity.toLowerCase() !== writeReceipt.targetIdentity.toLowerCase()))
            : undefined;
        const readReceipt = writeReceipt
            ? taskReceipts.slice(writeIndex + 1).find(receipt => (receipt.outcome === 'verified_success'
                && /^(?:read_file|read_docx|read_xlsx|read_pdf|extract_document_text)$/i.test(receipt.toolName)
                && receipt.targetIdentity.toLowerCase() === writeReceipt.targetIdentity.toLowerCase()))
            : undefined;
        if (writeReceipt) {
            const path = writeReceipt?.targetIdentity || state.sourcePaths?.[0] || task.target;
            const finalStatus = task.status === 'completed' && writeReceipt
                ? CN_ACTION_LEDGER_MESSAGES.completedVerified : formatAuthoritativeStatus();
            const readbackEnvelope = readReceipt ? parseObject(readReceipt.envelope) : {};
            const readbackText = typeof readbackEnvelope.result === 'string'
                ? readbackEnvelope.result.replace(/\r\n/g, '\n')
                : '';
            const readbackMetadata = readbackEnvelope.result && typeof readbackEnvelope.result === 'object'
                ? readbackEnvelope.result as Record<string, any>
                : {};
            const asksEncoding = /(?:\u7f16\u7801|encoding)/iu.test(query);
            const asksLineCount = /(?:\u603b\u884c\u6570|\u884c\u6570)|\bline\s*count\b/iu.test(query);
            const lineCount = Number(readbackMetadata.lineCount) > 0
                ? Number(readbackMetadata.lineCount)
                : readbackText
                    ? readbackText.replace(/\n$/, '').split('\n').length
                    : 0;
            return [
                CN_ACTION_LEDGER_MESSAGES.path(path || CN_ACTION_LEDGER_MESSAGES.notRecorded),
                asksForSourceRead
                    ? CN_ACTION_LEDGER_MESSAGES.sourceRead(sourceReadReceipt ? CN_ACTION_LEDGER_MESSAGES.verifiedSource(sourceReadReceipt.toolName, sourceReadReceipt.targetIdentity) : CN_ACTION_LEDGER_MESSAGES.unverified) : '',
                CN_ACTION_LEDGER_MESSAGES.write(writeReceipt ? CN_ACTION_LEDGER_MESSAGES.verifiedTool(writeReceipt.toolName) : CN_ACTION_LEDGER_MESSAGES.unverified),
                CN_ACTION_LEDGER_MESSAGES.readAfterWrite(readReceipt ? CN_ACTION_LEDGER_MESSAGES.readbackTool(readReceipt.toolName) : CN_ACTION_LEDGER_MESSAGES.no),
                asksEncoding ? CN_ACTION_LEDGER_MESSAGES.encoding(writeReceipt.toolName === 'write_file' && readReceipt ? String(readbackMetadata.encoding || 'UTF-8') : CN_ACTION_LEDGER_MESSAGES.receiptNotRecorded) : '',
                asksLineCount ? CN_ACTION_LEDGER_MESSAGES.lineCount(readReceipt && lineCount ? lineCount : CN_ACTION_LEDGER_MESSAGES.receiptNotRecorded) : '',
                CN_ACTION_LEDGER_MESSAGES.finalStatus(finalStatus),
            ].filter(Boolean).join('\n');
        }
    }
    // A receipt question such as “what did you just open?” should answer the
    // concrete target directly. The generic ledger sentence is useful for task
    // progress, but sounds unnatural and obscures the requested fact here.
    // i18n-allow: Multilingual recent desktop-open receipt recognition.
    const asksForWpsDocumentDetails = /(?:\bWPS\b|\u6b63\u6587\u9a8c\u8bc1|\u4fdd\u5b58\u72b6\u6001|\u6587\u6863\u540d)|\b(?:wps|body\s+verification|save\s+status|document\s+name)\b/iu.test(query);
    if (task && asksForWpsDocumentDetails) {
        const wpsReceipt = [...taskReceipts].reverse().find(receipt => (receipt.toolName === 'wps_create_document_with_text'
            && receipt.outcome === 'verified_success'));
        if (wpsReceipt) {
            const result = parseObject(parseObject(wpsReceipt.envelope).result);
            const documentName = String(result.documentName || '').trim();
            const windowTitle = String(result.windowTitle || '').trim();
            const processName = String(result.processName || '').trim();
            const processId = Number(result.processId) || 0;
            const exactTextMatch = result.exactTextMatch === true;
            const charactersRequested = Number(result.charactersRequested) || 0;
            const charactersReadBack = Number(result.charactersReadBack) || 0;
            const saved = result.saved === true;
            const savePath = String(result.savePath || '').trim();
            return [
                CN_ACTION_LEDGER_MESSAGES.document(documentName || CN_ACTION_LEDGER_MESSAGES.receiptNotRecorded),
                CN_ACTION_LEDGER_MESSAGES.window(windowTitle || CN_ACTION_LEDGER_MESSAGES.receiptNotRecorded),
                CN_ACTION_LEDGER_MESSAGES.process(processName || CN_ACTION_LEDGER_MESSAGES.receiptNotRecorded, processId ? ` (PID ${processId})` : ''),
                CN_ACTION_LEDGER_MESSAGES.bodyVerification(exactTextMatch ? CN_ACTION_LEDGER_MESSAGES.verifiedBody(charactersRequested, charactersReadBack) : CN_ACTION_LEDGER_MESSAGES.unverified),
                CN_ACTION_LEDGER_MESSAGES.saveStatus(saved ? CN_ACTION_LEDGER_MESSAGES.savedPath(savePath ? `\uff08${savePath}\uff09` : '') : CN_ACTION_LEDGER_MESSAGES.notSaved),
                CN_ACTION_LEDGER_MESSAGES.finalStatus(exactTextMatch
                    ? CN_ACTION_LEDGER_MESSAGES.completedVerified : formatAuthoritativeStatus()),
            ].join('\n');
        }
    }
    const asksRecentOpenedTarget = /(?:\u521a\u624d|\u521a\u521a|\u4e0a\u4e00\u8f6e|\u4e0a\u6b21).{0,20}\u6253\u5f00(?:\u4e86)?(?:\u4ec0\u4e48|\u54ea\u4e2a|\u54ea\u4e9b)|\bwhat\s+did\s+(?:you|lumi)\s+(?:just\s+)?open\b/iu.test(query);
    if (asksRecentOpenedTarget && state.status === 'completed' && task) {
        const openReceipt = [...(db.conversationActionReceipts as ConversationActionReceiptRow[])]
            .reverse()
            .find(receipt => (receipt.taskId === task.id
            && receipt.toolName === 'desktop_open'
            && receipt.outcome === 'verified_success'
            && Boolean(receipt.targetIdentity)));
        const target = openReceipt?.targetIdentity || state.appTarget || task.target;
        if (target)
            return CN_ACTION_LEDGER_MESSAGES.openedTarget(target);
    }
    const asksForDesktopReceiptDetails = /(?:\u5b9e\u9645\u8fdb\u7a0b|\u7a97\u53e3\u6807\u9898|\u7cbe\u786e\u5339\u914d)|\b(?:actual\s+process|window\s+title|exact\s+(?:target\s+)?match)\b/iu.test(query);
    if (asksForDesktopReceiptDetails && task) {
        const openReceipt = [...taskReceipts].reverse().find(receipt => (receipt.toolName === 'desktop_open'
            && receipt.outcome === 'verified_success'));
        const activeWindowReceipt = [...taskReceipts].reverse().find(receipt => (receipt.toolName === 'desktop_active_window'
            && receipt.outcome === 'verified_success'));
        if (openReceipt) {
            const openResult = parseObject(parseObject(openReceipt.envelope).result);
            const activeWindowResult = activeWindowReceipt
                ? parseObject(parseObject(activeWindowReceipt.envelope).result)
                : {};
            const actualTarget = parseObject(openResult.actualTarget);
            const processName = String(activeWindowResult.process_name
                || activeWindowResult.processName
                || actualTarget.processName
                || actualTarget.process_name
                || '').trim();
            const windowTitle = String(activeWindowResult.title
                || actualTarget.title
                || '').trim();
            const targetMatched = openResult.targetMatched === true
                && Boolean(processName)
                && Boolean(windowTitle);
            return [
                CN_ACTION_LEDGER_MESSAGES.exactTarget(state.appTarget || task.target || openReceipt.targetIdentity || CN_ACTION_LEDGER_MESSAGES.notRecorded),
                CN_ACTION_LEDGER_MESSAGES.actualProcess(processName || CN_ACTION_LEDGER_MESSAGES.receiptNotRecorded),
                CN_ACTION_LEDGER_MESSAGES.actualWindowTitle(windowTitle || CN_ACTION_LEDGER_MESSAGES.receiptNotRecorded),
                CN_ACTION_LEDGER_MESSAGES.exactMatch(targetMatched ? CN_ACTION_LEDGER_MESSAGES.exactMatchVerified : CN_ACTION_LEDGER_MESSAGES.exactMatchIncomplete),
                CN_ACTION_LEDGER_MESSAGES.finalStatus(targetMatched && task.status === 'completed' ? CN_ACTION_LEDGER_MESSAGES.completedVerified : formatAuthoritativeStatus()),
            ].join('\n');
        }
    }
    if (task && asksForPreviousAction && detectLanguage(query) === 'en') {
        return formatEnglishPreviousActionLedgerStatus(task, state, taskReceipts, query);
    }
    const latestClientActionReceipt = [...taskReceipts].reverse().find(receipt => (receipt.toolName === 'client_action'));
    const verifiedClientActionReceipt = latestClientActionReceipt?.outcome === 'verified_success'
        ? latestClientActionReceipt
        : undefined;
    const asksForClientNavigationDetails = /(?:\u6267\u884c\u52a8\u4f5c|\u76ee\u6807\u9875\u9762|\u9a8c\u8bc1\u72b6\u6001)|\b(?:client\s+action|target\s+(?:page|surface)|verification\s+status)\b/iu.test(query)
        || normalizedQueryIntent.kind === 'status_query'
            && normalizedQueryIntent.target === 'previous_action';
    if (asksForClientNavigationDetails && (task?.intentKind === 'client_navigation' || verifiedClientActionReceipt)) {
        const clientReceipt = verifiedClientActionReceipt;
        if (clientReceipt) {
            const envelope = parseObject(clientReceipt.envelope);
            const result = parseObject(envelope.result);
            const verification = parseObject(result.verification);
            const action = String(result.action || parseObject(result.expectation).action || '').trim();
            const target = String(result.target || parseObject(result.expectation).target || task.target || state.appTarget || '').trim();
            const section = String(result.section || parseObject(result.expectation).section || '').trim();
            const verificationStatus = String(verification.status || parseObject(envelope.verification).status || '').trim();
            const matchedEvidence = Array.isArray(verification.matched)
                ? verification.matched.map(value => String(value || '').trim()).filter(Boolean).slice(0, 8)
                : [];
            return [
                CN_ACTION_LEDGER_MESSAGES.executedAction(action || CN_ACTION_LEDGER_MESSAGES.receiptNotRecorded),
                CN_ACTION_LEDGER_MESSAGES.targetPage(target || CN_ACTION_LEDGER_MESSAGES.receiptNotRecorded),
                section ? CN_ACTION_LEDGER_MESSAGES.targetSection(section) : '',
                CN_ACTION_LEDGER_MESSAGES.verificationStatus(verificationStatus || CN_ACTION_LEDGER_MESSAGES.receiptNotRecorded),
                matchedEvidence.length ? CN_ACTION_LEDGER_MESSAGES.verificationEvidence(matchedEvidence) : '',
                CN_ACTION_LEDGER_MESSAGES.finalStatus(task.status === 'completed' && verificationStatus === 'verified'
                    ? CN_ACTION_LEDGER_MESSAGES.completedVerified : formatAuthoritativeStatus()),
            ].filter(Boolean).join('\n');
        }
    }
    const status = formatAuthoritativeStatus();
    // i18n-allow: Multilingual artifact-path input recognition; not display copy.
    const asksForArtifactPath = /(?:产物|文件).{0,10}(?:路径|位置|在哪)|(?:路径|位置|在哪).{0,10}(?:产物|文件)|\b(?:artifact|file|output)\s+(?:path|location)\b|\bwhere\s+is\s+(?:the\s+)?(?:artifact|file|output)\b/iu.test(String(input.query || ''));
    if (!asksForArtifactPath || state.status !== 'completed' || !task)
        return status;
    const producerReceipt = [...(db.conversationActionReceipts as ConversationActionReceiptRow[])]
        .reverse()
        .find(receipt => (receipt.taskId === task.id
        && receipt.outcome === 'verified_success'
        && /^(?:write_file|create_docx|create_xlsx|create_ppt|create_pdf|modify_docx|modify_xlsx|cad_generate_dxf)$/i.test(receipt.toolName)
        && /(?:^[A-Za-z]:[\\/]|^\/).+\.[A-Za-z0-9]{1,12}$/u.test(receipt.targetIdentity)));
    if (!producerReceipt)
        return status;
    return CN_ACTION_LEDGER_MESSAGES.artifactPath(status, producerReceipt.targetIdentity);
}
