import type { OperationMode } from "../../cognition/operation_modes";

export function formatCnOperationModeInventoryResponse(): string {
  return 'Lumi 是一个统一的个人人格核心，对话、办事、记忆和学习不再分成聊天、助手或自主模式。你直接说需求即可；后台工作按已启用的计划和权限运行，会议转写是独立的录音功能。';
}

export function formatCnCurrentOperationModeResponse(mode: OperationMode | string): string {
  return mode === 'meeting'
    ? '当前正在会议转写，只记录发言。Lumi 的日常对话和任务执行无需选择模式。'
    : formatCnOperationModeInventoryResponse();
}
