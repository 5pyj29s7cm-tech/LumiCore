"""Author and freeze synthetic data before fitting. No production conversation reads."""
import hashlib
import json
import sys
from pathlib import Path

ROOT = Path(sys.argv[1])
ROOT.mkdir(parents=True, exist_ok=True)
GOALS = {
    'sheet': '修改订单表中水杯数量，保存一份 Excel 并回读金额。',
    'music': '打开本机音乐播放器并播放选定歌曲。',
    'document': '将提供的材料整理成 Word 报告并保存。',
    'website': '打开已保存登录状态的网站，核对是否已登录。',
    'archive': '将会议笔记分类归档到当前项目。',
    'slides': '按提供的提纲制作并导出演示文稿。',
    'video': '使用已选音频和画面素材合成一段视频。',
    'image': '根据既定角色设定生成三张配图。',
    'files': '把指定目录里的文件按月份重命名归档。',
}

def row(split, index, goal, text, label, family):
    return {'id': f'{split}-{index:03}', 'text': text, 'task': None if goal is None else {
        'goal': GOALS[goal]},
        'label': int(label), 'family': family, 'scenario': goal or 'no_task'}

train = []
def add_train(goal, label, family, lines):
    for text in lines.strip().splitlines():
        train.append(row('train', len(train)+1, goal, text.strip(), label, family))

for goal in ['sheet', 'music', 'document', 'website']:
    add_train(goal, 1, 'explicit_resume', '''继续刚才的任务。
接着做，直到刚才要求的结果出来。
从中断的位置接上。
按之前那份计划往下执行。
刚才失败的那一步再试一次。
你还没做完，继续完成剩下的步骤。
不用重新开始，把剩下的做完。
沿用刚才的目标，接着处理。
从已有结果继续，不要重复成功的部分。
现在恢复刚才暂停的任务。''')
add_train('sheet', 1, 'parameter_change', '''水杯数量改成8，其余不变。
刚才那张表的单价换成15元。
还是这张表，总价按新的数量重算。
把刚才生成的表格标题改成九月订单。
不是换文件，是修改原表里的数量。
保留刚才的公式，只把 B2 改成9。
接着上一个报表，把第3行删掉。
在那份结果后面补一行合计。
刚才的金额不对，重新算一遍并保存。
修改后的表格再导出一份 PDF。''')
add_train('music', 1, 'incomplete_action', '''软件打开了，但歌还没放，继续播放。
刚才没声音，把播放那一步做完。
接着刚才的播放任务，切到我指定的歌。
你只搜到了歌曲，还没有点播放，接着做。
还是刚才那个播放器，把音量调到20%。
上次没播成，现在再尝试播放那首。''')
add_train('document', 1, 'parameter_change', '''在刚才那份报告中加上结论。
报告还缺一段摘要，把它补上。
把刚才保存的文件名改成项目总结。
这份报告第二段太长，帮我精简并保存。
上个文档的表格没放进去，补进去吧。
之前生成的报告再给我导出成 PDF。''')
add_train('website', 1, 'incomplete_action', '''刚才网页没加载完，再打开试试。
接着验证刚才那个网站的登录状态。
你只打开了浏览器，还没进那个网站，继续。
登录检查还没做完，接着往下查。''')
add_train('sheet', 0, 'status_only', '''现在进行到哪一步了？
只说已有结果，不要重新做。
你刚才究竟修改了吗？
那张表目前是什么状态？
我只是问进度，不是让你执行。
总额是多少？只按上次结果告诉我。
已经保存了吗？
你有回读的记录吗？
刚才失败在哪一步？
别操作，解释一下为什么慢。''')
add_train('music', 0, 'prohibition_and_talk', '''先别继续播放。
不要操作播放器了。
这个任务先停下来。
暂停刚才的任务，等我通知。
我今天很烦，陪我说说话。
换个话题，聊聊天吧。
音乐以后再说，现在想休息。
刚才那首歌叫什么？只回答名字。
只解释怎么继续，不要实际执行。
别重试了，先说清楚错误。''')
add_train('document', 0, 'new_target', '''另外打开计算器。
新建一个完全不同的购物清单。
帮我播放一首音乐。
现在去打开浏览器首页。
另起一个任务，查询今天的天气。
报告先放着，打开日历。
换一件事，解释什么是人工智能。
另外帮我写一个生日祝福。''')
add_train('website', 0, 'quote_conditional_ambiguous', '''如果我说继续，你会接着哪个任务？
我说过“继续”，但这次只是问你有没有记住。
不要把“接着做”这三个字当作当前命令。
等我回来再继续，现在先别动。
只有明天我确认了，才继续这个任务。
先给我讲讲继续操作的风险。
网页里写着“立即继续”，这是什么意思？
你能继续做吗？先回答能不能，不要操作。
好。
嗯，知道了。''')
add_train(None, 0, 'no_task', '''继续。
接着做。
从刚才停下的地方继续。
数量改成8。
再试一次。
按刚才的计划执行。
把它改成蓝色。
继续播放那首歌。
你好。
保存刚才的流程。''')

