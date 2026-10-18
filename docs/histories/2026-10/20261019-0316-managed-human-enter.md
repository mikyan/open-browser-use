# 人工接管 Enter 原生语义

继续用户要求的完整 Browser Use 能力对齐。本轮发现人工接管把 Enter 发送为
rawKeyDown，原 textarea 虽收到按下/抬起和命令 ACK，却没有换行。独立原生
失败基线保留，浏览器和原进程正常退出。

managed-human-control 仅对严格 Enter/NumpadEnter、VK13 和普通/Shift 状态，
把原 down 改为携带 CR 的单次 keyDown。保留原网页取消、原生表单与可编辑区
语义，不追加文字插入。原权限、预算、账本、ACK 及无文本的 keyUp 清理保留。

新增十项控制器回归，包含错误身份、其他修饰键、未知原生失败与 ACK 在途
遇 End/导航/弹窗；相关 214 项通过。新内部构建通过 Go test/vet、2,898 项 Node
测试，437 份输入与 EXE/77 扩展绑定。验收脚本新增独立键盘 fixture 与整页
事件账本，28 项聚焦检查通过，旧 handoff、粘贴和 IME 场景保留。

正式 mhk-9zc3G0 七步 actual exit 0；三 textarea、两 contenteditable、网页
阻止默认行为和单行表单均有原可信事件及准确结果。原键盘表单和独立 handoff
分别只有一次 POST，原接管/持键释放/继续/Stop 完成。独立核验实际 exit 0，
事件410项、生命周期122项通过，58张PNG完整解码，29个原进程身份退出；
原Job、注册与管道清理通过。首轮独审误套旧fixture事件字段和Node reporter
前缀，原失败保留；新v2只修正这两处格式假设，没有重跑业务或改原结果。
范围和证据见[人工 Enter](../../references/managed-human-keyboard.md)。

修复尚未进入 d07ae52 发布包。没有创建 PR；完整能力对齐、重复键、公司 Edge
和系统输入法仍开放。
