import { getLocale, type Locale } from '../runtime';

const DESKTOP_WORKFLOW_COPY = {
  en: {
    proactiveActions: {
      analyze_code: 'Code help',
      debug_error: 'Debug error',
      debug_trace: 'Trace debugging',
      open_path: 'Open path',
      summarize_url: 'Summarize URL',
      create_presentation: 'Create presentation',
      write_document: 'Write document',
      analyze_spreadsheet: 'Spreadsheet analysis',
    },
    common: {
      ready: 'Ready',
      running: 'Running',
      generated: 'Generated',
      preparing: 'Preparing',
      completed: 'Completed',
      generating: 'Generating',
      windowControlFailed: 'window control failed',
      voicePreview: 'Hello, this is my voice.',
      chargingSuffix: ' (charging)',
    },
    voiceIdentity: {
      workflow: 'Voice identity workflow',
      complete: 'complete',
      inProgress: 'in progress',
      pending: 'pending',
      openAppearance: 'Open appearance',
      status: 'Status',
    },
    legalMeeting: {
      title: 'Client consultation',
      lumiSummary: 'Lumi consultation summary',
      rawTranscript: 'Raw transcript',
      safetyBoundary: 'Safety boundary',
      boundaryText: 'This record assists counsel analysis only. Final legal advice and external legal documents require review by a qualified lawyer.',
    },
  },
  zh: {
    proactiveActions: {
      analyze_code: '代码辅助',
      debug_error: '错误分析',
      debug_trace: '堆栈定位',
      open_path: '打开文件路径',
      summarize_url: '链接总结',
      create_presentation: '制作演示文稿',
      write_document: '文档写作',
      analyze_spreadsheet: '表格分析',
    },
    common: {
      ready: '就绪',
      running: '运行中',
      generated: '已生成',
      preparing: '准备中',
      completed: '已完成',
      generating: '生成中',
      windowControlFailed: '窗口控制失败',
      voicePreview: '你好，这是我的声音。',
      chargingSuffix: ' (充电中)',
    },
    voiceIdentity: {
      workflow: '音色身份工作流',
      complete: '已完成',
      inProgress: '进行中',
      pending: '待处理',
      openAppearance: '打开外观',
      status: '状态',
    },
    legalMeeting: {
      title: '当事人会谈',
      lumiSummary: 'Lumi 会谈整理',
      rawTranscript: '原始转写',
      safetyBoundary: '安全边界',
      boundaryText: '本记录用于辅助律师分析，最终法律意见与对外文书由执业律师确认。',
    },
  },
} as const;

export function desktopWorkflowCopy(locale: Locale = getLocale()) {
  return DESKTOP_WORKFLOW_COPY[locale];
}
