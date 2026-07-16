const SHORT_ACTION_CONTINUATION_RE =
  /^(?:继续(?:做|执行|处理|推进|画|绘制)?|接着(?:做|执行|处理|画|绘制)?|下一步|开始(?:吧|执行)?|执行(?:一下|吧|它|这个|那个|绘图)?|运行(?:一下|吧|它|这个|那个)?|重试|再试(?:一次|一下)?|画出来|绘制出来|执行绘图|保存(?:一下|吧)?|导出(?:一下|吧)?|发出去|提交(?:一下|吧)?|做吧|就这样做|你在干嘛|怎么回事|结果呢|好了没)[。！？?!]*$/iu;

const REFERENTIAL_ACTION_RE =
  /(?:按照|根据)(?:里面|其中|上面|前面|刚才|刚刚|之前|这个|那个)|(?:把|将)?(?:这个|那个|它|刚才的|刚刚的|上一个|上一条|前面的|上面的).{0,32}(?:执行|运行|打开|处理|画|绘制|保存|导出|发送|提交|继续)|(?:里面|其中).{0,24}(?:要求|内容|文件|图片|图纸|材料)|^(?:切换|切到|换到|进入|点开|打开)(?:到)?(?:联系人|通讯录|聊天|会话|设置|首页)(?:页面|界面|标签|选项卡)?[。！？?!]*$/iu;

const BACKGROUND_CONTINUATION_RE =
  /^(?:放到|交给)?后台(?:继续|接着|执行|处理|运行|做)(?:这个|那个|它)?(?:任务|绘图)?[。！？?!]*$/iu;

export function matchesCnActionContinuation(text: string): boolean {
  return SHORT_ACTION_CONTINUATION_RE.test(text)
    || REFERENTIAL_ACTION_RE.test(text)
    || BACKGROUND_CONTINUATION_RE.test(text);
}
