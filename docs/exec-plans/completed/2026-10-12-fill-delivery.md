# 原编辑宿主输入投递确认

## 目标

继续 P01–P15 Browser Use 对齐工作，本切片修复 fill 仅凭 CDP ACK 就报告成功的
缺口。原生输入发出后，必须在原动作期限内确认原编辑宿主收到可信 input；
不能用最终字符串相等替代投递证据，也不能隐式 click 或重发来掩盖失败。
完整对齐目标仍未完成，Vivaldi 的底层输入路由与 P12 新页原生抢焦点仍开放。

## 范围与约束

- 修改固定版本 Playwright CRX 构建补丁、共享输入租约/清理和真实浏览器验收。
- 文本、textarea、contenteditable 的 native needsinput 分支要求 ACK 与事件；
  日期等原 setter 分支保持既有语义。空值且内容已空须有独立无操作契约。
- beforeinput 被取消不算成功；同步格式化或事件后移除节点不能抹去已投递事实。
- 原 tab、attachment、utility context、editing host 与截止时间不可替换；
  晚 ACK 的远端资源清理仍阻断下一输入，不能重复发送已提交的输入。
- 不启动用户日常浏览器，不移动系统鼠标；仅根代理启动独立测试浏览器。
- 不修改已交付 preview 包；不提 PR，完成验证后推送用户 fork。

## 背景与风险

Vivaldi 原现场已观察到唯一 Input.insertText 和完整 ACK，但原输入宿主没有
beforeinput/input、值和 POST 为空。显式 click 后可输入，隐式 click 会改变
fill 语义。记录见 `docs/references/vivaldi-input-diagnostic.md`。

input 事件无法单独认证为某个 CDP 请求，外部并发用户输入仍有归因边界。
contenteditable 的事件目标可能是原 locator 的 editing host；必须明确其范围。
持有修饰键可能改变 Delete 语义，因此本切片采用共享输入 tracker 的独占空闲
租约，不允许未知输入状态静默走兼容分支。

## 里程碑与验证

1. [x] 重查 HEAD、现场证据与原生焦点阻碍；继续独立可推进的 P06。
2. [x] 固定上游旧行为红例，实现 receipt、tracker 接线和失败清理。
3. [x] 单元覆盖取消、变换、原节点移除、空值、setter、跨context和晚 ACK。
4. [x] 真实 Chromium 主文档/已有与动态 OOPIF：正常与变换后原 POST，
   beforeinput 取消和受控 ACK/drop 明确失败且零后续提交；维持原焦点门禁。
5. [x] 检查生产输入回归、证据完整性、文档/history。
6. [x] 提交并推送 fork。

所有测试必须读取同一进程的真实退出结果；观察超时不重启测试。
跨进程 wall-clock 只作诊断，原命令/回复和宿主事件提供因果证据。
受控丢弃只是检测能力验收，不宣称真实 Vivaldi 路由已经修复。

## 进度与决定

- 2026-10-12：上一个安装说明回合没有改变产品代码，属于目标开发无进展；
  本回合恢复已有 fill 方案。HEAD 为 `baa07e9`，现有未跟踪 fill 测试保留。
- 2026-10-12：普通 Edge 人工验收用户暂时不便，继续其他开发，不等待该步骤。
- 2026-10-12：另发现无效键名组合可能先按下 Control 再报错而残留修饰键；
  本切片不混入该改动，保留为下一 P06 任务并补确切回归证据。
- 2026-10-12：构建测试240/240、extension1200/1200通过；integration
  1357 pass/1既有Windows symlink skip。各进程actualexit0。
- 2026-10-12：首轮实机 `6ryKB9` 为8/9、actualexit1，root四场通过。
  OOPIF准备阶段失败源于首次attached事件URL为空；真实文档和不同process已见，
  不能放宽身份断言，改采集同target当前信息再验原session。原有输入回归通过，
  50239ms焦点账本零事件/豁免，五个原测试tab/target清理通过，原失败保留。
- 2026-10-13：保留后三次真实失败 `DU61BT`、`BJZrns`、`ozs5WA`。分别
  修正失败后的原附件预期detach、一次多行命令产生三个input、原生编辑移除
  内部span的fixture假设。保留原文档/宿主及事件时范围，不改生产语义。
- 2026-10-13：最终专项`qyho7y`2/2、17内部场通过actualexit0，11原POST/
  33416B，六失败在原期限后250ms零重放/提交；17原tab/target清理，
  20157ms零activation/focus/豁免。独立字节/原事件/原命令审计通过。
- 2026-10-13：最终integration Node1360 pass/1既有Windows symlink skip，
  0fail/cancel，actualexit0。
- 2026-10-13：最终完整`c4vgmp`129/129 actualexit0，旧128名称/顺序不变；
  当前源码/运行时整场不变，17 fill场再次通过。328568ms只有原12activation/
  4controlfocus许可；原host按既有重启对照终止，继任EOF0。独立审计修正
  专项EOF条件误用于全套的问题，以原restart的精确PID/endpoint关联核验。
  文档/仓库卫生/Action固定检查通过，旧preview三ZIP哈希不变。
- 2026-10-13：实现与证据已以`dea4798`推送用户fork的
  `codex/browser-use-parity`，未创建PR。此fill切片完成；完整P01–P15目标
  仍在进行，普通Edge人工验收与P12未解决，无效组合键缺陷保留下一切片。
