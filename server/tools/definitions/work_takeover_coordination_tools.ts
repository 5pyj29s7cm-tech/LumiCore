import { resolveWorkTakeoverIntakeTask } from '../../work_takeover/intake';
import { boundedWorkTakeoverSteps, runWorkTakeoverPreparation } from '../../work_takeover/preparation_loop';
import { recordWorkTakeoverPacket } from '../../work_takeover/packet_recording';
import fs from 'fs';
import type { ToolRegistry } from '../registry';
import { updateWorkTakeoverTask, type WorkTakeoverStatus } from '../../work_takeover/tasks';
import { normalizeWorkTakeoverExecutionMode, type WorkTakeoverExecutionMode } from '../../work_takeover/execution_planner';
import { exportWorkTakeoverPacket } from '../../work_takeover/task_packet';
import { verifyWorkTakeoverResult, type WorkTakeoverExpectedSurface } from '../../work_takeover/result_verifier';
import { getTaskIndustryParameters } from '../../work_takeover/industry_parameters';
import { runWorkTakeoverCapabilityReuseProbe } from '../../work_takeover/capability_reuse_probe';
import { contextUser, requireTask, asStringArray, uniqueStrings, requirePersistedTask, taskStateContract, taskStateEvidence, registerWorkTakeoverTool } from './work_takeover_shared';

