## [2026-10-12 20:40] | Task: 自动发现 IPv6 连接与普通启动下载验收

### Execution context

- Agent: Codex `/root` 与三个协作代理。
- Runtime: Windows、Node 24.14.1、Go 1.26.9。

### User request

持续开发，直到 Browser Use 的实际能力与 Codex 不相上下。保留完整 P01–P15
目标；不创建 PR，不修改已发布公司预览包，不操作系统鼠标或日常 profile。

### Changes

- 自动发现端口连接只在 IPv4 原生 TCP refusal 后允许同端口 IPv6。HTTP
  已连接后的拒绝、重定向、Upgrade 或身份失败均结束原尝试；显式 URL
  保留单地址，私有选项严格校验，原 Native Port 挑战和总期限保持。
- 增加独立普通启动 Edge fixture：bootstrap 与真实正常参数重启分开，随机
  Native Messaging 注册，人工 opt-in/每连接授权，真实进程及原 host 退出证据。
- 增加复用一个获准诊断连接的 18 原文件业务 hook，单独测任务 focus、原
  内容分析及精确文件清理。该 hook 尚不等于实际正常授权已完成。
- 原文件验收核对独立下载根、canonical path、普通文件及打开句柄身份；
  missing-file 负例删除前复核原内容，不递归清理用户 Downloads。
- 内容只在完整字节和 digest 匹配原 fixture 后记录；固定错误文本代替实际
  Buffer 断言 diff，避免误返回其他文件时将其内容写入失败证据。读取有
  64 KiB 硬上限，文件变大也不能无限读取。
- 普通启动流程只读白名单账户/同步元数据并拒绝污染；缺失/损坏也拒绝，
  默认 datatype 开关不误判。浏览器输出改为长度/哈希，不修改登录策略。
  这是采样检测而非启动前防止 OS 登录；文件清理也复用有界读取。

### Verification and limits

- 真实 IPv6-only peer 旧源失败、新源通过。受影响 Go 518 pass/27 既有
  Windows 平台或权限 skip；vet 通过；Linux/macOS 测试二进制可交叉编译，
  不宣称对应平台浏览器运行已验收。
- `m0BgyU` 五入口 auto-connect 2/2 actual exit 0，30 文件/5200B、15 原
  POST、六组 all-ready，13415ms 零 activation/focus/许可。独立复读剩余
  29 文件/5030B，首个 170B 已由原 missing-file 负例删除。Source/runtime
  identity 未变，host exit 0；这是 launch-flag Chromium/Native Port adapter。
- 第一版 integration Node 1295 pass/1 Windows 文件 symlink 权限 skip。
- 普通启动首轮 `0Xm0iC` actual exit 1，normal 未启动。原 browser/host
  retained-handle helper 均 exit 0，但进程集合清空检查超时且未保存名单。
  原失败保留，终态另行核验无本轮进程、随机注册已移除、descriptor 空；
  不能将后来清理结果倒推为原门禁通过。
- 第二轮 `Do0PFY` 同门禁失败但保存了完整原退出与非空进程集合，识别出
  第三方输入法 daemon 被错误归类。它未被终止；后续修正以浏览器/native
  可执行文件角色和精确身份界定归属，保留外部观察，不以软件名称加豁免。
- 第三轮 `5klS04` bootstrap 原 browser/host exact-handle exit 0，普通参数
  重启通过，扩展未持久安装，进入人工 manual-load handoff。没有 bind 或
  业务操作；为修复复核发现的验收日志问题主动 stop，原 handle 实际 exit 0，
  passed=false、进程/注册/descriptor 清理完整，不计普通业务通过。
- 日志修复前全 integration Node 1305 pass/1 既有 Windows symlink skip。
- 日志修复后 `aa3Fjb` 五入口 2/2 actual exit 0、30 文件/5200B、15 POST、
  六组 ready；14813ms 零 activation/focus/许可，独立复读剩余 29 文件/5030B，
  原 missing-file 删除成立，host EOF exit 0，源/运行时哈希无变。
- `5klS04` 终态只读检查发现新 profile 存在 OS 自动登录及同步状态。只记录
  白名单布尔/计数，不保存账户值；普通启动事实不构成账户隔离证明。此机器
  上继续普通启动须先解决测试环境隔离，不修改日常浏览器策略来通过测试。
- 新 guard 对终态 v3 私有 profile 只读拒绝，原结果哈希未变；未再启动 Edge。
  不将此元数据检查等同于新 guard 的真实启动或授权/下载闭环通过。
- 最终全部 integration Node 1332 pass/1 既有 Windows symlink skip，0 fail/
  cancel、actual exit 0；7 个相关文件哈希匹配。runner 68/68、normal proof
  36/36；10 个 Go 源文件哈希仍匹配原 518 pass/27 skip 证据。
- 两次独立复核修复内容证据、账户状态、浏览器输出及未知扩展 inventory 的
  已知日志泄露面；五入口 caller transcript 的脱敏保证仍限定隔离测试目录，
  不将其扩展到共享 Downloads。文档/卫生/Action pinning/diff 检查通过。
- 完整 P01–P15、实际普通授权及后台业务闭环保持开放。三个已发布 preview
  ZIP 的 SHA256 不变。

### Key files

- `cmd/open-browser-use/bind_browser.go`
- `internal/browserdownloads/transport.go`、`loopback_test.go`
- `internal/host/browser_binding.go`
- `scripts/browser-integration/normal-browser-downloads*.mjs`
- `scripts/browser-integration/original-download-proof.mjs`
- `docs/references/normal-browser-downloads.md`
