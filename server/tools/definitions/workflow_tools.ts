import type { ToolRegistry } from "../registry";
import { capabilityContract, capabilityEvidence } from "../capability_contracts";
import { handleSaveWorkflow, handleListWorkflows, handleGetWorkflow, handlePublishWorkflow, handleDeleteWorkflow, handleCaptureRecentWorkflow } from './workflow/definition_commands';
import { handleRunWorkflow } from './workflow/run_execution';
import { handleGetWorkflowRun } from './workflow/run_projection';
import { handlePauseWorkflowRun, handleCancelWorkflowRun, handleResumeWorkflowRun, handleDecideWorkflowConfirmation, handleEditWorkflowRun } from './workflow/run_control';
import { handleReconcileWorkflowRun } from './workflow/reconciliation';



export function registerWorkflowTools(registry: ToolRegistry): void {
  registry.register({
    name: 'save_workflow',
    description: 'Save a reviewable named workflow draft without executing its steps. Use real registered tool names, never invent compute or transform tools. References are JSON objects: {"$inputRef":"inputs.name"} and {"$stepOutputRef":"step_1.optional.path"}, never strings or ${...} interpolation. For code_execution use args.code (JavaScript script, not Python; last expression or invoked function returns the result) and args.input (typed reference exposed as global input). It returns {ok,status,output}; bind a later writer to step_2.output, not the whole result. Include every computation as an executable step. Review with get_workflow; publication and execution require separate authorization.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Unique name for this workflow (e.g., "morning routine")' },
        description: { type: 'string', description: 'Short description of what this workflow does' },
        steps: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              description: { type: 'string' },
              tool: { type: 'string', description: 'Exact registered tool name. code_execution is the JavaScript calculator; compute is not a tool.' },
              args: { type: 'object', description: 'Arguments template: read_file uses {"path":{"$inputRef":"inputs.sourcePath"}}; code_execution uses {"code":"input.trim()","input":{"$stepOutputRef":"step_1"}} (replace the JavaScript with the requested algorithm); both desktop_write_text_file and write_file use {"path":{"$inputRef":"inputs.outputPath"},"content":{"$stepOutputRef":"step_2.output"}}. References are nested JSON objects, never quoted reference syntax. Keep the algorithm executable; never paste a previous answer as the writer content.' },
              reconciliationCapabilityId: {
                type: 'string',
                description: 'Optional read-only observe/test capability that can verify this exact target after an interrupted side effect. It is frozen into the published version.',
              },
            },
            required: ['tool'],
          },
          description: 'Ordered list of workflow steps',
        },
        category: { type: 'string', description: 'Optional category for grouping' },
      },
      required: ['name', 'steps'],
    },
    handler: handleSaveWorkflow,
    permission: 'user',
    securityLevel: 'safe',
    capability: capabilityContract({
      id: 'workflow.definition.save', family: 'workflow', lane: 'agents', operation: 'mutate', risk: 'medium',
      sideEffects: [{ type: 'local_state_change', scope: 'named workflow definition', reversible: true }],
      verification: {
        strategy: 'terminal_receipt', required: true,
        requiredFields: ['ok', 'status', 'workflowId', 'version', 'hash', 'name', 'stepCount'],
        requiredValues: { ok: true, status: 'draft' }, successStatuses: ['draft'],
        successSignals: ['the workflow store returned a versioned, redacted draft and exact step count'],
        limitations: ['Saving a draft does not publish, execute, or validate workflow steps.'],
      },
    }),
    evidence: capabilityEvidence({ id: 'workflow.definition.save', operation: 'mutate', subjectArgument: 'name' }),
  });

  registry.register({
    name: 'list_workflows',
    description: 'List all saved named workflows for the current user.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
    handler: handleListWorkflows,
    permission: 'user',
    securityLevel: 'safe',
  });

  registry.register({
    name: 'get_workflow',
    description: 'Get the full details of a saved workflow by name.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Workflow name' },
      },
      required: ['name'],
    },
    handler: handleGetWorkflow,
    permission: 'user',
    securityLevel: 'safe',
  });

  registry.register({
    name: 'publish_workflow',
    description: 'Publish one exact reviewed workflow draft version. If its capability contracts are missing or changed, this creates a new reviewable draft hash instead of silently publishing changed semantics.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Workflow name' },
        expectedHash: { type: 'string', description: 'Exact hash shown by save_workflow or get_workflow after review' },
      },
      required: ['name', 'expectedHash'],
    },
    handler: handlePublishWorkflow,
    permission: 'user',
    securityLevel: 'confirm',
    capability: capabilityContract({
      id: 'workflow.definition.publish', family: 'workflow', lane: 'agents', operation: 'mutate', risk: 'high',
      sideEffects: [{ type: 'local_state_change', scope: 'immutable workflow definition version', reversible: true }],
      verification: {
        strategy: 'terminal_receipt', required: true,
        requiredFields: ['ok', 'status', 'workflowId', 'version', 'hash', 'name'],
        requiredValues: { ok: true }, successStatuses: ['published', 'draft_refreshed'],
        successSignals: ['the reviewed workflow hash was frozen, or a changed capability contract was returned as a new draft for review'],
        limitations: ['Publication does not execute the workflow; a refreshed draft requires another explicit review and publish call.'],
      },
    }),
    evidence: capabilityEvidence({ id: 'workflow.definition.publish', operation: 'mutate', subjectArgument: 'name' }),
  });

  registry.register({
    name: 'delete_workflow',
    description: 'Delete a saved workflow by name.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Workflow name to delete' },
      },
      required: ['name'],
    },
    handler: handleDeleteWorkflow,
    permission: 'user',
    securityLevel: 'confirm',
    capability: capabilityContract({
      id: 'workflow.definition.delete', family: 'workflow', lane: 'agents', operation: 'mutate', risk: 'high',
      sideEffects: [{ type: 'local_state_change', scope: 'named workflow definition', reversible: false }],
      verification: {
        strategy: 'terminal_receipt', required: true,
        requiredFields: ['ok', 'status', 'name'], requiredValues: { ok: true, status: 'deleted' },
        successStatuses: ['deleted'], successSignals: ['the workflow store acknowledged deletion'],
        limitations: ['Deleted workflow definitions are not automatically recoverable.'],
      },
    }),
    evidence: capabilityEvidence({ id: 'workflow.definition.delete', operation: 'mutate', subjectArgument: 'name' }),
  });

  registry.register({
    name: 'capture_recent_workflow',
    description: 'Capture the most recent verified business trace from this exact conversation as a draft. Normally omit sourceTaskId; never guess it from a filename. Failed, discovery-only, unscoped, or model-only transformation traces cannot be captured as a complete algorithm: use save_workflow to author the requested executable steps and typed data bindings. Creating a skill package is a separate user request. No automatic publication or execution.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'A descriptive name for this workflow (e.g., "morning briefing", "daily report")' },
        sourceTaskId: { type: 'string', description: 'Optional exact source task ID returned by this server for this conversation. Omit for the latest trace. Never supply a filename, file stem, display label, or guessed task ID; invalid IDs return scoped availableSources without capturing anything.' },
      },
      required: ['name'],
    },
    handler: handleCaptureRecentWorkflow,
    permission: 'user',
    securityLevel: 'safe',
    capability: capabilityContract({
      id: 'workflow.definition.capture', family: 'workflow', lane: 'agents', operation: 'create', risk: 'medium',
      sideEffects: [{ type: 'local_state_change', scope: 'reviewable workflow draft from this conversation only', reversible: true }],
      verification: {
        strategy: 'terminal_receipt', required: true,
        requiredFields: ['ok', 'status', 'name', 'workflowId', 'hash'], requiredValues: { ok: true, status: 'draft' },
        successStatuses: ['draft'], failureStatuses: ['failed', 'needs_authoring'],
        successSignals: ['the workflow store persisted an actual scoped draft'],
        limitations: ['Captured reads do not encode subsequent model-only computation; draft creation does not authorize publication or execution.'],
      },
    }),
    evidence: capabilityEvidence({
      id: 'workflow.definition.capture', operation: 'create', subjectArgument: 'name',
      limitations: ['The receipt proves only persistence of the named, conversation-scoped draft; it does not prove complete computation, publication, or execution.'],
    }),
  });

  registry.register({
    name: 'run_workflow',
    description: 'Durably start a published workflow and return its runId immediately. Execution continues in the workflow worker and remains observable and interruptible through workflow control tools.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Name of the workflow to run' },
        inputs: { type: 'object', description: 'Ephemeral run-time inputs. Secret values are resolved in memory and never written to the workflow ledger.' },
        runId: { type: 'string', description: 'Existing paused run to continue. Omit only when starting a new run.' },
        expectedRevision: { type: 'number', description: 'Required optimistic revision when continuing an existing run.' },
      },
      required: [],
      anyOf: [
        { required: ['name'] },
        { required: ['runId', 'expectedRevision'] },
      ],
    },
    handler: handleRunWorkflow,
    permission: 'user',
    securityLevel: 'confirm',
    capability: capabilityContract({
      id: 'workflow.execution.run', family: 'workflow', lane: 'agents', operation: 'mutate', risk: 'medium',
      sideEffects: [{ type: 'local_state_change', scope: 'durable workflow job start', reversible: true }],
      verification: {
        strategy: 'terminal_receipt', required: true,
        requiredFields: ['ok', 'status', 'runId', 'revision', 'workflowId', 'completedSteps', 'totalSteps'],
        requiredValues: { ok: true }, successStatuses: ['started', 'completed'],
        successSignals: ['the workflow ledger durably returned a run id before long-running execution began'],
        limitations: ['This receipt proves durable start, not completion. Completion is proven only by get_workflow_run and verified nested step receipts.'],
      },
    }),
    evidence: capabilityEvidence({
      id: 'workflow.execution.run', operation: 'mutate', subjectArgument: 'name',
      limitations: ['Starting is not completion; failed or unknown nested steps remain visible in the durable run ledger.'],
    }),
  });

  registry.register({
    name: 'get_workflow_run',
    description: 'Read the durable state, progress, checkpoint, blocker, or pending confirmation for one workflow run.',
    parameters: {
      type: 'object',
      properties: { runId: { type: 'string' } },
      required: ['runId'],
    },
    handler: handleGetWorkflowRun,
    permission: 'user',
    securityLevel: 'safe',
    capability: capabilityContract({
      id: 'workflow.execution.observe', family: 'workflow', lane: 'agents', operation: 'observe', risk: 'low',
      sideEffects: [],
      verification: {
        strategy: 'terminal_receipt', required: true,
        requiredFields: ['ok', 'status', 'runId', 'revision', 'workflowId', 'completedSteps', 'totalSteps'],
        requiredValues: { ok: true }, successStatuses: ['queued', 'running', 'paused', 'waiting_confirmation', 'blocked', 'completed', 'cancelled'],
        successSignals: ['the durable workflow ledger returned the current revision and progress'],
        limitations: ['Observation never advances or repeats a workflow step.'],
      },
    }),
    evidence: capabilityEvidence({ id: 'workflow.execution.observe', operation: 'observe', subjectArgument: 'runId' }),
  });

  registry.register({
    name: 'pause_workflow_run',
    description: 'Request a CAS-protected pause. A running adapter is allowed to reach its safe checkpoint; no new adapter starts after the request.',
    parameters: {
      type: 'object',
      properties: { runId: { type: 'string' }, expectedRevision: { type: 'number' } },
      required: ['runId', 'expectedRevision'],
    },
    handler: handlePauseWorkflowRun,
    permission: 'user',
    securityLevel: 'safe',
    capability: capabilityContract({
      id: 'workflow.execution.pause', family: 'workflow', lane: 'agents', operation: 'mutate', risk: 'low',
      sideEffects: [{ type: 'local_state_change', scope: 'workflow run control', reversible: true }],
      verification: { strategy: 'terminal_receipt', required: true, requiredFields: ['ok', 'status', 'runId', 'revision'], requiredValues: { ok: true }, successSignals: ['the durable run ledger recorded the pause request'], limitations: ['An adapter already started may finish before the safe pause checkpoint.'] },
    }),
    evidence: capabilityEvidence({ id: 'workflow.execution.pause', operation: 'mutate', subjectArgument: 'runId' }),
  });

  registry.register({
    name: 'cancel_workflow_run',
    description: 'Cancel remaining workflow work using runId and expectedRevision. A possibly committed unknown side effect remains locked for reconciliation.',
    parameters: {
      type: 'object',
      properties: { runId: { type: 'string' }, expectedRevision: { type: 'number' } },
      required: ['runId', 'expectedRevision'],
    },
    handler: handleCancelWorkflowRun,
    permission: 'user',
    securityLevel: 'confirm',
    capability: capabilityContract({
      id: 'workflow.execution.cancel', family: 'workflow', lane: 'agents', operation: 'mutate', risk: 'medium',
      sideEffects: [{ type: 'local_state_change', scope: 'workflow run control', reversible: false }],
      verification: { strategy: 'terminal_receipt', required: true, requiredFields: ['ok', 'status', 'runId', 'revision'], requiredValues: { ok: true }, successSignals: ['the durable run ledger recorded cancellation or a cancellation pending reconciliation'], limitations: ['Cancellation cannot erase a side effect that may already have committed.'] },
    }),
    evidence: capabilityEvidence({ id: 'workflow.execution.cancel', operation: 'mutate', subjectArgument: 'runId' }),
  });

  registry.register({
    name: 'resume_workflow_run',
    description: 'Resume a paused reviewed workflow run and dispatch its durable background worker. Unknown or incompatible runs cannot resume.',
    parameters: {
      type: 'object',
      properties: {
        runId: { type: 'string' }, expectedRevision: { type: 'number' },
        inputs: { type: 'object', description: 'Ephemeral inputs or secret references needed by remaining steps.' },
      },
      required: ['runId', 'expectedRevision'],
    },
    handler: handleResumeWorkflowRun,
    permission: 'user',
    securityLevel: 'confirm',
    capability: capabilityContract({
      id: 'workflow.execution.resume', family: 'workflow', lane: 'agents', operation: 'mutate', risk: 'high',
      sideEffects: [{ type: 'local_state_change', scope: 'workflow worker lease', reversible: true }],
      verification: { strategy: 'terminal_receipt', required: true, requiredFields: ['ok', 'status', 'runId', 'revision', 'runStatus'], requiredValues: { ok: true, status: 'started' }, successStatuses: ['started'], successSignals: ['a durable worker lease was created and the run id returned before any long step'], limitations: ['This proves resumption, not completion of remaining steps.'] },
    }),
    evidence: capabilityEvidence({ id: 'workflow.execution.resume', operation: 'mutate', subjectArgument: 'runId' }),
  });

  registry.register({
    name: 'decide_workflow_confirmation',
    description: 'Approve or reject one exact pending workflow step confirmation using its run revision and confirmation id.',
    parameters: {
      type: 'object',
      properties: {
        runId: { type: 'string' }, expectedRevision: { type: 'number' }, confirmationId: { type: 'string' },
        approved: { type: 'boolean' }, inputs: { type: 'object', description: 'Ephemeral inputs used by the approved step.' },
      },
      required: ['runId', 'expectedRevision', 'confirmationId', 'approved'],
    },
    handler: handleDecideWorkflowConfirmation,
    permission: 'user',
    securityLevel: 'confirm',
    capability: capabilityContract({
      id: 'workflow.execution.confirm', family: 'workflow', lane: 'agents', operation: 'mutate', risk: 'high',
      sideEffects: [{ type: 'local_state_change', scope: 'exact workflow step approval', reversible: true }],
      verification: { strategy: 'terminal_receipt', required: true, requiredFields: ['ok', 'status', 'runId', 'revision', 'approved'], requiredValues: { ok: true }, successSignals: ['the exact pending confirmation was consumed once'], limitations: ['Approval is bound to one plan revision and exact argument/target digest.'] },
    }),
    evidence: capabilityEvidence({ id: 'workflow.execution.confirm', operation: 'mutate', subjectArgument: 'runId' }),
  });

  registry.register({
    name: 'edit_workflow_run_plan',
    description: 'Replace only future, unexecuted steps of a paused workflow run. Executed receipts remain immutable and every capability contract is re-frozen.',
    parameters: {
      type: 'object',
      properties: {
        runId: { type: 'string' }, expectedRevision: { type: 'number' }, reason: { type: 'string' },
        steps: { type: 'array', items: { type: 'object', properties: {
          stepId: { type: 'string' }, description: { type: 'string' }, capabilityId: { type: 'string' },
          dependsOn: { type: 'array', items: { type: 'string' } }, arguments: { type: 'object' },
          confirmationRequired: { type: 'boolean' }, confirmationReason: { type: 'string' },
        }, required: ['stepId', 'capabilityId'] } },
      },
      required: ['runId', 'expectedRevision', 'steps', 'reason'],
    },
    handler: handleEditWorkflowRun,
    permission: 'user',
    securityLevel: 'confirm',
    capability: capabilityContract({
      id: 'workflow.execution.edit', family: 'workflow', lane: 'agents', operation: 'mutate', risk: 'high',
      sideEffects: [{ type: 'local_state_change', scope: 'future workflow plan revision', reversible: true }],
      verification: { strategy: 'terminal_receipt', required: true, requiredFields: ['ok', 'status', 'runId', 'revision', 'planRevision'], requiredValues: { ok: true, status: 'paused' }, successStatuses: ['paused'], successSignals: ['the future plan changed under CAS while executed steps remained immutable'], limitations: ['Executed steps and unresolved unknown outcomes cannot be edited away.'] },
    }),
    evidence: capabilityEvidence({ id: 'workflow.execution.edit', operation: 'mutate', subjectArgument: 'runId' }),
  });

  registry.register({
    name: 'reconcile_workflow_run',
    description: 'Use a frozen workflow step\'s declared read-only adapter to determine whether an interrupted side effect committed. It never repeats the mutation.',
    parameters: {
      type: 'object',
      properties: {
        runId: { type: 'string' },
        expectedRevision: { type: 'number' },
        stepId: { type: 'string' },
        capabilityId: { type: 'string', description: 'Optional explicit read-only adapter. Omit when the frozen original capability provides its own attached reconciliation hook.' },
        inputs: { type: 'object', description: 'Ephemeral inputs needed to address the exact original target.' },
      },
      required: ['runId', 'expectedRevision', 'stepId'],
    },
    handler: handleReconcileWorkflowRun,
    permission: 'user',
    securityLevel: 'safe',
    capability: capabilityContract({
      id: 'workflow.execution.reconcile', family: 'workflow', lane: 'agents', operation: 'mutate', risk: 'low',
      sideEffects: [{ type: 'local_state_change', scope: 'workflow reconciliation ledger', reversible: true }],
      verification: {
        strategy: 'terminal_receipt', required: true,
        requiredFields: ['ok', 'status', 'runId', 'revision', 'stepId', 'reconciliationRequired'],
        requiredValues: { ok: true, reconciliationRequired: false },
        successStatuses: ['paused'],
        successSignals: ['a declared read-only adapter verified the exact prepared target and arguments'],
        limitations: ['This control never repeats the original mutation.'],
      },
    }),
    evidence: capabilityEvidence({ id: 'workflow.execution.reconcile', operation: 'mutate', subjectArgument: 'runId' }),
  });
}
