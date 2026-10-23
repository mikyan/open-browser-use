# Worker 恢复后的完整任务接续

状态：2026-10-23 完成该专项；完整 Browser Use 目标继续进行。

## 目标与当前证据

总目标仍是完整 Browser Use 能力对齐。上一轮按用户要求发布并核验了
`preview-20261021-afb415a`；本轮不重复打包，不创建 PR。

既有 worker 恢复真实验收证明：原结果页及活动只读 view 经后台执行替换后，
显式 recover 可签发新权限，保持暂停并允许人工追加内容。原 runner 明确
断言 Resume 次数为零，因此不能单独证明恢复后的完整 Agent 接续。
普通 End/Resume 和结果页重新认领分别已有证据，不将它们称作缺失功能。

本轮验证同一实际链路：原 Agent 提交与交付 → 原 worker 真实结束及新执行/
Native 出现 → 显式恢复 → 原页人工补充 → End → 明确 Resume → 新 SDK/
新轮次认领原页 → 独立一次后续确认 → 再次交付与正式 Stop。
尚未观察到此链路的产品故障，先补实证，不预先修改生产代码。

## 约束与归属

- 根代理独占启动隔离 headless 任务浏览器与查看器；不接触用户 profile、
  系统鼠标、键盘或剪贴板。公司 Edge 人工授权继续按用户要求延期。
- runner 与 fixture 分别由独立代理编辑，第三代理只读审查和事后审计。
- 保留既有 result / held-input 模式；新增显式 continuation 模式。
- 固定生产 EXE、扩展与浏览器字节；真实运行开始后冻结生产和脚手架，
  到原进程权威终态后再决定修复。未知输入或业务结果不得重放。
- 原第一笔提交与后续确认是不同业务，各只允许一次。后续确认必须携带
  原文档、原回执及人工内容；诊断读取不能代替业务读取和提交。

## 验收

1. 固定源、构建及浏览器身份，记录真实原执行结束、新 context/workerBoot/
   Native；目标 ID 可复用，不能以 transport detach 代替执行结束。
2. 原 Browser、tab、target、document/token、window/group/pinned 保持；
   原只读附件清理确认后才能开放新权限。恢复保持暂停。
3. 人工输入/End 和 Resume 均由查看器实际操作产生；原输入和清理回执完整。
   旧 SDK、delivery、human lease 拒绝且不产生业务输入。
4. 新 SDK / 新轮次公开读取人工内容、唯一确认提交，再 finalize 原结果；
   原服务器校验两个不同 POST 的原字节，初始业务没有重放或页面重开。
5. 查看器实际解码最终原页面，正式 Stop 等待 Browser、两代 Native、Job、
   注册表、pipe 和 endpoint 清理；独审原报告及输入来源。
6. 根据原错误决定是否修改生产。成功后同步契约、质量、规格、总计划和
   history，提交并推送用户 fork。此专项通过不等于全平台或总目标完成。

## 进度

- 2026-10-21 建立计划；2026-10-23 完成真实链路，生产与已发布 `afb415a` 相同。
- runner 新增显式 `--continuation`，保留默认 result（Resume 为零）与 held-input
  路径。fixture 仅在 opt-in 时添加第二阶段确认，原提交和后续确认分别只能一次。
- 48 项定向 Node 检查通过（零跳过），覆盖原 fixture/support 与新 continuation
  fixture/support；选择器修正后 runner 语法检查通过。
- 首轮 `mwr-c-BreJxA` 在恢复、人工编辑和 End 后，因为测试使用不存在的
  `#resume` 等待超时。未发送 Resume 或后续 POST；原 finally 正式 Stop 完成，
  supervisor/viewer 退出 0。末尾资源核验阶段未运行，不能改写为完整通过。
