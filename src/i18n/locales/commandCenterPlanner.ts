import type { Locale } from '../runtime';

const COPY = {
  en: {
    headerTitle: 'Tasks & pursuits', headerDetail: 'Scheduled plans follow your background-work settings and update from real receipts.',
    authorizationRequired: 'This plan is paused because its organization authorization is missing or has changed. Review the plan, then authorize it again with your current membership. Existing task receipts are retained.',
    reauthorize: 'Authorize and resume this plan',
    scheduleControlDetail: 'Changing the schedule or resuming a plan calculates its next run from now. Control already-dispatched tasks separately.',
    plannerButton: 'Plans', plannerButtonTitle: 'Tasks, pursuits and periodic reports', newPlan: 'New',
    dailyTask: 'Daily task', longTermGoal: 'Long-term pursuit', periodicReport: 'Periodic report',
    manualOnly: 'Manual only', daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly',
    weekday: 'Weekday', monthDay: 'Day of month', monthDaySuffix: '',
    weekdays: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
    titlePlaceholder: 'Plan title', instructionPlaceholder: 'What should Lumi execute, advance, or report?',
    save: 'Save', emptyTitle: 'Create Lumi’s first pursuit', emptyDetail: 'Or add daily tasks and periodic reports',
    next: 'Next', discuss: 'Discuss', run: 'Run', resume: 'Resume', pause: 'Pause', complete: 'Complete', remove: 'Delete',
    planStatus: 'Plan status', lastRun: 'Latest run', neverRun: 'Not run yet', running: 'Starting',
    planActive: 'Enabled', planPaused: 'Paused', planCompleted: 'Completed',
    existingRun: 'This plan already has an active run. Showing the existing task instead of creating a duplicate.',
    discussPrompt: (title: string, instruction: string) => `Let's discuss “${title}”: ${instruction}`,
  },
  zh: {
    headerTitle: '任务与追求', headerDetail: '定时计划按后台工作设置运行，并以真实回执更新状态。',
    authorizationRequired: '该计划缺少组织授权记录或成员权限已变化，现已暂停。请先核对计划，再用当前成员身份重新授权。已有任务回执会保留。',
    reauthorize: '重新授权并恢复此计划',
    scheduleControlDetail: '修改排程或恢复计划时，从当前时间计算下次执行；已派发的任务需单独暂停或取消。',
    plannerButton: '计划', plannerButtonTitle: '任务、长期追求与周期汇报', newPlan: '新建',
    dailyTask: '每日任务', longTermGoal: '长期追求', periodicReport: '周期汇报',
    manualOnly: '仅手动', daily: '每天', weekly: '每周', monthly: '每月',
    weekday: '星期', monthDay: '日期', monthDaySuffix: '日',
    weekdays: ['周日', '周一', '周二', '周三', '周四', '周五', '周六'],
    titlePlaceholder: '任务或目标名称', instructionPlaceholder: 'Lumi 应该执行、推进或汇报什么？',
    save: '保存', emptyTitle: '建立 Lumi 的第一个长期追求', emptyDetail: '或添加每日固定任务、周期汇报',
    next: '下次', discuss: '讨论', run: '立即执行', resume: '恢复', pause: '暂停', complete: '完成', remove: '删除',
    planStatus: '计划状态', lastRun: '最近一次执行', neverRun: '尚未执行', running: '正在启动',
    planActive: '已启用', planPaused: '已暂停', planCompleted: '已完成',
    existingRun: '该计划已有运行中的任务，已显示现有任务，没有重复派发。',
    discussPrompt: (title: string, instruction: string) => `我们继续讨论“${title}”：${instruction}`,
  },
} as const;

export function commandCenterPlannerCopy(locale: Locale) {
  return COPY[locale];
}
