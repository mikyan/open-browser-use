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
ready 后的会话生命周期独立于启动期限。Browser 实际退出会触发自有会话
清理；Native host 实际退出则进入 degraded，保留原 Browser 并隐藏任务 endpoint。
仅用户显式 `managed recover` 可在原 Browser 存活、相应 Native/worker 身份
和真实清理已确认后建立新连接，恢复后仍暂停。`managed stop` 始终可用；
不自动恢复、重启浏览器或重放页面操作。

`managed stop` 等待原 Browser.close、进程退出及 Job 清空；强制终止保持
独立记录并返回失败，不能计为正常 EOF。调用者超时后实际清理继续，profile
锁保留到原树退出。生命周期 JSON 中的缺失回执不能当作成功，平台查询失败
保持未确认。管理通道失败也不会自动改连日常浏览器。当前验收状态与用户
入口见[独立会话](references/managed-browser-session.md)。

实验性 `managed run --restore` 显式创建新 run，不改变原 Session 的退出
和错误回执，也不恢复旧句柄或控制权限。重新使用的 profile 必须取得原锁并
通过完整目录检查；历史 run 的临时环境不参与新启动，不因其中存在运行时
缓存链接而删除旧证据或允许实际输入路径跨链接。新 run 的名称、marker、
profile 和运行目录路径检查仍保留，扩展源仍完整验证。原生恢复能读到哪些
页面和持久数据必须实测；未知业务结果不自动重试。显式恢复才使用两个
原生开关；其中 hide 开关会影响 Chromium 派生的 `crashed: false` 启动事件，
不能据此否认原 Browser 实际崩溃。最新正常 Stop 接续通过，但 cache/no-store
均无 DOM 读取证据；已有 profile 崩溃后页面/localStorage 恢复而 cookie 缺失，
首次 profile 流程在新启动前缺 Preferences 且任务页未恢复，两者仍为失败。
剪贴板重连改为严格配置派生入口后，七项限定复制/剪切回归通过，原失败不
改写。当前构建、原始证据与此前有限结果分开记录，见
[浏览器进程重启接续](references/managed-browser-restart.md)；完整崩溃接续仍未完成。

实验性 viewer 共用原页面 rendering 流，保留实际 start/ACK/stop 回执；
用户网络接收速度不控制 native frame ACK。观看端仅保留有界最新帧，控制
回复不能静默丢弃。撤权序号穿过 Go/HTTP/UI 的队列和图像解码，防止迟到帧
在 Pause、换页或断流后重新显示。原 worker/context 丢失时控制失效，不
自动重连或 Resume；独立 supervisor Stop 仍可用。HTTP Stop 成功只来自
真实会话关闭，原成功回复实际写出后才关闭查看服务器。客户端等待超时
不代表未执行，也不构成清理完成的依据，不自动重试输入或控制命令。

开发分支的人工接管只接纳原租约、画面代次与连续序号。UI 保留一个在途输入
及最多 32 个待发送输入；HTTP 另有有界串行队列，每项须收到原生回执才能
发下一项。End、Pause、断线和 Stop 先撤销输入，清理请求不等待调用者退出
才提交；原按键释放、rendering ACK/stop 和 detach 全部参与完成判定。
`managed view` 等待上一观看连接的原清理完成后才发新票据；超时不取消或
重放清理。旧清理回复不能抹去后来 Begin 的风险，worker 退出也不能替代
仍存活页面的 held-input 释放。固定 Windows Chromium 的同文档流程和断线
释放已真实验证；真实登录、完整输入法、跨页面及跨平台仍未验收。

开发中的 `managed setup` 与 run 共用原 profile 锁和退出清理。在 setup 中，
用户关闭浏览器后的原进程退出属于正常结束；记录 `browser-exited` 和真实
exit/Job 结果，不给已经退出的浏览器补发或伪造 Browser.close 回执。显式 stop
记录 `requested` 并按原 Close 流程等待确认。自然非零退出、失败的关闭调用
或强制终止仍报告失败。登录状态的复用要经过实际持久数据与原进程退出验证，
不能仅由目录名相同推导；不会恢复旧任务轮次、内存状态或未提交表单。
