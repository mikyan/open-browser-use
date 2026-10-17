# 稳定性与可运维性

这里用来定义项目的运行质量底线。

建议维护的内容包括：

- 启动、健康检查和基本可用性要求。
- 日志、指标、链路的采集和访问约定。
- timeout、retry、backoff 的默认策略。
- 本地和 CI 的关键路径验证方式。
- 常见故障、排查路径和恢复步骤。

CI/CD 流程结构和 release 自动化的默认方案，统一写在 `docs/CICD.md`。

## 实验性 managed 会话

`managed run` 使用同一启动期限验证私有端口、真实 native 进程和扩展身份，
ready 后的会话生命周期独立于启动期限。Browser 或 native host 实际退出
会触发自有会话清理；不重启浏览器或重放页面操作。

`managed stop` 等待原 Browser.close、进程退出及 Job 清空；强制终止保持
独立记录并返回失败，不能计为正常 EOF。调用者超时后实际清理继续，profile
锁保留到原树退出。生命周期 JSON 中的缺失回执不能当作成功，平台查询失败
保持未确认。管理通道失败也不会自动改连日常浏览器。当前验收状态与用户
入口见[独立会话](references/managed-browser-session.md)。

实验性 viewer 共用原页面 rendering 流，保留实际 start/ACK/stop 回执；
用户网络接收速度不控制 native frame ACK。观看端仅保留有界最新帧，控制
回复不能静默丢弃。撤权序号穿过 Go/HTTP/UI 的队列和图像解码，防止迟到帧
在 Pause、换页或断流后重新显示。原 worker/context 丢失时控制失效，不
自动重连或 Resume；独立 supervisor Stop 仍可用。HTTP Stop 成功只来自
真实会话关闭，原成功回复实际写出后才关闭查看服务器。客户端等待超时
不代表未执行，也不构成清理完成的依据，不自动重试输入或控制命令。
