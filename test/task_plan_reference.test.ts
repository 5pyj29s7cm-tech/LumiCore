import './helpers';
import {describe,expect,it} from 'vitest';
import {resolveAcceptedFilePlan} from '../server/conversation/task_plan_reference';
const plan={id:'plan',role:'user',message:'读取 C:/Documents/orders.csv，计算总额。先只告诉我准备怎么做，暂时不要读取文件。'};
describe('server-owned plan acceptance scope',()=>{
  it('does not accept assistant-invented goals or skip a newer user topic',()=>{
    const text='按刚才的计划执行。';
    expect(resolveAcceptedFilePlan({text,history:[{...plan,role:'assistant'}]})).toBeUndefined();
    expect(resolveAcceptedFilePlan({text,history:[plan,{role:'user',message:'先聊聊别的事情。'}]})).toBeUndefined();
    expect(resolveAcceptedFilePlan({text:'不要按刚才的计划执行。',history:[plan]})).toBeUndefined();
    expect(resolveAcceptedFilePlan({text:'按刚才的计划执行，顺便删除文件。',history:[plan]})).toBeUndefined();
  });
  it('does not remove permanent prohibitions with a combined planning clause',()=>{
    expect(resolveAcceptedFilePlan({text:'按刚才的计划执行。',history:[{...plan,message:plan.message.replace('暂时不要读取文件','不要修改原文件')}]})).toBeUndefined();
  });
});
