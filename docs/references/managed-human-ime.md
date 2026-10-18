# Managed 人工接管组合输入

查看器已有本地组合输入路径：候选文字保留在查看器，只有确认后的文字通过
原人工输入队列交给任务页面。composition 的来源固定到原 lease/generation；
结束接管、换页或撤权会清空本地状态。任务页面收到的是已确认文字的原生
insertText，不是查看器输入法的 composition 事件。

## 当前真实验收

2026-10-19，`mhi-66idOk` 使用已发布的
[preview-20261019-d07ae52](https://github.com/mikyan/open-browser-use/releases/tag/preview-20261019-d07ae52)
实际 EXE 和 77 份扩展文件，通过正式 managed 入口完成六步流程，实际 exit 0。
该包产品代码与 119179c 相同；本轮新增验收设施，没有修改产品行为。

- 三轮组合输入各有两次候选更新，更新期间任务草稿和发送记录保持不变。
- 两轮确认同一份含中文、emoji 和组合字符的文字，各自恰有一次 text 请求、
  独立 ID 和精确原回执；相同文字没有被去重。
- 第三轮取消候选，任务草稿不变，没有发送文字。原租约从开始到 End 的
  全部文字请求还会复核一次，不能靠分段采样漏掉晚到重复发送。
- 原文档保留 Agent 草稿；持 Shift 时 End 产生实际释放，随后旧租约拒绝。
  显式继续后，同一文档只有一次 356 字节 POST，再通过正式 Stop 退出。

结果 SHA256：`3539d9dc4e727c7d1f662d0ef546b3784bf089ecf9b6280d593f066c8a023fbe`。
原 runner 保留九阶段命令/回执、33 个查看器 DOM 事件、原文档和全量发送记录。
独立核验实际 exit 0：事件230项、生命周期644项通过，29张PNG完整解码，
28个原进程身份均已退出。浏览器、Native Host 与查看器正常退出，Job归零，
注册与管道清理通过，没有强制结束进程。

事件审计 SHA256：`d6a091449de0b28c82ff54007acf2e6865b9d677eb365016abaecf0a88dba051`；
生命周期审计 SHA256：`10b24b49fa5f958b0a1c2e77624b8f49d2149c5d82f3f8c2c40b214e2935e45e`。
审计分别读取原记录和制品；正式运行后只有脚本说明文档调整，六份验收代码未变。

本轮实际运行发布 EXE；它与扩展绑定到发布制品、437 份原测试源码及当前
源码。Go test/vet 和 2888 项 Node 检查来自相同源码的上一轮，不称本轮重跑。
新验收脚本单独冻结，并通过 21 项聚焦测试、六文件语法检查及独立源码审查。

## 原生事件与边界

浏览器使用固定 Windows Headless Chromium 156.0.8078.12。输入由独立查看器
的原 CDP Input.imeSetComposition 和 Input.insertText 产生；没有 dispatchEvent、
任务 CDP 输入、系统输入法或剪贴板操作。stage 保存真实 ACK，不将调用超时
或合成回应作为成功。

固定 Chromium 的 compositionstart/update、beforeinput/input 标记为 trusted；
compositionend 的原生读数为 false。该事件通过 scoped queue 派发，没有经过
普通 DispatchEvent 的 SetTrusted 路径，见固定版本的
[InputMethodController](https://github.com/chromium/chromium/blob/156.0.8078.12/third_party/blink/renderer/core/editing/ime/input_method_controller.cc)、
[ScopedEventQueue](https://github.com/chromium/chromium/blob/156.0.8078.12/third_party/blink/renderer/core/dom/events/scoped_event_queue.cc)
和 [EventTarget](https://github.com/chromium/chromium/blob/156.0.8078.12/third_party/blink/renderer/core/dom/events/event_target.cc)。
验收保留这些实际值，并结合原命令、事件顺序及任务回执；不声称整条事件链
全部 trusted。首个普通 textarea 探针 `native-joXlL4` 因错误的全 trusted
断言失败，原记录保留；源码确认后新建 `native-5os7rU` 完成三场独立探针。
探针不是正式 managed 业务结果。

本片不证明 Windows 实际输入法及候选窗口位置、IME 中导航或失焦、带候选
点击 End 的原生提交语义、其他浏览器/平台或完整 P01–P15。对应目标保持开放。

## 可复用入口

设置现有 `OBU_TEST_HOST_BINARY`、`OBU_TEST_EXTENSION_DIR`、
`OBU_TEST_CHROMIUM_BINARY` 与匹配源码/制品的 `OBU_TEST_BUILD_MANIFEST`，再设置
`OBU_TEST_HUMAN_SCENARIO=ime` 运行 `scripts/browser-integration/managed-human-check.mjs`。
发布扩展 manifest 只能比源码增加主程序声明的固定公开 key，其他字段必须相同。
验收原 handoff、local-paste 和旧权限拒绝场景保留。
