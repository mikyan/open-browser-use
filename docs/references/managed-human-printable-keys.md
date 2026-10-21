# Managed 人工接管的普通字符按键

人工接管现在保留网页原生按键语义：空格可以操作复选框和按钮，字母或数字
快捷键可被网页接收，网页取消 keydown 时不会再绕过取消而插入文字。普通
字符的长按逐次确认；松开或结束接管时释放原按键，避免重复提交和卡键。

## 协议和查看器行为

原 human lease 可声明 `printableKeyVersion: 1`，同一租约能力固定；只读
view 不能声明。缺省保留旧文字路径，主机和扩展需配套更新。key/down 的
可选 `text` 仅适用于无修饰或 Shift，不能与 clipboardTransfer 混用。

原 DOM key 必须是一个可打印 Unicode scalar；text 为完整的 1–3 UTF-16
units，不允许控制字符。文字来自本地原事件，不按物理 code 推算布局，也不
截断。后端只发一次带 text/unmodifiedText 的原生 keyDown，不补 char 或
insertText。keyup 和结束清理不携带 text，Enter/NumpadEnter 保留原 CR 规则。

初始 keydown 可能先于 compositionstart。查看器先保留当前租约及本地代次
下的候选，不提前阻止默认行为；实际输入区保持焦点，可信非组合 beforeinput
确认文字后才发送。组合开始、下一按键、点击、松键、粘贴、导航、失焦和结束
撤销旧候选。输入法确认与粘贴继续使用独立文字路径，不额外转发一次按键。

重复 keydown 要求当前代次已有原持键，并逐项等待 ACK；当前文字和修饰键可
变化，最终释放使用原确认的 key/code/VK。孤立重复或重复首次按下不会退化为
一次插字。无法忠实映射成原生 DOM key 的多 scalar 布局文字保留完整文字
回退；已有持键时遇到这种变化则结束接管，不再追加文字。

命名键表来自固定 Chromium 的 305 个名字及 Dead 特例，共 306 个；它只用于
区分命名键与多 scalar 文字。容量和键值约束依据固定版本的
[InputHandler](https://raw.githubusercontent.com/chromium/chromium/156.0.8078.12/content/browser/devtools/protocol/input_handler.cc)、
[DOM key 数据](https://raw.githubusercontent.com/chromium/chromium/156.0.8078.12/ui/events/keycodes/dom/dom_key_data.inc)
及 [UI Events 组合顺序](https://w3c.github.io/uievents/#events-composition-key-events)。

## 原始验收

旧冻结构建的 `mpk-6v5XU0` 实际退出 1：主页面与真实跨站 OOPIF 均无法以
空格切换控件，裸数字快捷键无效，禁止输入的 x 仍把 seed 改成 seedx。每页
各自唯一提交记录了这些失败；End/Resume 和 Stop 完成，原失败保持不变。

最终冻结构建 `mso-build-kwztmglh` 完整 Go test/vet、3,357 项 Node 检查
通过（含 299 项 UI），绑定 474 份生产输入和 80 份扩展文件。中间构建审查
发现多 base/ZWJ 回退及原持键后的多字符重复边界，修复后重新冻结验证。

正式 `mpk-i2ycz6` 实际退出 0，两页各自验证空格、快捷键、取消、a/A/!、
普通重复、Shift 变化和持键时 End。原回执为 60 次 pointer、86 次 key，
没有 text 请求；每页唯一 POST 均保留 checkbox=true、buttonClicks=1、
grid=7、blocked=seed、lower=abbb、upper=AAAa、symbol=!hhh。
End 后本地剩余按键不再外发，Resume 后由新 SDK 轮次认领并提交，29 个原
进程身份退出。独立业务审计 2,783 项、来源及清理审计 110 项通过。

同一最终构建的中文预编辑 `mhi-wwmTuS`、Enter `mhk-RbQQUO`、重复键
`mhr-YtXgOv` 和粘贴 `mhp-1Uclcf` 均实际退出 0。粘贴使用固定版本受控
HeadlessClipboard；没有使用系统剪贴板。原始回归与独立审计保留各自边界。

原截图显示两页文字及控件结果，中文预编辑和结束前候选可读；截图不能单独
证明原 ACK、业务提交或清理。报告 SHA 索引见本次 history。

入口：`node scripts/browser-integration/managed-human-printable-check.mjs`。
脚手架需要明确的冻结 host、extension、build manifest 和隔离 Chromium；
不得接管个人 profile 或通过重放已提交输入来重试。

这项验收限于固定 Windows Headless Chromium。AltGraph、系统输入法候选
窗口、远端精确文字光标、系统焦点及普通公司 Edge 仍未证明；完整 Browser
Use 能力对齐继续进行。
