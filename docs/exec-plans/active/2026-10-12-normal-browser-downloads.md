# 普通启动浏览器的原文件下载验收

## 目标与当前状态

完整目标仍是 Browser Use P01–P15 能力和实际任务表现与 Codex 不相上下。
本计划验证其中尚缺的普通启动 Edge → 用户授权 → 真实 Native Messaging →
页面原始导出 → 读取文件，以及授权完成后的后台体验，不替代完整矩阵。

上一开发切片 `9c8bef9` 完成原文件准备确认并产生可复核证据，属于 progress。
随后的公司电脑安装答复是用户要求的使用指导，没有推进或完成开发验收。
本轮从干净 `9c8bef9` 工作树继续；不修改已发布 preview，也不创建 PR。

## 约束与设计

- 只在新建私有 profile 中测试，随机用户级 Native Messaging 注册；不读取、
  修改日常 profile，不移动系统鼠标。只有主代理启动浏览器。
- 可使用带调试参数的独立 bootstrap 安装测试扩展；必须记录实际进程退出、
  host 结束，再以普通参数重启。bootstrap 不算普通启动的成功证据。
- 普通启动参数和 CIM 进程实况均不得有 remote-debugging-port、automation、
  unsafe-extension-debugging。不修改 Preferences 来开启权限或安装扩展。
- 普通阶段用精确 user-data 根目录和生产 CLI；不调用不受支持的 `/json/*`
  预检。端口文件不证明身份，仍须原 Native Port 身份挑战。
- 用户手动完成浏览器 opt-in 和每次 WebSocket 连接许可；额外诊断连接不继承
  已获准连接的权限。授权阶段与业务 focus 观察区间分开。
- 当前 Computer Use 初始化连续两次失败（本地运行目录缺失），且其规则禁止
  操作安全/隐私授权提示。准备好实际测试环境后再请求具体人工步骤；未得到
  授权结果不记通过。等待用户、失败和完成是不同状态。
- 验收复用原 POST/Blob 下载，按原 GUID 和原生完成 path 读取字节；不重发
  下载，不猜路径，不改变用户下载设置。清理只针对本次精确进程/注册项。
- 发现 IPv6-only loopback listener 与固定 IPv4 发现 URL 的兼容缺口；另行核验
  只在首次 TCP 未建立时允许同端口回退，保留原期限与身份挑战，禁止授权拒绝
  后的第二次连接或端口扫描。

## 工作与验收

- [x] 实现普通启动/人工交接 runner，记录源与运行时身份、真实 host、实际退出。
- [x] 实现单条获准诊断 Browser WebSocket 的 flattened sessions 观察 worker、
  独立 focus 扩展与 sentinel；真实人工授权后的此路径仍待验。
- [x] 建立文件内容分析和原有 POST/Blob/OOPIF/foreign/missing-file 业务 hook；
  普通启动下的实际业务仍待验。
- [x] 根代理执行实际 bootstrap 与普通启动，保存具体人工交接；若无法人工
  操作，保留未验边界，不伪造成功或把整个目标视为阻塞。
- [x] 修复并验证确定的 IPv6-only 发现连接缺口：旧源真实 IPv6-only peer 失败，
  修复后 Go 518 pass/27 既有 skip，vet 与 Linux/macOS 测试二进制交叉编译通过。
- [x] 运行受影响的确定性测试与五入口真实 Chromium 回归；保留失败证据，
  同一 live handle 跟踪到终态，不因观察超时重复启动。
- [ ] 普通 Edge 实际业务验收记录授权结果、focus 原始事件和清理结果。
- [x] 同步 reference/history/质量与主计划；本轮提交交付到用户 fork 的
  `codex/browser-use-parity`，不创建 PR。
- [ ] 普通启动需在账户隔离的 OS 环境复测；新建 profile 目录不足以阻止 Edge
  使用 Windows 账户自动登录。检测账户/同步污染须拒绝业务，不改日常策略。
- [x] 增加有界的账户白名单检查与固定错误，污染/缺失/损坏均拒绝；默认同步
  数据类型开关不误判。检查覆盖 bootstrap 后、handoff/bind/业务前后，
  浏览器输出只留长度/哈希。不能阻止启动自动登录或证明检查间无变化。

## 完成标准

实际普通启动 Edge 中，生产绑定通过真实授权和身份验证，原 POST/Blob 文件
经正式 SDK 交付并分析，任务区间无额外 focus/activation，实际清理完成。
仅新增 runner、peer 测试或 bootstrap 成功均不能关闭本计划或完整 parity 目标。

## 已获得的独立回归证据

