# 人工接管输入法预编辑显示

## 用户诉求

继续推进 Open Browser Use 与 Codex Browser Use 能力对齐，保持浏览器内
操作，不占用系统鼠标。无需 PR，本轮不自动重发已交付安装包。

## 已完成变更与验证

原生输入法组合已有提交路径，但查看器将原 textarea 隐藏为透明 1×1
像素区域。扩展原 IME 验收，保存各阶段真实样式、几何、焦点、选择范围及
PNG，区分业务流程通过和预编辑可见功能通过。

原构建 `mso-build-k5ranhzd` 的 `mhi-G1sX8c` 完整六步实际退出 0，
两次确认、一次取消、原文档、End/Resume、新 SDK 认领、唯一 POST 和 Stop
均成功；六次预编辑的原 textarea 都是 1×1、opacity 0，功能仍为 false。
根代理目视原截图确认组合文本不可见，原结果和全部证据保留。

查看器保留同一个原生 textarea，组合时显示并定位在最近有效画面点击附近，
按窗口可见区域夹持，重排时保留原值和选区。新点击、弹窗、导航和 End/Stop
先撤销组合 scope；明确结束按钮的按下保留输入焦点到点击撤权。帮助文字也
同步已支持的 beforeunload。协议仍只发送已确认文字，不向远端转发组合事件。

新冻结构建 `mso-build-x8qt0wec` 完整 Go test/vet、3,268 项 Node 检查通过，
其中查看器 235 项；验收脚手架另有 52 项检查。正式 `mhi-Dz6Bgu` 六步实际
退出 0：中文组合区可见，旧候选在重新点击后清空，新组合正常开始；持 Shift
并带未确认候选时 End，不多发文字且原按键释放。原租约只有两次确认文字，
End/Resume 后 Agent 在原文档完成唯一 POST 并 Stop。

原缺口与新正式结果独审分别 166/222 项通过；新运行 42 张 PNG 完整解码，
28 个原进程退出。根代理与独立审计者目视原图确认文字可读。审计初次解析
失败保留，未改写产品运行结果。构建、运行及审计哈希见专项参考与执行计划。

## 设计边界

本地原生 textarea 应在最近一次画面点击附近显示预编辑，确认后才沿原
协议发送一次文字。该位置不是远端 caret；真实 Windows 输入法候选窗口
及完整系统输入法兼容仍需要实机验证。结束接管、弹窗、导航和字段切换时
必须撤销旧组合 scope，不让未确认的文本进入后继字段或文档。

## 关键文件

- `internal/managedviewer/ui/viewer.js`、`viewer.css`、`index.html`
- `scripts/browser-integration/managed-human-ime.mjs`
- `scripts/browser-integration/managed-human-check.mjs`
- `docs/references/managed-human-ime-presentation.md`
- `docs/exec-plans/completed/2026-10-21-managed-human-ime-presentation.md`
