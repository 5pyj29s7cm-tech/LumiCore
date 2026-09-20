import {describe,expect,it} from 'vitest';
import {buildActionContract,hasCoreActionEvidence} from '../server/cognition/action_contract';
import {routeToolsForTurn} from '../server/cognition/tool_router';
import {portraitAnimationFrame} from '../src/lib/memoryAvatarAnimation';
const names=['generate_image','ai_edit_image','get_image_generation_status','memory_avatar_read','memory_avatar_create','memory_avatar_import_image','memory_avatar_configure_animation','client_action','write_file','wechat_send_file','desktop_open','web_search','ocr_image_file'];
const declarations=names.map(name=>({type:'function' as const,function:{name,description:name,parameters:{type:'object',properties:{}}}}));
describe('real avatar acceptance regressions',()=>{
  it('keeps hair and a file reply out of WeChat while exposing image generation after a preamble',()=>{
    const text='先做第一步：用 Lumi 官方 API 生成一张图片，原创成年乙游男主，正面半身，温柔亲和、浅棕发、墨绿色衣装，背景为写实科幻观景室。只生成一张，完成后给我图片文件。';
    expect(buildActionContract(text).kind).not.toBe('messaging_send');
    expect(routeToolsForTurn(text,declarations).toolNames).toContain('generate_image');
    expect(buildActionContract('把文件发给小王').kind).toBe('messaging_send');
  });
  it('exposes the existing person workflow together, without source-code/desktop fallbacks',()=>{
    const text='为数字人生成一张人像图片，在记忆领地新建人物，导入素材并配置眨眼、口型动画，不要覆盖现有人物，不要使用内置旧素材。';
    const route=routeToolsForTurn(text,declarations);
    expect(route.categories).toEqual(['memory_avatar']);
    expect(route.toolNames).toEqual(expect.arrayContaining(names.filter(n=>n.startsWith('memory_avatar_'))));
    expect(route.toolNames).toContain('generate_image');expect(route.toolNames).not.toContain('write_file');expect(route.toolNames).not.toContain('wechat_send_file');
    const contract=buildActionContract(text);expect(contract.kind).toBe('avatar_authoring');
    const receipt=(animation:any)=>['memory_avatar_create','memory_avatar_import_image','memory_avatar_read'].map(name=>({name,result:JSON.stringify({ok:true,verified:true,saved:true,avatarId:'a',media:[{id:'m'}],animation})})) as any;
    expect(hasCoreActionEvidence(contract,receipt({configured:true,blink:false,speech:false}),text)).toBe(false);
    expect(hasCoreActionEvidence(contract,receipt({configured:true,blink:true,speech:true}),text)).toBe(true);
    expect(hasCoreActionEvidence(contract,receipt({configured:true,blink:true,speech:true}).slice(-1),text)).toBe(false);
    expect(hasCoreActionEvidence(contract,receipt({configured:true,blink:true,speech:true}),text+'需要呼吸和背景动画')).toBe(false);
  });
  it('does not regenerate when asked to import the existing result',()=>{
    const route=routeToolsForTurn('继续使用刚生成的人像图片，不再生图。在记忆领地新建一个人物，导入图片并配置动画。',declarations);
    expect(route.toolNames).toContain('memory_avatar_import_image');expect(route.toolNames).not.toContain('generate_image');
  });
  it('uses actual audio, respects reduced motion and never invents missing expression frames',()=>{
    const animation={idleMediaId:'a',blinkMediaId:'b',speakMediaId:'c',blinkInterval:5,breathing:.4,backgroundMotion:true};
    expect(portraitAnimationFrame(4.6,0,animation,false)).toMatchObject({blink:1,speech:0,ambience:true});
    expect(portraitAnimationFrame(4.6,.2,animation,true)).toMatchObject({blink:0,breath:0,speech:expect.any(Number),ambience:false});
    expect(portraitAnimationFrame(4.6,.2,{...animation,blinkMediaId:undefined,speakMediaId:undefined},false)).toMatchObject({blink:0,speech:0});
  });
});
