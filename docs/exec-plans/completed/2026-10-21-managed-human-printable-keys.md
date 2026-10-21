# 人工接管的普通字符原生按键

## 目标与现状

为 P06/P15 补齐普通字符的网页原生键盘语义：空格操作控件、裸字符快捷键、
网页取消 keydown，以及普通输入只提交一次。完整 Browser Use 对齐仍沿用
[总计划](../active/2026-10-10-browser-use-parity.md)，本专项不替代其余要求。

上一轮已交付 `preview-20261021-cf3655a`；本轮从 `ed36909` 继续开发。
旧查看器忽略非快捷键的普通字符 down/up，之后通过 `Input.insertText`
提交文字；原网页因此收不到相应的 keydown/keyup。真实旧版基线已复现，
新实现及四场兼容回归已通过正式浏览器验收。用户随后明确要求本轮新包，
固定提交后执行构建与制品核验，发布结果单独记录；不创建 PR。

## 契约与约束

- 原 human lease 可声明 `printableKeyVersion: 1`，同租约能力不可变化，
  只读 view 不得声明。缺省保留旧输入路径；Go 对带文本的 key 验证能力。
- key/down 可携带 `text`，仅无修饰或 Shift，不能同时请求 clipboardTransfer。
  固定 Chromium 的 text 容量是 1–3 UTF-16 units，必须为完整 Unicode，
  禁止控制字符。原 DOM key 只支持单个可打印 Unicode scalar；多 scalar
  键值保留文字路径，不伪造正规化 key。不从物理 code 猜字符，不截断文本。
- 一个输入仅发送一次 `Input.dispatchKeyEvent(keyDown, text)`，使网页自身
  的 keydown 取消规则和默认动作生效；不再补发 char 或 insertText。
  无 text 的旧 key 与 Enter 规则保留，keyup/清理不携带文本。
- 本地初始 keydown 可能先于 compositionstart，不能立即取消默认行为。
  暂存与当前 lease/generation 绑定的真实字符 down；原非组合 beforeinput
  确认文本后才发送。组合开始撤掉候选并保留已有 IME 路径；原粘贴不双发。
- 重复按键必须已有本代持键，逐项等待原 ACK；keyup/清理沿用原持有身份。
  候选、已排队输入、已发送输入分别处理；End/导航不重放，迟到 ACK 不复活。
- 没有对应 beforeinput 的候选不伪造文本；keyup、下一按键、点击、导航、
  End/失焦均撤销候选。命名键仍走既有原生路径，字符布局不按 US 键表猜测。
- AltGraph 的修饰键及文字通道仍需独立真实验证，不把 Ctrl+Alt 当作已证明的
  AltGraph 支持，也不把固定 Headless 事件作为 Windows 系统输入法证明。
- 只由根代理启动自有隔离 Headless 浏览器。不得操作个人 profile、系统鼠标、
  系统键盘或系统剪贴板；普通公司 Edge 人工授权仍按用户要求延期。

## 验证

- [x] 旧冻结构建 `mso-build-ow4285ux`：root 与真实跨站 OOPIF 完整反例，
  保留各业务失败，仍完成 End/Resume、新 SDK 认领、唯一 POST 和真实 Stop。
- [x] UI、Go 严格协议和扩展定向红→绿：能力版本、真实事件、组合起始、
  布局/Unicode、持键重复、原网页取消、撤权与迟到回复。
- [x] 新冻结完整 Go test/vet 与 Node 检查，生产输入及扩展字节绑定。
- [x] 同一正式未插桩链路验证 root/OOPIF 控件、快捷键、取消、字符输入，
  加入重复/Shift 变化及 End；原可信事件、实际值与唯一业务提交相互核对。
- [x] 中文预编辑/提交与原 Enter、粘贴、重复输入按影响范围回归；不以单元
  测试或 mock transport 替代实际网页验收。
- [x] 独立审查原事件、源码、进程/资源清理和必要画面；补文档、history。
  随本专项提交并推送用户 fork；用户已明确要求新包，交付另记。

## 依据

固定 Chromium 156.0.8078.12 的
[InputHandler](https://raw.githubusercontent.com/chromium/chromium/156.0.8078.12/content/browser/devtools/protocol/input_handler.cc)
与 [WebKeyboardEvent](https://raw.githubusercontent.com/chromium/chromium/156.0.8078.12/third_party/blink/public/common/input/web_keyboard_event.h)
要求文本小于 4 UTF-16 units；[UI Events](https://w3c.github.io/uievents/#events-composition-key-events)
说明启动组合的按键可以先于 compositionstart，首个 keydown 不必已标记组合。

## 进展

协议、查看器和验收脚手架分别负责互不重叠的文件，先保留实际基线再验新实现。
先前打包期间保存的两份 printable 脚手架尚未接入或验证，不计为功能证据。

原基线 `mpk-6v5XU0` 实际退出 1，completed=true、featurePassed=false。
root/OOPIF 的各自原 POST 均保存 checkbox=false、buttonClicks=0、grid 空，
被网页禁止的 x 却把 blocked 改成 seedx；普通 a/A/! 值正确但没有按键事件。
两次 End/Resume、新 SDK claim、每页唯一 POST 与最终 Stop 均完成，原
cleanupErrors/liveRunnerChildren 为空。该基线没有被改成“功能成功”。

首个冻结实现 `mso-build-3sx4fiag` 完整 Go test/vet、3,356 项 Node（含
298 项 UI）通过，绑定 474 份输入与 80 份扩展。独立审查随后指出多字符
键值的回退仅覆盖 base+combining mark，遗漏多 base/ZWJ；此构建保留为
中间证据，修正后另行冻结，不能拿它冒充最终功能验收。

最终 `mso-build-kwztmglh` 完整 Go test/vet、3,357 项 Node（299 项 UI）
通过；474 份生产输入和 80 份扩展冻结。正式 `mpk-i2ycz6` 通过两页原
控件与按键、重复及 Shift 变化、End/Resume、新轮认领、唯一 POST 和 Stop。
146 原输入 ACK，无 text；29 原进程退出。业务独审 2,783 项、来源及清理
110 项通过。原 IME、Enter、重复键和粘贴四场回归实际退出 0，业务独审
合计 1,377 项，五场来源及清理共 995 项，240 张 PNG 完整解码。

多 scalar 持键重复的问题另有红→绿回归；最终 named key 表逐项匹配固定
Chromium 的 306 个名字，当前生产字节与冻结构建相同。根代理确认四张原
截图可读，系统 IME/AltGraph、普通公司 Edge 与完整能力对齐仍未验。
详情及证据索引见[本次 history](../../histories/2026-10/20261021-0851-managed-human-printable-keys.md)。