- 修正脚手架为实际 `#control`，并确认按钮文本“继续操作”。新场景
  `mwr-c-P5udBb` 六阶段通过，原 runner 实际退出 0；未在失败页面重放操作。
  唯一 GET、原 POST 和不同业务的 follow-up POST 均为 200，恢复后只 Resume 一次。
- 原 SDK 跨真实 EOF 保持存活，恢复后及新 SDK 认领后均明确断连；新 SDK 公开读取
  人工备注、review 和最终回执，后续确认绑定原文档、原回执及人工内容，然后 finalize。
- 最终只读 frame 实际解码，原截图可见人工备注、review=1 与后续回执。正式 Stop
  核验原 Browser、两代 Native、Job、32/64 位注册表、pipe、endpoint 及查看器清理。
- 独立审计原失败 61 项、最终流程 74 项，均无证据问题；前者 featurePassed=false
  保留，后者 featurePassed=true。成功场核对 9 个原人工输入 ACK、一次 Resume、
  公开最终回执和最终交付。失败场的停止后资源补查单独记录，不冒充原终步核验。

## 输入与原始证据

固定构建 `mob-build-6u_o0xn0` 的 build 报告 SHA256：
`44b09f337a16fa8c7b3325b25cd3dbf185936c992d16270f31c50a69c3d14c45`。
预检核对 474 份生产输入、351 份 Go/UI/SDK/锁文件、80 份扩展、26 份 SDK dist，
并冻结 386 份浏览器验收 mjs。任务浏览器和查看器均使用固定 CfT 156.0.8078.12。
Go test/vet 与 EXE 依据字节一致性复用先前证据，本轮未重建或重跑 Go。
runner 自身标注 caller-supplied binary、未验证构建来源；完整来源由外部预检及
独立审计建立，不能称 runner 自己捕获了全部 474 份生产输入。

| 原证据 | SHA256 |
| --- | --- |
| 首轮预检 `mwc-input-5z4i9mvp` | `ee13326ee836745309d02053ba91f458da2762974a895bb247101c3a4f2ae313` |
| 原失败 `mwr-c-BreJxA` | `f5048a0691622f485ce51e08bb931d5a2a251637ca4340ab427718cd335e0097` |
| 最终预检 `mwc-input-h_r1cup9` | `afc809d8499a8c2309d71065a32e55d4b4c43325fb9769379fcdf8d3a021e6c3` |
| 最终运行 `mwr-c-P5udBb` | `c7926baa9f63327bae3b89d4a977cef7dafd5e33ffc34be5d2f707c27cad32a5` |
| 最终原生 PNG | `c92b71c0f3e9946d661a6c3f156fb85aca84f7c39e77241e33c2a393f52fe672` |
| 最终查看器截图 | `1659f0ae57d4d25313aacffbd575ce393a562174e74891f6085db3d1127676b3` |
| 原失败独审（61 项） | `9e843aa78c2f88f99f33a85e62f253fe957936331c584a6fc0098870c0e8458f` |
| 最终流程独审（74 项） | `c5f80855bae36fb02cc6a6b17e840db8c8e16ce3ff40633b56333ef7fe5a1ed2` |

## 证据边界

- 故障发生于只读 view，没有故障前人工租约；不证明输入执行中 worker 替换可恢复。
- End 后旧租约探针使用新 WebSocket，可能由该连接尚未 humanClaimed 的 gate 拒绝。
  仅证明新连接不能复用旧租约；End 本身另有实际清理回执和 debugger detach。
- 公开读取隐藏 state 是辅助证据；人工备注、review、最终回执和确认按钮均走公开 SDK。
  最终 PNG 只证明可见画面，不替代执行身份、业务原字节及原生清理回执。
- 固定 Headless Chromium 不证明普通公司 Edge、浏览器进程重启、任意移位历史、
  真实账号 SSO/MFA、系统输入或全平台能力。总目标继续进行。
- 本轮仅新增验收脚手架与记录，不是新产品修复；不另加功能发布条目或重复打包。
