import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { ToolRegistry } from '../registry';
import type { ToolContext } from '../types';
import { capabilityContract, capabilityEvidence } from '../capability_contracts';
import { createMemoryAvatar, getMemoryAvatar, listMemoryAvatars, updateMemoryAvatar } from '../../memory_avatar/store';
import { getMemoryAvatarMediaFile, listMemoryAvatarMedia, uploadMemoryAvatarMedia } from '../../memory_avatar/media';
import { avatarMediaDirectory, AVATAR_MEDIA_MAX_BYTES } from '../../memory_avatar/media_files';
import { getDataPath } from '../../config/data_path';

function owner(context: ToolContext): string {
  if (!context.userId || context.domain === 'work' || context.orgId || context.localExecution !== true) throw new Error('Memory person authoring requires the authenticated personal desktop workspace.');
  context.executionSignal?.throwIfAborted();
  return context.userId;
}
function readPerson(userId: string, avatarId: string) {
  const a = getMemoryAvatar(userId, avatarId);
  if (!a || a.status !== 'active') throw new Error('Active memory person not found in this workspace.');
  const animation = a.presentation?.mode === 'localportrait' ? a.presentation.animation : undefined;
  if (animation) for (const id of [animation.idleMediaId, animation.blinkMediaId, animation.speakMediaId].filter(Boolean)) getMemoryAvatarMediaFile(userId, a.id, id!);
  return { ok: true, verified: true, saved: true, status: 'saved', avatarId: a.id, revision: a.revision,
    speechDriver: 'Lumi live reply audio drives the mouth animation during conversation. A prerecorded audio upload is NOT required; the normal Lumi voice service must be available.',
    avatar: { id: a.id, name: a.name, narrative: a.narrative, publicBrief: a.publicBrief, appearance: a.appearance, presentation: a.presentation, voice: a.voice },
    media: listMemoryAvatarMedia(userId, a.id).media,
    animation: { configured: Boolean(animation), blink: Boolean(animation?.blinkMediaId), speech: Boolean(animation?.speakMediaId), breathing: Boolean(animation?.breathing), backgroundMotion: Boolean(animation?.backgroundMotion) },
    limitation: 'Saved configuration and readable image frames are verified. Visual quality and alignment must still be checked in the person preview. This is local 2.5D animation, not a rigged 3D human.' };
}
function requestKey(context: ToolContext, args: unknown): string {
  if (!context.idempotencyKey && !context.requestId) throw new Error('A durable request identity is required.');
  return createHash('sha256').update(JSON.stringify([context.idempotencyKey || context.requestId, args])).digest('hex');
}
const string = (description: string) => ({ type: 'string', description });
export function registerMemoryAvatarTools(registry: ToolRegistry): void {
  const register = (name: string, description: string, properties: Record<string, any>, required: string[], handler: (args: any, context: ToolContext) => Promise<unknown>, read = false) => {
    const id = `memory.person.${name.replace('memory_avatar_', '')}`;
    registry.register({ name, description, parameters: { type: 'object', properties, required }, permission: 'user', securityLevel: 'safe',
      handler: async (args, context) => JSON.stringify(await handler(args, context || {})),
      capability: capabilityContract({ id, family: 'memory-person-authoring', lane: 'memory', operation: read ? 'observe' : 'mutate', risk: 'low',
        sideEffects: [{ type: read ? 'local_read' : 'local_write', scope: 'the authenticated owner’s selected memory person and private image media', reversible: true }],
        verification: { strategy: 'state_diff', required: true, requiredFields: ['ok', 'verified'], requiredValues: { ok: true, verified: true }, successSignals: ['Durable person state read after saving'], limitations: ['Configuration readback does not verify subjective animation quality.'] } }),
      evidence: capabilityEvidence({ id, operation: read ? 'observe' : 'mutate', subjectArgument: 'avatarId' }),
    });
  };
  register('memory_avatar_read', 'List memory people (omit avatarId) or read one person, its saved media and animation readiness. Use after saving to verify the exact person. Personal desktop only.', { avatarId: string('Exact person ID, optional for listing.') }, [], async (args, context) => {
    const uid = owner(context);
    return args.avatarId ? readPerson(uid, args.avatarId) : { ok: true, verified: true, avatars: listMemoryAvatars(uid).map(a => ({ id:a.id, name:a.name, revision:a.revision, presentation:a.presentation })) };
  }, true);
  register('memory_avatar_create', 'Create a separate memory person with owner-approved identity. Does not overwrite existing people or generate images. Import generated images and configure animation with the companion tools; do not edit code/databases.', { name:string('New person name.'), narrative:string('Private biography, up to 2000 characters.'), publicBrief:string('Only approved public identity, up to 4000 characters.') }, ['name'], async (args, context) => {
    const uid = owner(context);
    const a = await createMemoryAvatar({ userId:uid, clientRequestId:requestKey(context,args), name:args.name, narrative:args.narrative || '', publicBrief:args.publicBrief || '' });
    return readPerson(uid, a.id);
  });
  register('memory_avatar_import_image', 'Copy one generated or owner-provided local image into a selected memory person. Source is preserved. Use each receipt media.id for animation. Never reads credentials or another person’s private media directory.', { avatarId:string('Exact person ID.'), filePath:string('Absolute PNG/JPEG/WebP path from a verified generation receipt or owner instruction.'), title:string('Expression name, such as neutral, eyes closed, mouth open.') }, ['avatarId','filePath','title'], async (args, context) => {
    const uid = owner(context); const a = getMemoryAvatar(uid,args.avatarId);
    if (!a || a.status !== 'active') throw new Error('Person not found.');
    if (!path.isAbsolute(args.filePath)) throw new Error('An absolute image path is required.');
    const filename = await fs.realpath(args.filePath);
    const stat = await fs.lstat(args.filePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > AVATAR_MEDIA_MAX_BYTES.image || !/\.(png|jpe?g|webp)$/i.test(filename)) throw new Error('Use a regular PNG/JPEG/WebP image within 20 MiB.');
    const privateRoot = path.resolve(getDataPath('memory_avatar_media'));
    const relative = path.relative(privateRoot, filename);
    if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) throw new Error('Use the owner source image; private person media cannot be imported across people by filesystem path.');
    const temp = path.join(avatarMediaDirectory(uid,a.id), `.import-${randomUUID()}`);
    try {
      await fs.copyFile(filename,temp); context.executionSignal?.throwIfAborted();
      const result = await uploadMemoryAvatarMedia(uid,a.id,{path:temp,title:args.title,clientRequestId:requestKey(context,args),revision:a.revision,signal:context.executionSignal});
      return { ...readPerson(uid,a.id), importedMedia:result.media };
    } finally { await fs.rm(temp,{force:true}); }
  });
  register('memory_avatar_configure_animation', 'Save local 2.5D animation using aligned normal, closed-eye and open-mouth images already imported into this person. For blinking and speech, generate matching expression variants with ai_edit_image from the SAME neutral image, preserving pose/background/crop; then import each. Do not reuse the same image as different expressions. No Alibaba/D-ID key is needed. Omit missing expressions and explicitly report that limitation. Mouth motion is driven only by real audio.', {
    avatarId:string('Exact person ID.'), revision:{type:'integer',description:'Latest revision from read/import receipt.'}, idleMediaId:string('Normal expression image ID.'), blinkMediaId:string('Matching eyes-closed expression image ID.'), speakMediaId:string('Matching mouth-open expression image ID.'),
    blinkInterval:{type:'number',description:'Seconds between blinks, 2–12, default 5.'}, breathing:{type:'number',description:'Subtle breathing intensity 0–1, default 0.4.'}, backgroundMotion:{type:'boolean',description:'Local ambient light/particle motion, default true.'},
  }, ['avatarId','revision','idleMediaId'], async(args, context) => {
    const uid=owner(context);
    await updateMemoryAvatar(uid,args.avatarId,{revision:args.revision,presentation:{mode:'localportrait',mediaId:args.idleMediaId,animation:{idleMediaId:args.idleMediaId,
      ...(args.blinkMediaId ? {blinkMediaId:args.blinkMediaId}:{}),...(args.speakMediaId?{speakMediaId:args.speakMediaId}:{}),blinkInterval:args.blinkInterval??5,breathing:args.breathing??0.4,backgroundMotion:args.backgroundMotion??true}}});
    return readPerson(uid,args.avatarId);
  });
}