- 新 host 的五入口 auto-connect `m0BgyU` 2/2、实际 exit 0；六组五入口 ready，
  30 原文件/5200B、15 POST，foreign/missing-file 与 held-transfer 检查保留。
  13415ms 零 activation/focus/许可；独立复读剩余 29 文件/5030B，首个 170B
  文件由原 missing-file 负例删除。源/运行时哈希未变，host EOF exit 0。
- 该回归仍使用调试参数 Chromium 和 Native Port adapter；browser-first
  teardown 警告保留，不证明下载 reset ACK，也不替代普通启动 Edge 授权。
- 原文件相关 Node 149 项中 148 pass，1 项 Windows 文件符号链接权限 skip。
  新的路径守卫另覆盖祖先 junction 越界、非普通文件和读取句柄身份。
- 普通启动首轮 `0Xm0iC` 实际 exit 1，未进入 normal 阶段。bootstrap 原 browser
  和 native host 的 retained-handle helper 均记录 exit 0，但私有进程集合清空
  门禁超时；原脚本未保存该集合且 finally 覆盖首 shutdown 对象，无法从这轮
  确定具体剩余 PID。修复证据记录后再试，不改变选择规则/期限/豁免。
  终态独立检查无本轮 browser/host，原 marker 校验的注册清理 removed=true，
  descriptors=[]；写入独立 post-terminal-cleanup，不将失败改成通过。
- 第一版完整 integration Node 1296 项：1295 pass、1 Windows symlink skip，
  actual exit 0。该结果不证明首轮 bootstrap 清理或普通启动成功。
- 补记录后第二轮 `Do0PFY` 同门禁 actual exit 1，保存了原 Browser.close ACK
  及 browser/host exact-handle exit 0。非空集合仅为浏览器启动的第三方输入法
  daemon，不能因为父进程是 Edge 就认作本测试拥有。角色分类需要明确区分
  浏览器/本轮 native host/精确 native launcher 与外部子进程；保留外部观察，
  不终止输入法，不使用按产品名称硬编码的通过豁免。同浏览器安装目录的未知
  helper 或身份缺失仍须失败。后来独立清理随机注册且 descriptors 为空；
  输入法进程仍活着并未操作，原失败保留。
- 第三轮 `5klS04` 修正归属后，bootstrap 原 browser/host exact-handle exit 0、
  descriptor 空和原 pipe ENOENT，实际普通参数重启通过；独立窗口不含远程
  调试或 automation 启动参数。临时加载的扩展未持久安装，人工 handoff 为
  manual-load。未获得手工操作结果，也未发送 bind。复核发现共享 Downloads
  中误返回外来文件时，旧验收器会在字节核对前保存内容并通过断言 diff 泄露；
  为修复此问题向同一 live handle 发送 stop。实际 STOPPED exit 0、passed=false，
  原窗口退出且随机注册移除、descriptor 空；不是普通下载任务通过。
- 此时完整 integration Node 1306 项：1305 pass/1 既有 Windows file-symlink
  skip，actual exit 0。它在验收日志修复之前运行，后续变更另行验证。
- 修复文件证据顺序后 `aa3Fjb` 五入口 actual exit 0、2/2，30 原文件/5200B、
  15 POST，六组 all-ready；14813ms 零 activation/focus/许可。独立复读剩余
  29 原文件/5030B，首个 missing-file 负例已删除；host EOF exit 0，运行源和
  运行时哈希一致。这仍为 Chromium/Native Port adapter，非普通 Edge 授权。
- `5klS04` 停止后的只读白名单检查发现账户列表非空、sync setup 完成及
  已同意主账户；新建目录实际受到 OS 自动登录/同步影响。原结果不覆盖，
  后续以独立脱敏证据记录。不能声称该 run 账户隔离，也不改变用户 Edge
  策略或用新增启动参数默默替代普通启动合同。
- 新 guard 对终态 `5klS04` 的只读检查明确拒绝；只保存固定字段布尔/计数，
  原结果哈希不变。这不是新 guard 的实机普通启动通过。普通下载文件清理
  同样复用有界读取；打开后增长超过 64 KiB 的文件被拒绝且保留，不无限读取。
- 最终冻结后全部 integration Node 1333 项：1332 pass、0 fail/cancel、1 既有
  Windows 文件 symlink 权限 skip，actual exit 0；7 个相关源码/测试哈希一致。
  runner 68/68，normal proof 36/36；原 Go 10 文件哈希仍匹配 518/27 证据。
  文档、仓库卫生、Action pinning 和 diff 检查通过；已发布三个 ZIP 未变。
