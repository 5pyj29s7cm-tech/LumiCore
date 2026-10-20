import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildActionContract } from '../server/cognition/action_contract';
import { buildArtifactRetrievalContract } from '../server/cognition/contracts/artifact_contracts';
import { hasCompletedCoreAction } from '../server/llm/tool_loop/projection';
import { finalizeLumiResponse } from '../server/cognition/result_finalizer';
import type { ToolExecutionRecord } from '../server/tools/types';

const projectId = 'a590fef2-1d8f-4cea-a2b6-6a3ed5567e6a';
const actualRequest = '请把已有聊天唱歌工程 a590fef2-1d8f-4cea-a2b6-6a3ed5567e6a（第23版，作品“律师，先别替我气·完整剧情对唱”）已经保存的聊天记录版120秒视频，以可播放或下载的视频附件发在这里。只读取并取回既有成片，不要重新生成、渲染、导出，不要修改对白、歌曲、工程、模板或任何素材文件。找不到或当前成片已过期就明确说明，不要编造附件。';
const base = `请把已有工程 ${projectId} 第23版的视频作为附件返回这里`;
const identity = { requestId: 'retrieval-current-request', taskId: 'retrieval-current-task' };
function fixture(): ToolExecutionRecord {
  const outputPath = path.join(process.env.LUMI_DATA_DIR!, 'retrieval-current.mp4');
  const bytes = Buffer.from('owned existing artifact fixture'); fs.mkdirSync(path.dirname(outputPath), { recursive: true }); fs.writeFileSync(outputPath, bytes);
  return { ...identity, name: 'chat_song_read', arguments: { projectId, revision: 23, includeOutput: true },
    result: JSON.stringify({ ok: true, verified: true, status: 'retrieved', projectId, revision: 23, selectedStyle: 'chat', outputPath,
      artifacts: [{ type: 'video', path: outputPath, size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') }] }),
    terminalVerification: { status: 'verified', strategy: 'state_diff', reason: 'Owned artifact identity and file hash verified' },
    capability: { capabilityId: 'creative.chat_song_read', lane: 'media', operation: 'observe', risk: 'low',
      sideEffects: [{ type: 'local_read', scope: 'owned output', reversible: true }], verification: { strategy: 'state_diff', required: true,
        requiredFields: ['ok', 'verified'], successStatuses: ['read', 'retrieved'], successSignals: [], limitations: [] } } };
}

describe('existing artifact handoff is not new production', () => {
  it('accepts the exact real request with past saved state and a downloadable local attachment', () => {
    expect(buildArtifactRetrievalContract(actualRequest)).toMatchObject({ kind: 'artifact_work', artifactMode: 'retrieve', artifactTarget: { id: projectId, revision: 23 } });
    const record = fixture();
    expect(buildActionContract(actualRequest).artifactMode).toBe('retrieve');
    expect(hasCompletedCoreAction(actualRequest, [record], identity)).toBe(true);
    expect(finalizeLumiResponse({ ...identity, taskText: actualRequest, responseText: '', source: 'chat', toolRecords: [record] })).toMatchObject({ blocked: false, reason: 'artifact_retrieved' });
  });
  it.each(['已经保存的', '已生成的', '已经制作的', '已经完成的', '已经编辑过的'])('treats %s as existing state only', state => {
    expect(buildArtifactRetrievalContract(`请把已有工程 ${projectId} 第23版${state}视频，以可播放或下载的视频附件发在这里。`)).toMatchObject({ artifactMode: 'retrieve' });
  });
  it.each(['修改片头', '取回并修改片头', '另存为一个新文件', '重新保存成片', '导出原始文件', '删除原文件', '复制到桌面', '发送邮件给客户', '发给客户微信', '发布到抖音', '上传到网盘', '提交到法院', '签署委托书', '付款给供应商', '支付100元', '下载原始文件到桌面', '打开视频播放器', '播放该视频', '分析视频内容', '总结对白', '翻译字幕', '运行脚本', '安装播放器'])('does not discharge an additional action: %s', action => {
    const text = `${base}，然后${action}。`;
    expect(buildArtifactRetrievalContract(text)).toBeNull();
    expect(hasCompletedCoreAction(text, [fixture()], identity)).toBe(false);
  });
  it('accepts past-state grammar without an additional existing synonym', () => {
    expect(buildArtifactRetrievalContract(`请把工程 ${projectId} 第23版已经保存的视频作为附件返回这里。`)).toMatchObject({ artifactMode: 'retrieve' });
  });
  it('returns an already saved English artifact without requesting another save', () => {
    expect(buildArtifactRetrievalContract(`Please return the existing project ${projectId} revision 23 already saved video as an attachment.`)).toMatchObject({ artifactMode: 'retrieve' });
  });
  it.each(['edit it', 'save a new copy', 'generate a new video', 'send an email to the client', 'pay the provider', 'download the original video to Desktop'])('does not discharge another English action: %s', action => {
    const text = `Please return the existing project ${projectId} revision 23 already saved video as an attachment, then ${action}.`;
    expect(buildArtifactRetrievalContract(text)).toBeNull();
    expect(hasCompletedCoreAction(text, [fixture()], identity)).toBe(false);
  });
  it('keeps an affirmative action after a prohibited clause', () => {
    expect(buildArtifactRetrievalContract(`${base}，不要修改原视频，但另存一个副本。`)).toBeNull();
  });
  it('keeps owner, current turn, exact revision, declared observe capability and hash requirements', () => {
    const record = fixture(); const payload = JSON.parse(record.result!);
    for (const bad of [
      { ...record, taskId: 'other-task' }, { ...record, requestId: 'previous-request' }, { ...record, error: 'Read failed' },
      { ...record, arguments: { projectId, revision: 22, includeOutput: true } },
      { ...record, arguments: { projectId, revision: 23, includeOutput: false } },
      { ...record, result: JSON.stringify({ ...payload, projectId: 'b590fef2-1d8f-4cea-a2b6-6a3ed5567e6a' }) },
      { ...record, result: JSON.stringify({ ...payload, artifacts: [{ ...payload.artifacts[0], sha256: '0'.repeat(64) }] }) },
      { ...record, result: JSON.stringify({ ...payload, artifacts: [{ ...payload.artifacts[0], size: payload.artifacts[0].size + 1 }] }) },
      { ...record, capability: { ...record.capability!, operation: 'mutate' as const } },
    ]) expect(hasCompletedCoreAction(actualRequest, [bad], identity)).toBe(false);
  });
  it('does not guess an identity or return only one of multiple outputs', () => {
    for (const text of ['请把已有视频作为附件返回。', `${base}以及另一个工程的视频。`, `${base}和工程 b590fef2-1d8f-4cea-a2b6-6a3ed5567e6a 的视频。`, `${base}和第24版的视频。`]) {
      expect(buildArtifactRetrievalContract(text)).toBeNull();
    }
  });
});
