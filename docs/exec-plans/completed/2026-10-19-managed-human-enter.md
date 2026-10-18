# 人工接管 Enter 原生编辑语义

## 目标与边界

继续完整 Browser Use 能力对齐，修复人工接管中 Enter 只发送 rawKeyDown、
缺失原生字符阶段的问题。多行文本、可编辑网页、网页阻止默认行为和单行表单
都必须由原浏览器决定语义；不能用额外 insertText 或重放输入补出换行。
不操作系统鼠标、个人 profile 或剪贴板，不改变其他按键、接管权限和实际清理。
NumpadEnter 保留原 code；现有协议不传 keypad location，本片不扩大该保证。

## 基线与机制

固定 Chromium 156.0.8078.12 的编辑处理对 rawKeyDown 跳过文字插入类命令，
键盘处理也不会为其生成 keypress。当前生产 mapper 为 Enter 生成 rawKeyDown。
独立原生基线 native-baseline-pVjLbA 直接执行原 mapper 的一次 down/up：两次
实际 ACK，textarea 仍为空，仅有原可信 keydown/keyup，没有 keypress/input。
原断言实际 exit 1 保留；浏览器正常 exit 0，九个原进程身份退出，清理无错误。
这证明原映射缺口，尚不替代正式 managed 入口的修复验收。

## 实施与验证

- [x] 保留原生产映射的实际浏览器失败及原资源清理记录。
- [x] 严格 Enter/NumpadEnter、VK13、无 Control/Alt/Meta（允许 Shift）时，
  单次原生 keyDown 携带 CR；保留原 keyUp、hold、预算、权限和精确 ACK。
- [x] 补错误组合、修饰键、原 ACK 在途撤销/导航/弹窗和未知失败的回归。
- [x] 新建实际 EXE/扩展，核源码对应关系并执行适当 Go/Node 检查。
- [x] 正式查看器完成三 textarea、两 contenteditable、阻止默认行为与单行
  表单七场；保留原文档、真实事件、精确回执及唯一原提交。
- [x] 原接管/End/恢复/提交/Stop 流程和独立事件、制品、进程清理核验。
- [x] 同步文档、提交并仅推送用户 fork；不创建 PR。

## 结果

新构建 Go test/vet、2,898 项 Node 和28项验收脚本检查通过。正式
mhk-9zc3G0 七步 actual exit 0，键盘表单与原 handoff 分别唯一 POST，
原接管释放和 Stop 完成。独立事件410项、生命周期122项通过，58张PNG与
29个原进程身份、Job、注册和管道清理核验通过。最初原生失败与首轮审核
脚本格式假设错误均保留。完整范围见[人工 Enter](../../references/managed-human-keyboard.md)。

完整 P01–P15、公司 Edge、系统输入法、长按重复键和本地复制桥接仍开放。
