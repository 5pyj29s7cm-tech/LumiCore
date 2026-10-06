import type { OperationMode } from "../../cognition/operation_modes";

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
