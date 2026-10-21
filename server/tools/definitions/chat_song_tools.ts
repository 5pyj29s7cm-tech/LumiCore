import { z } from 'zod';
import { mediaAuthoringMutationScope } from '../../cognition/media_creation_intent';
import { hasExplicitNoMutationInstruction } from '../../cognition/tool_intent';
import fs from 'node:fs';
import { CHAT_SONG_TEMPLATE } from '../../../shared/chat_song_layout';
import { CHAT_SONG_AUDIO_EXTENSIONS, chatSongSongCurrent } from '../../../shared/chat_song';
import { listGeneratedArchive } from '../../files/generated_archive';
import { CHAT_SONG_TOOL_ROUTING_HINTS } from '../../regions/packs/cn/chat_song';
import type { ToolContext } from '../types';
import { ToolRegistry } from '../registry';
import { capabilityContract, capabilityEvidence } from '../capability_contracts';
import { ChatSongError, applyChatSongAction, changeChatSongProject, chatSongHandoff, chatSongLibraryFile, confirmChatSongAudio, createChatSongProject, draftChatSongDialogue, searchChatSongProjectReactions, exportChatSongPackage, getChatSongProject, getChatSongRender, getChatSongAnimation, chatSongRenderInputSha, listChatSongProjects } from '../../creative/chat_song';
import { chatSongRenderTimeline, renderChatSongVideo } from '../../creative/chat_song_render';