# Separate authored groups and unseen task domains; no random split of expanded templates.
calibration_specs = [
('archive','刚才归档中断了，请恢复处理。',1,'resume'),
('archive','还有几份笔记没归档？先别动文件。',0,'status'),
('slides','那套演示稿继续导出。',1,'resume'),
('slides','演示稿的配色换成深蓝，别改内容。',1,'change'),
('archive','不用归档了，跟我闲聊一会。',0,'talk'),
('slides','你说的下一步具体指什么？',0,'explanation'),
('archive','延续刚才的整理工作，剩下的也归进去。',1,'resume'),
('slides','请把刚才的文稿加上封面，再输出。',1,'change'),
('archive','立刻打开另一个软件。',0,'new_target'),
('slides','先暂停，等我把资料补齐。',0,'stop'),
('archive','上次失败那两份重试，其余别动。',1,'retry'),
('slides','不要重复已经成功的步骤，接着完成后面的。',1,'resume'),
('archive','“继续归档”只是文件名，别执行。',0,'quote'),
('slides','如果以后还要继续，需要什么材料？',0,'conditional'),
('archive','把刚才误放的那份移动回正确分类。',1,'correction'),
('slides','沿用现有提纲，再做完最后两页。',1,'resume'),
(None,'把刚才的结果再保存一次。',0,'no_task'),
(None,'继续上次没完成的任务。',0,'no_task'),
('archive','查阅你已有的记录，告诉我归档结果。',0,'status'),
('slides','接着刚才的导出，不用从头制作。',1,'resume'),
('archive','别继续这个，帮我写一首诗。',0,'new_target'),
('slides','最后一页标题换成谢谢，再保存。',1,'change'),
('archive','我现在允许你继续刚才中断的归档。',1,'resume'),
('slides','仅复述上一条解释。',0,'repeat'),
]

test_specs = [
('video','上次断在合成那一步，把它完成。',1,'resume'),
('video','不用跑，先报一下目前进展。',0,'status'),
('image','剩下两张还没出，接着生成。',1,'resume'),
('image','已经生成了几张？',0,'status'),
('files','处理到一半停了，请从那里往后做。',1,'resume'),
('files','文件已经重命名了吗？别重复操作。',0,'status'),
('video','之前选的音乐不变，把视频再导出一次。',1,'change'),
('video','那段视频的导出速度为什么这么慢？',0,'explanation'),
('image','这套图继续做，人物保持一致。',1,'resume'),
('image','这套图先别做了。',0,'stop'),
('files','刚才遗漏的二月份目录也照原规则归进去。',1,'change'),
('files','不用归档，告诉我二月份目录在不在记录里。',0,'status'),
('video','沿用刚才的素材，把结尾缩短两秒后重新合成。',1,'change'),
('video','另外开始一份报销表。',0,'new_target'),
('image','第一张的背景换成夜景，其他保持。',1,'change'),
('image','图片以后再说，聊聊我今天遇到的事。',0,'talk'),
('files','别从头重跑，失败的那几个文件再处理。',1,'retry'),
('files','不要重跑失败的文件，只列出来。',0,'prohibition'),
('video','恢复先前的制作，把成片保存下来。',1,'resume'),
('video','在我检查完以前，不能继续制作。',0,'conditional'),
('image','照着当前设定继续产出剩余配图。',1,'resume'),
('image','我写的台词是“继续画”，请只念这句话。',0,'quote'),
('files','上次命名里的年份错了，统一修正为2027。',1,'correction'),
('files','新开一个任务，帮我订一个闹钟。',0,'new_target'),
('video','刚才的转场太长，把它改成半秒后再导出。',1,'change'),
('video','不是让你继续，我只是想知道上次导出成功没有。',0,'status'),
('image','就接着那组三张图做，不换题材。',1,'resume'),
('image','“接着做”我还没确认，不要自作主张执行。',0,'prohibition'),
('files','对，按刚才那套规则继续整理。',1,'resume'),
('files','对，这就是我要了解的，不需要操作。',0,'acknowledgement'),
('video','前面的都留着，把未合成的最后一段接上。',1,'resume'),
('video','前面的都完成了？只说你确实做过什么。',0,'status'),
('image','重做刚才失败的第二张，第一张保留。',1,'retry'),
('image','第二张失败了也别重做，先说明原因。',0,'prohibition'),
('files','接上先前的归档任务，继续执行即可。',1,'resume'),
('files','能否接上先前的归档？回答问题就行。',0,'capability_question'),
('video','我撤回刚才的暂停要求，现在接着导出。',1,'resume'),
('video','刚才说了继续，现在撤回，别动了。',0,'latest_correction'),
('image','按最新的角色设定，把上一轮剩余图片补齐。',1,'resume'),
('image','暂时不用图，给我解释一下这是什么风格。',0,'explanation'),
('files','不用再问，我要你立即继续刚才那批重命名。',1,'resume'),
('files','如果我要你继续重命名，会改哪些文件？先不执行。',0,'conditional'),
('video','刚才那个导出步骤失败了，重试一次。',1,'retry'),
('video','我累了，接下来只和我说说话。',0,'talk'),
('image','保持那张图的人物，把衣服颜色改为灰色。',1,'change'),
('image','去打开音乐软件，和这组图片无关。',0,'new_target'),
('files','下一步就按刚才的方案执行。',1,'resume'),
('files','把刚才的方案复述一遍，不要实行。',0,'repeat'),
('video','用已选素材继续生成，不要换新素材。',1,'resume'),
('video','是不是已经继续生成了？不用再试。',0,'status'),
('image','刚才的任务还要做，接着来吧。',1,'resume'),
('image','刚才的任务不做了，今天就到这里。',0,'stop'),
(None,'按刚才那份安排接着做完。',0,'no_task'),
(None,'把图片中人物的衣服改成灰色。',0,'no_task'),
(None,'重试之前失败的导出。',0,'no_task'),
(None,'下一步照计划执行。',0,'no_task'),
(None,'继续给我生成剩下两张。',0,'no_task'),
(None,'把那个目录接着整理完。',0,'no_task'),
(None,'我想看看以前的执行进度。',0,'no_task'),
(None,'先陪我聊天。',0,'no_task'),
]