export function registerWorkTakeoverCoordinationTools(registry: ToolRegistry): void {
  registerWorkTakeoverTool(registry, {
    name: 'work_takeover_task_verify_result',
    description: 'Verify a work takeover task after visible work or tool execution. It checks task context, confirmation boundaries, drafts, file paths, artifact content quality, and current desktop/window/process/screenshot state, then writes a verification record back to the task center. Use this before claiming a real workflow is complete.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Optional work takeover task id. If omitted, uses the highest-priority active task.' },
        expectedSurfaces: {
          type: 'array',
          items: { type: 'string' },
          description: 'Expected visible surfaces, e.g. wechat, browser, office, spreadsheet, cad, bim, video_editor, store_platform, creator_platform, file_explorer, lumi.',
        },
        filePaths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Additional exact local file/folder paths that should exist.',
        },
        draftRequired: { type: 'boolean', description: 'Whether a communication draft must be present.' },
        requireActiveWindow: { type: 'boolean', description: 'Whether reading any active window is required even when no expectedSurfaces are provided.' },
        requireScreenEvidence: { type: 'boolean', description: 'Whether a fresh screenshot must be captured and readable. Defaults to true.' },
        requiredArtifactLabels: {
          type: 'array',
          items: { type: 'string' },
          description: 'Artifact labels that must be recorded on the task, such as PPT, CAD DXF, WeChat draft, publish checklist.',
        },
        expectedContentTerms: {
          type: 'array',
          items: { type: 'string' },
          description: 'Domain words that should appear in generated artifacts/result/drafts, e.g. product name, customer need, style, budget, platform, case facts.',
        },
        minMatchedContentTerms: { type: 'number', description: 'Minimum expectedContentTerms/category terms that must be found. Defaults to 2 when terms exist.' },
        minFileBytes: { type: 'number', description: 'Minimum bytes for local artifact files to avoid accepting empty shells. Defaults to 16.' },
        requireExternalOutcome: { type: 'boolean', description: 'Require recorded evidence of the requested customer/platform/CAD/BIM/publishing action. Defaults to true for customer, store, account, video_publish, and design_delivery tasks unless the source request explicitly asks for drafts/preparation only.' },
        record: { type: 'boolean', description: 'Whether to write verification back to the task. Defaults to true.' },
      },
      required: [],
    },
    handler: async (args, context) => {
      const { userId, task } = requireTask(args, context);

      let activeWindowRaw = '';
      let runningProcessesRaw = '';
      let screenRaw = '';
      if (context?.desktopRelay) {
        try {
          activeWindowRaw = await context.desktopRelay('desktop_active_window', {});
        } catch {}
        try {
          runningProcessesRaw = await context.desktopRelay('desktop_running_processes', { top: 80 });
        } catch {}
        try {
          screenRaw = await context.desktopRelay('desktop_capture_screen', { quality: 35 });
        } catch {}
      }

      const params = getTaskIndustryParameters(task);
      const expectedSurfaces = (asStringArray(args.expectedSurfaces) || params?.expectedSurfaces || [])
        .map(surface => surface as WorkTakeoverExpectedSurface)
        .filter(Boolean);
      const filePaths = asStringArray(args.filePaths) || [];
      const requiredArtifactLabels = asStringArray(args.requiredArtifactLabels) || params?.requiredArtifactLabels || [];
      const expectedContentTerms = asStringArray(args.expectedContentTerms) || params?.expectedContentTerms || [];
      const taskIntentText = `${task.title} ${task.summary} ${task.sourceMessage}`;
      const preparationOnly = /(?:\u8349\u7a3f|\u51c6\u5907|\u9884\u6848|\u4e0d\u53d1\u9001|\u4e0d\u53d1\u5e03|\u6682\u4e0d\u64cd\u4f5c|draft|preparation|do\s+not\s+(?:send|publish|operate))/iu.test(taskIntentText);
      const externalCategory = ['customer', 'store', 'account', 'video_publish', 'design_delivery'].includes(task.category);
      const requireExternalOutcome = typeof args.requireExternalOutcome === 'boolean'
        ? args.requireExternalOutcome
        : externalCategory && !preparationOnly;
      const verification = verifyWorkTakeoverResult(task, {
        activeWindowRaw,
        runningProcessesRaw,
        screenRaw,
        expectedSurfaces,
        filePaths,
        draftRequired: args.draftRequired === true,
        requireActiveWindow: args.requireActiveWindow === true,
        requireScreenEvidence: args.requireScreenEvidence !== false,
        requiredArtifactLabels,
        expectedContentTerms,
        minMatchedContentTerms: args.minMatchedContentTerms,
        minFileBytes: args.minFileBytes,
        requireExternalOutcome,
      });

      let updatedTask = task;
      if (args.record !== false) {
        const status: WorkTakeoverStatus = verification.status === 'blocked'
          ? 'blocked'
          : verification.status === 'needs_review'
          ? 'waiting_confirmation'
          : task.status === 'queued'
          ? 'in_progress'
          : task.status;
        updatedTask = updateWorkTakeoverTask(userId, task.id, {
          status,
          result: verification.summary,
          blockedBy: verification.status === 'blocked'
            ? uniqueStrings([...task.blockedBy, ...verification.blockers])
            : undefined,
          artifact: {
            type: 'checklist',
            label: '任务结果验证记录',
            content: [
              verification.summary,
              '',
              ...verification.checks.map(item => `- ${item.passed ? '通过' : '待复核'}｜${item.label}：${item.detail}`),
              verification.activeWindow
                ? `\n活动窗口：${verification.activeWindow.processName} ${verification.activeWindow.title}`
                : '\n活动窗口：未读取',
              verification.screen?.captured
                ? `屏幕截图：${verification.screen.width || '?'}x${verification.screen.height || '?'} ${verification.screen.format || ''}`.trim()
                : '屏幕截图：未读取',
              verification.detectedSurfaces.length
                ? `检测到的外部表面：${verification.detectedSurfaces.join('、')}`
                : '检测到的外部表面：暂无',
            ].join('\n'),
            status: verification.passed ? 'prepared' : 'needs_review',
          },
          metadata: {
            workTakeoverVerification: verification,
          },
          note: verification.summary,
        } as any) || task;
      }

      return JSON.stringify({
        task: updatedTask,
        verification,
        note: args.record === false
          ? 'Verification generated without recording.'
          : 'Verification recorded on the work takeover task.',
      }, null, 2);
    },
  });

  registerWorkTakeoverTool(registry, {
    name: 'work_takeover_task_autorun',
    description: 'Run a bounded local coordination loop for work takeover. It can create or continue a task, orchestrate safe planning steps, stop on blockers or confirmation boundaries, export a task packet, and record progress. Concrete customer, ecommerce, design, CAD, BIM, publishing, and messaging outcomes must be executed separately through their real domain tools and verified.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Optional existing work takeover task id. If omitted, message/clipboard/active task is used.' },
        message: { type: 'string', description: 'Optional WeChat/customer message text to create a new task before autorun.' },
        fromClipboard: { type: 'boolean', description: 'Read message text from desktop clipboard when message is omitted. Requires desktop client relay.' },
        contact: { type: 'string', description: 'Optional contact/customer name.' },
        source: { type: 'string', description: 'manual, clipboard, selected_text, wechat, voice, chat.' },
        takeoverMode: { type: 'string', description: 'Optional forced task category or auto.' },
        userRules: { type: 'string', description: 'Optional user rules/boundaries to apply.' },
        title: { type: 'string', description: 'Optional task title if creating from message.' },
        maxSteps: { type: 'number', description: 'Maximum safe preparation steps to advance. Defaults to 3, max 6.' },
        mode: { type: 'string', description: 'plan_only, prepare_work, or visible_external_work.' },
        stopOnConfirmation: { type: 'boolean', description: 'Stop after a step that reaches confirmation boundary. Defaults to true.' },
        exportPacket: { type: 'boolean', description: 'Export a local task packet at the end. Defaults to true.' },
        outputDirectory: { type: 'string', description: 'Optional folder for exported packet. Defaults to the Desktop.' },
        record: { type: 'boolean', description: 'Whether to write autorun results back to the task. Defaults to true.' },
      },
      required: [],
    },
    handler: async (args, context) => {
      const { userId, domain, orgId } = contextUser(context);
      const mode = normalizeWorkTakeoverExecutionMode(args.mode);
      const shouldRecord = args.record !== false;
      const stopOnConfirmation = args.stopOnConfirmation !== false;
      const maxSteps = boundedWorkTakeoverSteps(args.maxSteps, 3, 6, 1);

      const { task, intake, createdTask } = await resolveWorkTakeoverIntakeTask({ userId, domain, orgId }, args, context?.desktopRelay);
      const preparation = runWorkTakeoverPreparation(task, { mode, maxSteps, record: shouldRecord, stopOnConfirmation });
      let currentTask = preparation.task;
      const { plan, progress, executions, stopReasons } = preparation;
      const autorun = { createdTask, intake, executions, progress, stopReasons, maxSteps };
      let packet: ReturnType<typeof exportWorkTakeoverPacket> | undefined;
      if (args.exportPacket !== false) {
        packet = exportWorkTakeoverPacket(currentTask, {
          outputDirectory: args.outputDirectory ? String(args.outputDirectory) : undefined,
          plan,
        });
        if (shouldRecord) {
          currentTask = recordWorkTakeoverPacket(userId, currentTask, plan, packet, {
            workTakeoverAutorun: { ...autorun, updatedAt: packet.createdAt },
          });
        }
        if (!fs.existsSync(packet.folderPath)) {
          throw new Error(`Work takeover autorun packet was not created: ${packet.folderPath}`);
        }
      } else if (shouldRecord) {
        currentTask = updateWorkTakeoverTask(userId, currentTask.id, {
          metadata: {
            workTakeoverAutorun: { ...autorun, updatedAt: new Date().toISOString() },
          },
          note: `Autorun completed ${executions.length} safe step(s).`,
        } as any) || currentTask;
      }

      const persisted = shouldRecord || createdTask;
      if (persisted) currentTask = requirePersistedTask(userId, currentTask);

      const report = {
        createdTask,
        taskId: currentTask.id,
        title: currentTask.title,
        category: currentTask.category,
        status: currentTask.status,
        executedSteps: executions.map(item => ({
          stepId: item.step.id,
          title: item.step.title,
          status: item.status,
          summary: item.summary,
        })),
        stopReasons,
        remainingStepIds: progress.remainingStepIds,
        confirmationRequired: currentTask.confirmationRequired || [],
        blockers: currentTask.blockedBy || [],
        packetPath: packet?.folderPath,
      };

      const status = report.stopReasons.includes('blocked')
        ? 'blocked'
        : report.stopReasons.includes('waiting_confirmation')
          ? 'waiting_confirmation'
          : progress.complete ? 'safe_loop_complete' : 'bounded_progress';

      return JSON.stringify({
        ok: status !== 'blocked',
        status,
        persisted,
        intake,
        task: currentTask,
        plan,
        progress,
        executions,
        packet,
        report,
        note: 'Autorun finished the bounded safe loop. Review report.stopReasons, confirmationRequired, blockers, and packetPath for the next decision.',
      }, null, 2);
    },
    capability: taskStateContract({
      id: 'work-takeover.task.autorun',
      operation: 'mutate',
      successStatuses: ['safe_loop_complete', 'bounded_progress', 'waiting_confirmation'],
      requiredFields: ['report.taskId', 'report.stopReasons', 'progress.remainingStepIds'],
      risk: 'medium',
      sideEffects: [
        { type: 'local_state_change', scope: 'bounded work takeover task coordination', reversible: true },
        { type: 'local_write', scope: 'optional work takeover packet', reversible: true },
        { type: 'local_read', scope: 'optional clipboard intake', reversible: true },
      ],
      limitations: ['Autorun covers bounded local coordination only; it cannot substitute for real domain-tool execution or verification.'],
    }),
    evidence: taskStateEvidence('work-takeover.task.autorun', 'mutate'),
  });

  registerWorkTakeoverTool(registry, {
    name: 'work_takeover_capability_reuse_probe',
    description: 'Run a safe capability-reuse pressure test for a work takeover task. It creates or continues a task, builds the normal execution plan, audits every selected capability with self_extension_plan, optionally advances safe local coordination steps, exports a task packet, verifies that coordination output, and writes a concise diagnostic back to the task center. It never substitutes generated demo packages for domain execution.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Optional existing work takeover task id. If omitted, message/clipboard/active task is used.' },
        message: { type: 'string', description: 'Optional customer/WeChat message text to create a new task before the probe.' },
        fromClipboard: { type: 'boolean', description: 'Read message text from desktop clipboard when message is omitted. Requires desktop client relay.' },
        contact: { type: 'string', description: 'Optional contact/customer name.' },
        source: { type: 'string', description: 'manual, clipboard, selected_text, wechat, voice, chat.' },
        takeoverMode: { type: 'string', description: 'Optional forced task category or auto.' },
        userRules: { type: 'string', description: 'Optional user rules/boundaries to apply.' },
        title: { type: 'string', description: 'Optional task title if creating from message.' },
        maxSteps: { type: 'number', description: 'Maximum safe preparation steps to advance. Defaults to 2, max 5.' },
        mode: { type: 'string', description: 'plan_only, prepare_work, or visible_external_work. Defaults to prepare_work.' },
        runSafeLoop: { type: 'boolean', description: 'Advance bounded safe local steps. Defaults true.' },
        stopOnConfirmation: { type: 'boolean', description: 'Stop after a step reaches a confirmation boundary. Defaults true.' },
        exportPacket: { type: 'boolean', description: 'Export a local task packet at the end. Defaults true.' },
        outputDirectory: { type: 'string', description: 'Optional folder for exported package/packet. Defaults to the Desktop.' },
        record: { type: 'boolean', description: 'Whether to write the probe result back to the task. Defaults true.' },
      },
      required: [],
    },
    handler: async (args, context) => {
      const { userId, domain, orgId } = contextUser(context);
      const result = await runWorkTakeoverCapabilityReuseProbe({
        userId,
        domain,
        orgId,
        id: args.id ? String(args.id) : undefined,
        message: args.message ? String(args.message) : undefined,
        fromClipboard: args.fromClipboard === true,
        contact: args.contact ? String(args.contact) : undefined,
        source: args.source ? String(args.source) : undefined,
        takeoverMode: args.takeoverMode ? String(args.takeoverMode) : undefined,
        userRules: args.userRules ? String(args.userRules) : undefined,
        title: args.title ? String(args.title) : undefined,
        maxSteps: args.maxSteps,
        mode: args.mode ? String(args.mode) as WorkTakeoverExecutionMode : undefined,
        runSafeLoop: args.runSafeLoop !== false,
        stopOnConfirmation: args.stopOnConfirmation !== false,
        exportPacket: args.exportPacket !== false,
        outputDirectory: args.outputDirectory ? String(args.outputDirectory) : undefined,
        record: args.record !== false,
        tools: registry.listForContext(context),
        capabilityManifest: registry.getCapabilityManifest(undefined, { context }),
        desktopRelay: context?.desktopRelay,
      });
      return JSON.stringify(result, null, 2);
    },
  });
}
