import {
  deleteFace,
  deleteVoiceprint,
  getFaces,
  getVoiceprints,
} from '../../biometrics/store';
import { capabilityContract, capabilityEvidence } from '../capability_contracts';
import { ToolRegistry } from '../registry';
import type { ToolContext } from '../types';

function userId(context?: ToolContext): string {
  return context?.userId || 'anonymous';
}

async function biometricStatus(_args: Record<string, any>, context?: ToolContext): Promise<string> {
  const uid = userId(context);
  const voiceprints = getVoiceprints(uid);
  const faces = getFaces(uid);
  return JSON.stringify({
    ok: true,
    status: 'observed',
    userId: uid,
    voiceprints: voiceprints.map(item => ({
      id: item.voiceprintId,
      label: item.label,
      lastMatchedAt: item.lastMatchedAt,
    })),
    faces: faces.map(item => ({
      id: item.faceId,
      label: item.label,
      lastMatchedAt: item.lastMatchedAt,
    })),
  });
}

async function biometricEnroll(_args: Record<string, any>, context?: ToolContext): Promise<string> {
  return JSON.stringify({
    ok: true,
    status: 'requires_user_action',
    initiated: false,
    userId: userId(context),
    surface: 'settings.biometrics',
    instructions: [
      'Open Settings and use the Biometrics enrollment panel.',
      'Voiceprint enrollment records multiple spoken phrases with microphone permission.',
      'Face enrollment captures local camera frames while the user is present.',
    ],
  });
}

async function biometricVerify(_args: Record<string, any>, context?: ToolContext): Promise<string> {
  const uid = userId(context);
  const enrolledVoiceprints = getVoiceprints(uid).length;
  const enrolledFaces = getFaces(uid).length;
  return JSON.stringify({
    ok: true,
    status: 'requires_user_action',
    initiated: false,
    userId: uid,
    enrolledVoiceprints,
    enrolledFaces,
    surface: 'settings.biometrics',
    reason: enrolledVoiceprints + enrolledFaces > 0
      ? 'Verification requires live microphone or camera input in the client.'
      : 'No biometric template is enrolled for this user.',
  });
}

async function biometricForget(args: Record<string, any>, context?: ToolContext): Promise<string> {
  const uid = userId(context);
  const type = String(args.type || 'all').toLowerCase();
  if (!['voiceprint', 'face', 'all'].includes(type)) {
    throw new Error('Biometric forget type must be voiceprint, face, or all.');
  }

  let deletedVoiceprints = 0;
  let deletedFaces = 0;
  if (type === 'voiceprint' || type === 'all') {
    for (const voiceprint of getVoiceprints(uid)) {
      if (deleteVoiceprint(uid, voiceprint.voiceprintId)) deletedVoiceprints += 1;
    }
  }
  if (type === 'face' || type === 'all') {
    for (const face of getFaces(uid)) {
      if (deleteFace(uid, face.faceId)) deletedFaces += 1;
    }
  }

  const remainingVoiceprints = getVoiceprints(uid).length;
  const remainingFaces = getFaces(uid).length;
  const deleted = deletedVoiceprints + deletedFaces;
  return JSON.stringify({
    ok: true,
    status: deleted > 0 ? 'deleted' : 'no_op',
    userId: uid,
    requestedType: type,
    deleted,
    deletedVoiceprints,
    deletedFaces,
    remainingVoiceprints,
    remainingFaces,
  });
}