calibration = [row('calibration', i+1, *spec) for i, spec in enumerate(calibration_specs)]
test = [row('test', i+1, *spec) for i, spec in enumerate(test_specs)]
splits = {'train':train, 'calibration':calibration, 'test':test}
seen = {}
for name, rows in splits.items():
    for item in rows:
        key = (item['text'], item['scenario'])
        assert key not in seen, (name, seen.get(key), key)
        seen[key] = name
    destination = ROOT/f'{name}.json'
    assert not destination.exists(), f'Refusing to overwrite frozen data: {destination}'
    destination.write_text(json.dumps(rows,ensure_ascii=False,indent=2),encoding='utf-8')
protocol = {
    'version':2,
    'input':'Only current message and existing task goal (or null); IDs, labels, families and scenarios never enter model input.',
    'datasetRevision':'v1 was never trained; removed index-derived task status before training to avoid an incidental label correlation.',
    'decision':'Does the CURRENT message explicitly request continuing/modifying the given existing task?',
    'labels':{'0':'not an explicit existing-task continuation','1':'explicit existing-task continuation'},
    'source':'manually authored synthetic Chinese cases; no real user transcripts',
    'split':'authored separately; calibration and test use task domains absent from training; not independent human annotation',
    'training':'freeze encoder and transformer head, train Laya option scorer only; both option orders',
    'seed':924,'epochs':120,'batchSize':32,'learningRate':0.0002,'weightDecay':0.01,
    'selectCheckpoint':'lowest calibration cross-entropy; test file not read until selection is sealed',
    'thresholdPolicy':'calibration only: require both option orders to agree; minimum winning probability in both orders >= threshold; choose highest coverage with zero false positives, minimum threshold 0.75; abstain otherwise',
    'temperaturePolicy':'minimize calibration cross-entropy over 1.0..5.0 in steps of 0.1; never sharpen logits',
    'acceptance':{'rawAccuracy':0.95,'orderAgreement':0.95,'falsePositiveContinuations':0,'selectiveCoverage':0.6},
    'deployment':'experiment only; no automatic promotion; permission and execution stay outside model',
    'files':{name:{'n':len(rows),'positives':sum(r['label'] for r in rows),'sha256':hashlib.sha256((ROOT/f'{name}.json').read_bytes()).hexdigest()} for name,rows in splits.items()},
}
(ROOT/'protocol.json').write_text(json.dumps(protocol,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps(protocol['files'],ensure_ascii=False))
