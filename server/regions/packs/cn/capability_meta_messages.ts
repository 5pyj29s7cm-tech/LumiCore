import type { OperationMode } from '../../../cognition/operation_modes';
import {
  LUMI_MEETING_CAPTURE_SURFACE,
  LUMI_OPERATION_MODE_IDS,
  type LumiOperationMode,
} from '../../../../shared/operation_modes';

export function formatCnOperationModeInventoryResponse(): string {
  return 'Lumi 是一个统一的个人人格核心，对话、办事、记忆和学习不再分成聊天、助手或自主模式。你直接说需求即可；后台工作按已启用的计划和权限运行，会议转写是独立的录音功能。';
}

export function formatCnCurrentOperationModeResponse(mode: OperationMode | string): string {
  return mode === 'meeting'
    ? '当前正在会议转写，只记录发言。Lumi 的日常对话和任务执行无需选择模式。'
    : formatCnOperationModeInventoryResponse();
}

export const CN_UNVERIFIED_CLIENT_STATE_CLAIM =
  '\u8fd9\u4e00\u8f6e\u6ca1\u6709\u8bfb\u53d6\u5230\u53ef\u6838\u9a8c\u7684\u5ba2\u6237\u7aef\u8fd0\u884c\u72b6\u6001\uff0c\u56e0\u6b64\u4e0d\u80fd\u628a\u5f53\u524d\u72b6\u6001\u8bf4\u6210\u201c\u5df2\u9a8c\u8bc1\u201d\u3002\u4ea7\u54c1\u5b9a\u4e49\u53ef\u4ee5\u76f4\u63a5\u8bf4\u660e\uff1b\u5b9e\u65f6\u72b6\u6001\u9700\u8981\u771f\u5b9e\u67e5\u8be2\u56de\u6267\u540e\u518d\u786e\u8ba4\u3002';

export function formatCnCapabilityMetaResponse(
  mode: OperationMode | string,
  commandCenter: boolean,
): string {
  const modeLine = 'Lumi 的对话、执行和学习共用一个核心，不需要切换模式。需要做什么，直接告诉我即可；具体操作仍按你的授权和权限执行。';
  const entryLine = commandCenter
    ? '\u6307\u6325\u4e2d\u5fc3\u529e\u516c\u5ba4\u53f3\u4fa7\u7684\u6587\u5b57\u533a\u5c31\u662f Lumi \u552f\u4e00\u7684\u6587\u5b57\u5165\u53e3\uff0c\u4e0d\u7528\u518d\u53bb\u53e6\u4e00\u4e2a\u9875\u9762\u53d1\u4efb\u52a1\u3002'
    : '\u4f60\u76f4\u63a5\u5728\u5f53\u524d\u5bf9\u8bdd\u91cc\u8bf4\u5b8c\u6574\u4efb\u52a1\u5c31\u53ef\u4ee5\u3002';
  return [
    modeLine,
    entryLine,
    '\u7cfb\u7edf\u6bcf\u8f6e\u53ea\u9009\u51fa\u548c\u5f53\u524d\u4efb\u52a1\u6700\u76f8\u5173\u7684\u5de5\u5177\uff0c\u662f\u4e3a\u4e86\u51cf\u5c11\u8def\u7531\u5e72\u6270\uff1b\u8fd9\u4e0d\u4ee3\u8868\u5176\u4ed6\u5de5\u5177\u6ca1\u5b89\u88c5\u3001\u6ca1\u6302\u8f7d\u6216\u6ca1\u6743\u9650\u3002',
    '\u5982\u679c\u4f60\u5df2\u7ecf\u8bf4\u6e05\u4efb\u52a1\uff0cLumi \u5374\u6ca1\u9009\u4e2d\u6b63\u786e\u5de5\u5177\uff0c\u90a3\u662f Lumi \u7684\u8def\u7531\u95ee\u9898\uff0c\u4e0d\u662f\u4f60\u8fd8\u9700\u8981\u6539\u8bbe\u7f6e\u3002',
  ].join('\n');
}
