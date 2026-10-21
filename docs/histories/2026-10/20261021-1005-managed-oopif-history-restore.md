## [2026-10-21 10:05] | Task: 恢复跨站 iframe 的原历史文档

### Execution Context

- Agent: `/root` 及协作子代理；Codex 桌面 Windows 工作区。
- Base model: 会话未提供精确型号，不作推断。

### 用户诉求

持续提升 Browser Use 能力，保留 AI 操作反馈且不占用系统鼠标；推送个人 fork，不提 PR。
本轮在已交付预览包之后继续开发，不重复发布。

### 改动与动机

- 新增正式 managed 跨站 iframe 草稿流程，验证原文档经 BFCache 返回后可观察和提交。
- 保存首次快照失败、两次候选超时及原错误。真实命令观测和底层方法复现定位了重复 Frame 登记。
- 原 child session 仅准入、初始化一次，恢复时重绑 Frame 和原有效上下文；已有 root 只提交导航。
- 防止晚到初始化使用旧 Frame、旧 detach 删除新会话；原加载事件驱动就绪，不重载或重放业务。
- 原命令观测保留 Promise/异常身份，并记录实际结算与完整清理。

### 验证

3388 项 Node 检查通过，最终草稿恢复/唯一 POST 及八下载正式流程均实际退出 0。
未变的 Go、嵌入 UI、SDK 和锁文件按原字节复用此前 Go test/vet 与 EXE。
具体原始结果、独立核验和未覆盖范围见[历史恢复专题](../../references/managed-oopif-history-restore.md)。
单一固定 Chromium 的成功不代表普通公司 Edge、所有 frame 组合或整体能力已持平。

### 主要文件

- `apps/chrome-extension/browser-frame-adapter.js` 及测试。
- `scripts/build-chrome-extension.mjs` 及 pinned 方法测试。
- `scripts/browser-integration/managed-oopif-bfcache-*`。
- 架构、质量评分、能力规格及 execution plan。