export function registerBiometricTools(registry: ToolRegistry): void {
  registry.register({
    name: 'biometric_status',
    description: 'Read the current user\'s locally stored voiceprint and face enrollment metadata.',
    parameters: { type: 'object', properties: {}, required: [] },
    handler: biometricStatus,
    permission: 'user',
    securityLevel: 'safe',
    capability: {
      id: 'biometrics.status.read',
      family: 'biometrics',
      lane: 'client',
      operation: 'observe',
      risk: 'low',
      sideEffects: [{ type: 'local_read', scope: 'current user biometric template metadata', reversible: true }],
      verification: {
        strategy: 'terminal_receipt',
        required: true,
        requiredFields: ['ok', 'status', 'userId', 'voiceprints', 'faces'],
        requiredValues: { ok: true, status: 'observed' },
        successStatuses: ['observed'],
        failureStatuses: ['failed'],
        successSignals: ['local biometric store returned both enrollment collections'],
        limitations: ['Metadata presence does not prove current identity or live sensor availability.'],
      },
    },
    evidence: capabilityEvidence({
      id: 'biometrics.status.read',
      operation: 'observe',
      limitations: ['This is enrollment metadata, not a live verification result.'],
    }),
  });

  registry.register({
    name: 'biometric_enroll',
    description: 'Return the exact client surface and live-user steps required for biometric enrollment. This tool does not claim enrollment has started or completed.',
    parameters: { type: 'object', properties: {}, required: [] },
    handler: biometricEnroll,
    permission: 'user',
    securityLevel: 'safe',
    capability: {
      id: 'biometrics.enrollment.instructions',
      family: 'biometrics',
      lane: 'client',
      operation: 'observe',
      risk: 'low',
      sideEffects: [],
      verification: {
        strategy: 'terminal_receipt',
        required: true,
        requiredFields: ['ok', 'status', 'initiated', 'surface', 'instructions'],
        requiredValues: { ok: true, status: 'requires_user_action', initiated: false },
        successStatuses: ['requires_user_action'],
        failureStatuses: ['failed'],
        successSignals: ['receipt explicitly states that live enrollment has not started'],
        limitations: ['Enrollment can only complete through the live client microphone/camera panel.'],
      },
    },
    evidence: capabilityEvidence({
      id: 'biometrics.enrollment.instructions',
      operation: 'observe',
      limitations: ['No biometric template is created by this informational capability.'],
    }),
  });

  registry.register({
    name: 'biometric_verify',
    description: 'Check whether live biometric verification can be requested and return the required user action. This tool does not fabricate a verification result.',
    parameters: { type: 'object', properties: {}, required: [] },
    handler: biometricVerify,
    permission: 'user',
    securityLevel: 'safe',
    capability: {
      id: 'biometrics.verification.instructions',
      family: 'biometrics',
      lane: 'client',
      operation: 'observe',
      risk: 'low',
      sideEffects: [{ type: 'local_read', scope: 'current user biometric enrollment counts', reversible: true }],
      verification: {
        strategy: 'terminal_receipt',
        required: true,
        requiredFields: ['ok', 'status', 'initiated', 'enrolledVoiceprints', 'enrolledFaces', 'reason'],
        requiredValues: { ok: true, status: 'requires_user_action', initiated: false },
        successStatuses: ['requires_user_action'],
        failureStatuses: ['failed'],
        successSignals: ['receipt distinguishes prerequisite status from a live verification result'],
        limitations: ['No current identity assertion is made without live sensor evidence.'],
      },
    },
    evidence: capabilityEvidence({
      id: 'biometrics.verification.instructions',
      operation: 'observe',
      limitations: ['Live microphone/camera verification occurs in the client, not in this tool.'],
    }),
  });

  registry.register({
    name: 'biometric_forget',
    description: 'Delete the current user\'s stored voiceprint data, face data, or both, then report the verified remaining counts.',
    parameters: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['voiceprint', 'face', 'all'], description: 'Biometric template class to delete; defaults to all.' },
      },
      required: [],
    },
    handler: biometricForget,
    permission: 'user',
    securityLevel: 'confirm',
    capability: capabilityContract({
      id: 'biometrics.templates.delete',
      family: 'biometrics',
      lane: 'client',
      operation: 'mutate',
      risk: 'high',
      sideEffects: [{ type: 'local_state_change', scope: 'current user biometric templates', reversible: false }],
      verification: {
        strategy: 'state_diff',
        required: true,
        requiredFields: ['ok', 'status', 'requestedType', 'deleted', 'deletedVoiceprints', 'deletedFaces', 'remainingVoiceprints', 'remainingFaces'],
        requiredValues: { ok: true },
        successStatuses: ['deleted', 'no_op'],
        failureStatuses: ['failed'],
        successSignals: ['post-delete biometric counts are read from the local store'],
        limitations: ['Deleted biometric templates cannot be reconstructed without enrolling again.'],
      },
    }),
    evidence: capabilityEvidence({
      id: 'biometrics.templates.delete',
      operation: 'mutate',
      subjectArgument: 'type',
      limitations: ['The receipt covers the current user scope only.'],
    }),
  });
}
