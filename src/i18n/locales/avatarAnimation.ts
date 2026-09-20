const zh = {
  title:'本地动态人像', hint:'使用同一人物、相同构图的正常、闭眼和开口图片。无需阿里云或 D-ID 密钥；这是本地 2.5D 动画。',
  idle:'正常表情', blink:'闭眼表情', speech:'开口表情', none:'未选择', interval:'眨眼间隔（秒）', breathing:'呼吸幅度', background:'环境微动',
  save:'保存并使用本地动画', saved:'动画已保存。打开人物预览检查效果。', error:'未能保存，请重新打开资料检查素材和版本。',
  missing:'缺少闭眼或开口图片时，对应动画不可用。请先在素材里上传，或让 Lumi 生成并导入。', loadError:'人物动画素材读取失败，请检查是否仍保存在该人物资料中。', loading:'正在读取人物素材…',
  optionalCloud:'可选：阿里云数字人服务', cloudHint:'当前本地形象无需填写。仅在选择阿里云生成画面时配置。',
};
const en:typeof zh = {
  title:'Local animated portrait', hint:'Use aligned neutral, closed-eye and open-mouth images of the same person. Local 2.5D animation needs no Alibaba Cloud or D-ID credentials.',
  idle:'Neutral expression',blink:'Eyes closed',speech:'Mouth open',none:'Not selected',interval:'Blink interval (seconds)',breathing:'Breathing intensity',background:'Ambient motion',
  save:'Save and use local animation',saved:'Animation saved. Check the person preview.',error:'Could not save. Reopen the profile and check media and revision.',
  missing:'Blinking and speech need their respective expression images. Upload them in Media, or ask Lumi to generate and import them.',loadError:'Could not load this person’s animation images. Check the saved media.',loading:'Loading portrait images…',
  optionalCloud:'Optional: Alibaba Cloud avatar',cloudHint:'No configuration is needed for the current local character. Configure only for cloud-rendered video.',
};
export const avatarAnimationCopy=(locale:'zh'|'en')=>locale==='en'?en:zh;
