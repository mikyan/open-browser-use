# 已发布包的人工组合输入验收

用户要求持续完成 Browser Use 能力对齐。上轮按要求重新发布 d07ae52 完整包；
本轮验证该包在真实浏览器中已有的组合输入路径，没有改动产品代码或创建 PR。

原直接 Unicode insertText 不能证明候选输入。新增独立 ime 场景，逐阶段记录
原查看器 CDP 命令与实际 ACK、只读 DOM 事件、任务草稿和精确人工输入回执。
两次相同确认分别提交，取消不提交，End 后复核全租约文字账本以覆盖采样间隙。
原文档唯一 POST、持键清理、旧权限拒绝及正式 Stop 保留。

正式入口使用发布的实际 EXE 和扩展，显式记录制品核验与旧测试复用；manifest
仅允许主程序声明的固定公开 key 差异。新脚本 21 项聚焦测试通过，原 Go/Node
检查未重跑。关键文件为 managed-human-check、相邻 fixture、managed-human-ime
及各自测试，均位于 scripts/browser-integration。

普通原生探针先发现 compositionend 的 trusted 标记假设错误；原失败保留，
固定源码确认后才修正验收判据。正式 mhi-66idOk 六步 exit 0，九阶段、两次文字
确认、取消零发送、唯一 356 字节 POST 和正常 Stop 通过。独立原记录核验实际
exit 0，事件230项、生命周期644项通过；29张PNG完整解码，28个原进程身份
均已退出，注册、管道与Job清理正常，没有强制结束进程。
详细边界见[组合输入验收](../../references/managed-human-ime.md)。Windows 真实
输入法、公司 Edge 和完整 Browser Use 能力对齐仍未完成。
