import { getLocale, type Locale } from '../runtime';

const AVATAR_STUDIO_COPY = {
  en: {
    petDescriptions: {
      'lumi-cat': 'A warm, comforting cat that blinks, wags its tail, and waves. A gentle everyday companion.',
      'lumi-blob': 'A soft, bouncy blob with bright eyes and a lively, playful style.',
      'lumi-bird': 'A round little bird that flaps and chirps with a light, energetic character.',
      'lumi-dragon': 'A miniature dragon with wings and small horns for a playful fantasy style.',
      'lumi-fox': 'A clever orange fox with large ears and a fluffy white-tipped tail.',
      'lumi-rabbit': 'A gentle white rabbit with long floppy ears and a small round tail.',
      'lumi-bear': 'A reassuring brown bear with round ears and sturdy paws.',
      'lumi-hamster': 'A tiny round hamster with full cheeks and miniature ears.',
    },
    species: { cat: 'Cat', blob: 'Blob', bird: 'Bird', dragon: 'Dragon', fox: 'Fox', rabbit: 'Rabbit', bear: 'Bear', hamster: 'Hamster' },
    patterns: { striped: 'Striped', spotted: 'Spotted', bicolor: 'Bicolor', gradient: 'Gradient' },
    specials: { glowing: 'Glow', sparkly: 'Sparkle' },
    animations: { idle: 'Idle', run: 'Run', wave: 'Wave', jump: 'Jump', waiting: 'Wait' },
    colorSlots: [
      { key: 'body', label: 'Body', desc: 'Main color' },
      { key: 'accent', label: 'Accent', desc: 'Ears / horns / wings' },
      { key: 'belly', label: 'Belly', desc: 'Belly color' },
      { key: 'eye', label: 'Eyes', desc: 'Eye color' },
    ],
    categories: { hat: 'Hats', glasses: 'Glasses', scarf: 'Scarves', collar: 'Collars', ears: 'Ears', tail: 'Tails', mask: 'Masks', back: 'Back', faceMark: 'Marks', aura: 'Auras' },
    accessoryNames: { hat_propeller: 'Propeller Hat', hat_crown: 'Crown', glasses_round: 'Round Glasses', glasses_sunglasses: 'Sunglasses', scarf_warm: 'Warm Scarf', collar_spiked: 'Spiked Collar', ears_bunny: 'Bunny Ears', ears_cat: 'Cat Ears', tail_cat: 'Cat Tail', mask_surgical: 'Surgical Mask', mask_fox: 'Fox Mask', back_backpack: 'Tiny Backpack', back_bow: 'Back Bow', back_miniwings: 'Mini Wings', face_blush: 'Blush', face_star: 'Star Mark', face_heart: 'Heart Mark', aura_halo: 'Halo', aura_sparkles: 'Sparkles' },
  },
  zh: {
    petDescriptions: {
      'lumi-cat': '温暖治愈的猫猫，会眨眼、摇尾巴、撒娇挥手。适合日常陪伴。',
      'lumi-blob': 'Q弹软萌的史莱姆，一蹦一跳、眼睛闪闪。活泼可爱风。',
      'lumi-bird': '圆滚滚的小鸟，扑腾翅膀、叽叽喳喳。轻快灵动风。',
      'lumi-dragon': '迷你小龙，有翅膀和小角。适合喜欢奇幻风格的用户。',
      'lumi-fox': '橙色小狐狸，三角大耳、蓬松尾巴带白尖。机灵俏皮。',
      'lumi-rabbit': '软萌小白兔，长耳朵垂下来、圆圆短尾巴。温柔治愈。',
      'lumi-bear': '棕色小熊，圆耳朵、厚实爪垫。憨态可掬，给人安全感。',
      'lumi-hamster': '圆圆小仓鼠，鼓鼓的腮帮子、迷你小耳朵。超萌可爱。',
    },
    species: { cat: '猫咪', blob: '史莱姆', bird: '小鸟', dragon: '小龙', fox: '狐狸', rabbit: '兔子', bear: '小熊', hamster: '仓鼠' },
    patterns: { striped: '条纹', spotted: '斑点', bicolor: '双色', gradient: '渐变' },
    specials: { glowing: '发光', sparkly: '闪光' },
    animations: { idle: '待机', run: '奔跑', wave: '挥手', jump: '跳跃', waiting: '等待' },
    colorSlots: [
      { key: 'body', label: '身体', desc: '主体颜色' },
      { key: 'accent', label: '装饰', desc: '耳朵/角/翅膀' },
      { key: 'belly', label: '腹部', desc: '肚皮颜色' },
      { key: 'eye', label: '眼睛', desc: '瞳孔颜色' },
    ],
    categories: { hat: '帽子', glasses: '眼镜', scarf: '围巾', collar: '项圈', ears: '耳朵', tail: '尾巴', mask: '面具', back: '背饰', faceMark: '印记', aura: '光环' },
    accessoryNames: { hat_propeller: '竹蜻蜓帽', hat_crown: '皇冠', glasses_round: '圆框眼镜', glasses_sunglasses: '墨镜', scarf_warm: '保暖围巾', collar_spiked: '铆钉项圈', ears_bunny: '兔耳朵', ears_cat: '猫耳朵', tail_cat: '猫尾巴', mask_surgical: '口罩', mask_fox: '狐狸面具', back_backpack: '小背包', back_bow: '蝴蝶结', back_miniwings: '小翅膀', face_blush: '腮红', face_star: '星星印记', face_heart: '心形印记', aura_halo: '光环', aura_sparkles: '星光' },
  },
} as const;

export function avatarStudioCopy(locale: Locale = getLocale()) {
  return AVATAR_STUDIO_COPY[locale];
}