const id = z.string().uuid(), revision = z.number().int().positive();
const checks = z.object({ noOmissions: z.literal(true), noRewrites: z.literal(true), noRepeats: z.literal(true), correctOrder: z.literal(true) }).strict();
const confirmation = z.object({ projectId: id, revision, songSha256: z.string().regex(/^[a-f0-9]{64}$/), scriptRevision: revision, checks }).strict();
const actions = ['create', 'save', 'lock-script', 'attach-asset', 'select-song', 'remove-asset', 'set-timings', 'export'] as const;
const mutation = z.object({ action: z.enum(actions), projectId: id, revision: revision.optional(), title: z.string().trim().min(1).max(100).optional(), templateId: id.optional(), value: z.unknown().optional() }).strict();
const selected = z.object({ projectId: id, revision }).strict();
function parse<T>(schema: z.ZodType<T>, args: unknown): T {
  const result = schema.safeParse(args);
  if (!result.success) throw new ChatSongError(400, 'Invalid chat-song tool arguments.');
  return result.data;
}
function owner(context?: ToolContext): string {
  if (!context?.userId || context.domain === 'work' || context.orgId || context.localExecution !== true) throw new ChatSongError(403, 'Chat-song projects require the authenticated personal desktop workspace.');
  context.executionSignal?.throwIfAborted();
  return context.userId;
}
function current(userId: string, projectId: string, expected: number) {
  const project = getChatSongProject(userId, projectId);
  if (project.revision !== expected) throw new ChatSongError(409, 'Project changed. Read its current revision first.');
  return project;
}
function confirmationArguments(args: Record<string, any>) {
  const { target: _target, content: _content, ...input } = args;
  return parse(confirmation, input);
}
function confirmationProject(args: z.infer<typeof confirmation>, context?: ToolContext) {
  const uid = owner(context), project = current(uid, args.projectId, args.revision);
  if (!project.scriptLocked || !project.song || project.scriptRevision !== args.scriptRevision || project.song.scriptRevision !== args.scriptRevision || project.song.sha256 !== args.songSha256
    || chatSongLibraryFile(uid, project.song.fileId, 'audio').sha256 !== args.songSha256) throw new ChatSongError(409, 'The dialogue or song changed. Listen to the current song and confirm it again.');
  return project;
}
const string = (description: string) => ({ type: 'string', description });
const rev = { type: 'integer', minimum: 1, description: 'Exact latest project revision returned by read/save.' };
const binding = { projectId: string('Exact owned project UUID.'), revision: rev };
export function registerChatSongTools(registry: ToolRegistry): void {
  const register = (name: string, description: string, properties: Record<string, any>, required: string[], handler: (args: any, context?: ToolContext) => Promise<unknown>, read = false, humanCheck = false) => {
    const capabilityId = 'creative.' + name;
    const operation = name === 'chat_song_draft_dialogue' || name === 'chat_song_render' ? 'create' : read ? 'observe' : 'mutate';
    registry.register({ name, description, routingHints: CHAT_SONG_TOOL_ROUTING_HINTS[name], parameters: { type: 'object', additionalProperties: false, properties, required }, permission: 'user', securityLevel: humanCheck ? 'confirm' : 'safe',
      ...(humanCheck ? {
        serverOwnedArgumentBinder: (args: Record<string, any>, context?: ToolContext) => {
          const value = confirmationArguments(args), project = confirmationProject(value, context);
          return { ...value, target: project.id, content: [
            'Confirm after listening: no omitted words; no rewritten words; no repeated lines; correct order.',
            'Project: ' + project.title + ' / revision ' + project.revision + ' / script ' + project.scriptRevision,
            'Song: ' + project.song!.name + ' / SHA-256 ' + project.song!.sha256,
            ...Array.from({ length: Math.ceil(project.lines.length / 3) }, (_, index) => project.lines.slice(index * 3, index * 3 + 3).map(line => line.id + ' ' + line.role + ': ' + line.text).join('\n')),
          ] };
        },
        preflight: (args: Record<string, any>, context?: ToolContext) => { confirmationProject(confirmationArguments(args), context); },
      } : name === 'chat_song_project' ? {
        serverOwnedArgumentBinder: (args: Record<string, any>, context?: ToolContext) => {
          const taskText=context?.acceptedActionContract?.taskText || context?.routedTaskText || context?.actionIntent || '';
          const mediaScope=mediaAuthoringMutationScope(taskText);
          if(!mediaScope || !mediaScope.projectSelectionRequested && !hasExplicitNoMutationInstruction(taskText))return args;
          const scope=mediaScope.projectSelection;
          const value=parse(mutation,args);
          const song=z.object({fileId:z.string().trim().min(1)}).strict().safeParse(value.value);
          if(!scope || value.action!=='select-song' || value.projectId!==scope.projectId || value.revision!==scope.revision || value.title!==undefined || value.templateId!==undefined || !song.success)throw new ChatSongError(403,'This turn permits only its exact owned project song selection.');
          return {...value,value:song.data};
        },
      } : name === 'chat_song_render' ? { preflight: (args: Record<string, any>, context?: ToolContext) => { const value = parse(selected, args), project = current(owner(context), value.projectId, value.revision); if (project.brief.outputStyle !== 'animation') chatSongRenderTimeline(project); } } : {}),
      handler: async (args, context) => JSON.stringify(await handler(args, context)),
      capability: capabilityContract({ id: capabilityId, family: 'chat-song', lane: name === 'chat_song_render' || read ? 'media' : 'general', operation, risk: humanCheck ? 'high' : 'low',
        sideEffects: [{ type: read ? 'local_read' : 'local_write', scope: 'the authenticated owner’s personal chat-song project and library media', reversible: true },
          ...(name === 'chat_song_draft_dialogue' ? [{ type: 'network_read' as const, scope: 'one user-selected official dialogue generation request and bounded public reaction-keyword search', reversible: true }] : []),
          ...(!read && name !== 'chat_song_draft_dialogue' ? [{ type: 'local_read' as const, scope: 'owned project and verified library inputs; no arbitrary command or URL execution', reversible: true }] : [])],
        verification: { strategy: name === 'chat_song_render' ? 'artifact' : 'state_diff', required: true, requiredFields: ['ok', 'verified'], requiredValues: { ok: true, verified: true },
          ...(read ? { successStatuses: ['read', 'retrieved'] } : {}),
          ...(name === 'chat_song_render' ? { requiredArtifacts: ['outputPath'], successStatuses: ['rendered'] } : {}), successSignals: ['Owned project state or existing render receipt returned'], limitations: ['Saved state is not proof of singing quality. Song lyric checks require the user to listen and confirm.'] } }),
      evidence: capabilityEvidence({ id: capabilityId, operation, subjectArgument: 'projectId' }),
    });
  };
  register('chat_song_read', 'List chat-song projects (omit projectId), read one owned project, or return its SELECTED EXISTING finished video with includeOutput=true. Use this read-only handoff instead of chat_song_render when the video already exists. For an attachment request, call includeOutput=true with the exact projectId directly; this only reads and verifies existing files, never renders or generates. Pass revision when an exact version was requested. Missing, outdated or changed outputs are rejected. Ordinary reads do not attach videos. Lists include the generated song library; use knowledge_file_stats for uploaded media. Personal desktop only.', { projectId: binding.projectId, revision: rev, includeOutput: { type: 'boolean', description: 'Explicitly return the selected existing verified video as an attachment. Requires an exact projectId. Default false; never creates a video.' } }, [], async (args, context) => {
    const value = parse(z.object({ projectId: id.optional(), revision: revision.optional(), includeOutput: z.boolean().optional() }).strict(), args), uid = owner(context);
    if (!value.projectId) {
      if (value.includeOutput || value.revision !== undefined) throw new ChatSongError(400, 'An exact projectId is required to return an existing video or check its revision.');
      const files = (await listGeneratedArchive({ userId: uid, domain: 'personal' })).filter(file => CHAT_SONG_AUDIO_EXTENSIONS.some(extension => file.filename.toLowerCase().endsWith(extension)));
      return { ok: true, verified: true, status: 'read', projects: listChatSongProjects(uid).map(project => ({ id: project.id, title: project.title, revision: project.revision, lineCount: project.lines.length })),
        library: { source: 'generated_archive', total: files.length, truncated: files.length > 100, files: files.slice(0, 100).map(file => ({ fileId: file.filename, name: file.displayName, kind: file.kind, size: file.size, sha256: file.sha256 })) } };
    }
    const project = value.revision === undefined ? getChatSongProject(uid, value.projectId) : current(uid, value.projectId, value.revision);
    const render = getChatSongRender(uid, project.id);
    if (!value.includeOutput) return { ok: true, verified: true, status: 'read', projectId: project.id, revision: project.revision, project, render };
    if (!chatSongSongCurrent(project)) throw new ChatSongError(409, 'No finished video matches the current finalized script and selected song.');
    if (chatSongLibraryFile(uid, project.song!.fileId, 'audio').sha256 !== project.song!.sha256) throw new ChatSongError(409, 'The selected song changed. Select it again.');
    const animation = project.brief.outputStyle === 'animation';
    const output = animation ? getChatSongAnimation(uid, project.id) : render;
    if (!output || !Number.isFinite(output.duration) || Math.abs(output.duration - project.song!.duration) > 0.15) throw new ChatSongError(409, 'No current selected finished video is available.');
    if (animation) {
      if (!('scriptRevision' in output) || output.scriptRevision !== project.scriptRevision || output.songSha256 !== project.song!.sha256) throw new ChatSongError(409, 'The animation belongs to an earlier script or song.');
    } else {
      if (!('sourceInputsSha256' in output) || output.sourceRevision !== project.revision || output.sourceInputsSha256 !== chatSongRenderInputSha(project) || output.templateVersion !== CHAT_SONG_TEMPLATE.version) throw new ChatSongError(409, 'The chat video is outdated. Compose the selected current version first.');
      for (const asset of project.assets) {
        context?.executionSignal?.throwIfAborted();
        if (chatSongLibraryFile(uid, asset.fileId, asset.kind === 'clip' ? 'video' : 'image').sha256 !== asset.sha256) throw new ChatSongError(409, 'A selected input changed. Select it again.');
      }
    }
    const file = chatSongLibraryFile(uid, output.fileId, 'video');
    if (file.sha256 !== output.sha256) throw new ChatSongError(409, 'The finished video changed. Select or compose it again.');
    context?.executionSignal?.throwIfAborted(); current(uid, project.id, project.revision);
    return { ok: true, verified: true, status: 'retrieved', projectId: project.id, revision: project.revision, selectedStyle: animation ? 'animation' : 'chat',
      scriptRevision: project.scriptRevision, songSha256: project.song!.sha256, outputPath: file.path,
      artifacts: [{ type: 'video', path: file.path, sha256: file.sha256, size: fs.statSync(file.path).size }], output };
  }, true);
  register('chat_song_project', 'Create or edit a chat-song singing project using the SAME editor business functions. Reuse projectId for creation retries. Save complete title/brief/lines via value, optionally including reactions:[{lineId,candidateId}] from the SAME revision draft/search to adopt selected online memes atomically. Never invent candidate IDs or image URLs. Also lock-script; attach-asset or select-song from an existing owned library fileId; remove-asset; set-timings; export. Never confirms song lyrics. Get the current revision first; do not invent singing audio or mark unlistened lyrics approved.', {
    ...binding, action: { type: 'string', enum: actions }, title: string('New project title, required for create.'), templateId: string('Optional existing owned template UUID for create.'), value: { description: 'Existing editor action value: full title/brief/lines for save, {kind,lineId,fileId} for attach, {fileId} for song, asset UUID for remove, or full [{lineId,start,end}] timings.' },
  }, ['action', 'projectId'], async (args, context) => {
    const value = parse(mutation, args), uid = owner(context);
    if (value.action === 'create') {
      const project = await createChatSongProject(uid, { id: value.projectId, title: value.title, ...(value.templateId ? { templateId: value.templateId } : {}) }, context?.executionSignal);
      return { ok: true, verified: true, saved: true, status: 'saved', projectId: project.id, revision: project.revision, project };
    }
    const project = current(uid, value.projectId, parse(revision, value.revision));
    if (value.action === 'export') return { ok: true, verified: true, status: 'exported', projectId: project.id, revision: project.revision, bundle: await exportChatSongPackage(uid, project, context?.executionSignal) };
    const saved = await applyChatSongAction(uid, project.id, project.revision, value.action, value.value, context?.executionSignal);
    return { ok: true, verified: true, saved: true, status: 'saved', projectId: saved.id, revision: saved.revision, project: saved };
  });
  register('chat_song_draft_dialogue', 'Draft candidate A/B dialogue from the saved brief and lines and match public online memes; first save new chat requirements through chat_song_project action=save and use its returned revision. Set searchOnly=true to search reaction keywords in the SAVED dialogue without calling the dialogue model or rewriting any line. Normal drafting uses one dialogue model call plus public meme keyword matching and owned candidate-image caching, never AI reaction-image generation. It does not automatically save the project, generate a song or approve lyrics. Adopt selected candidates with the returned lines through the existing project save action after review. Local-only privacy blocks external searches and cloud drafting.', { ...binding, searchOnly: { type: 'boolean', description: 'Only search online memes for the current saved dialogue; no dialogue model call or project mutation. Default false.' } }, ['projectId', 'revision'], async (args, context) => {
    const value = parse(selected.extend({ searchOnly: z.boolean().optional() }), args), uid = owner(context);
    if (value.searchOnly) return { ok: true, verified: true, status: 'searched', saved: false, projectId: value.projectId,
      ...await searchChatSongProjectReactions(uid, value.projectId, value.revision, undefined, context?.executionSignal, context?.dataRoutingPolicy) };
    if (!context?.llmGetters) throw new ChatSongError(503, 'Dialogue model clients are unavailable.');
    const draft = await draftChatSongDialogue(uid, value.projectId, value.revision, context.llmGetters, context.executionSignal, context.dataRoutingPolicy);
    return { ok: true, verified: true, status: 'drafted', saved: false, projectId: value.projectId, ...draft };
  });
  register('chat_song_render', 'For existing-file attachments use chat_song_read with includeOutput=true; it returns the verified saved file without rendering. Deliver only the saved project outputStyle. Chat style uses its real selected song, finalized dialogue and complete line timings for local composition. Animation style returns only an already bound verified finished animation and never renders a second chat version or starts paid generation. Lyric review is optional and is never approved by rendering. Does not synthesize singing. Reuses the editor renderer and cached output SHA; cancellation publishes no unfinished render.', binding, ['projectId', 'revision'], async (args, context) => {
    const value = parse(selected, args), uid = owner(context);
    const render = await renderChatSongVideo(uid, value.projectId, value.revision, context?.executionSignal);
    const outputPath = chatSongLibraryFile(uid, render.fileId, 'video').path;
    return { ok: true, verified: true, status: 'rendered', projectId: value.projectId, revision: value.revision, render, outputPath, artifacts: [{ type: 'video', path: outputPath }] };
  });
  register('chat_song_confirm_song', 'Ask the USER to confirm listening to this exact song against this exact locked dialogue: no omissions, no rewritten words, no repeated lines, correct order. Never self-certify these checks. This call always requires exact user confirmation and is bound to project/revision/song SHA/scriptRevision. A changed song or dialogue requires a NEW check.', {
    ...binding, songSha256: string('Exact SHA-256 from the selected song receipt.'), scriptRevision: { type: 'integer', minimum: 1 }, checks: { type: 'object', additionalProperties: false, properties: { noOmissions: { const: true }, noRewrites: { const: true }, noRepeats: { const: true }, correctOrder: { const: true } }, required: ['noOmissions', 'noRewrites', 'noRepeats', 'correctOrder'] },
  }, ['projectId', 'revision', 'songSha256', 'scriptRevision', 'checks'], async (args, context) => {
    const value = confirmationArguments(args), uid = owner(context);
    if (context?.userConfirmed !== true) throw new ChatSongError(403, 'The user must confirm these exact song checks.');
    confirmationProject(value, context);
    const project = await changeChatSongProject(uid, value.projectId, value.revision, draft => {
      confirmationProject(value, context);
      confirmChatSongAudio(draft, value.checks);
    }, context.executionSignal);
    return { ok: true, verified: true, saved: true, status: 'confirmed', projectId: project.id, revision: project.revision, songSha256: project.song!.sha256, scriptRevision: project.scriptRevision };
  }, false, true);
}
