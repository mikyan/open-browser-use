## 2026-10-23 11:30 | Task: 交付正常重启接续及配套修复

### Execution Context

- Agent：`/root`，协作代理独立审查实现、原生证据及制品。
- Runtime：Windows PowerShell、Go、Node 与 GitHub CLI。

### User Query

> 已经结束了么，再打个新包吧。

### Changes Overview

新增实验性 `managed run --restore`，在同一专用 profile 下明确建立新 run，
请求 Chromium 原生会话恢复。原 Session、退出错误、旧 SDK/turn/locator/viewer
权限均不复用，不自动重放未知操作。每轮暂存扩展使用唯一 worker 入口和缓存版本，
避免新 run 仍连接旧 Native host；下载、人工控制和恢复绑定精确入口。

目录校验聚焦新 run 实际输入，持锁后完整检查复用 profile，保留 marker、祖先
路径和独占创建保护，不因历史运行产生的缓存 junction 拒绝下一次启动。
offscreen 依据严格打包配置确认 worker 来源，避免调用其不可用的 getManifest。

冻结构建 `mbr-build-hpfufae_` 的 480 份输入、完整 Go test/vet、3,381 项 Node
检查及产物构建通过；SDK 原字节复用，未声称重新编译。最新默认新 run 与正常
恢复两场正式七步流程通过，正常接续保留原 GET/PRG 回执及持久数据，明确 Resume、
新 SDK/claim 后独立提交一次并交付结果。最新 cache/no-store 页均无 DOM 证据。
另有七项隔离内存剪贴板复制/剪切回归和 worker 接续回归，具体构建归属保留。

已有 profile 的崩溃用例恢复页面/localStorage，但新 cookie 缺失；首次 profile
崩溃后缺少 Preferences，新 run 无任务页。两者仍失败。只读数据库与固定 Chromium
源码表明前者与异步 cookie 写入窗口吻合，不通过修改旧断言、profile 或重放业务转绿。
完整崩溃接续、普通公司 Edge 和整体能力对齐继续开放，当前计划保持 active。

本轮先交付已验证的正常恢复及连接/复制修复；新包的精确提交、离线检查、制品
校验和下载链接待实际完成后补充。只推用户 fork，不提 PR。

### Files Modified

- `internal/managedbrowser/`、`internal/browserdownloads/`、`internal/host/browser_binding.go`
- `cmd/open-browser-use/managed.go`
- `apps/chrome-extension/managed-native-host.js`、`clipboard-offscreen.js` 及测试
- `scripts/browser-integration/managed-browser-restart-*` 与各 managed 入口匹配脚手架
- `docs/references/managed-browser-restart.md`、架构/稳定性/质量与发布记录

### 实际交付

已发布 [preview-20261023-b71be03](https://github.com/mikyan/open-browser-use/releases/tag/preview-20261023-b71be03)，固定源码 `b71be03af56283a8c7bd70cd60edce9974491eac`。
主程序从独立干净源码重新构建，480 份生产输入绑定冻结构建；80 份扩展和
7 份完整 Skill 核对完成。离线 CLI/MCP、独立制品审计、四资产上传回下载和
本地副本校验均通过；本次打包未重跑原网页流程。发布包没有账号、用户 profile
或本机凭证，保留普通公司 Edge 安装及覆盖更新步骤。

完整 ZIP 为 10,724,097 字节，SHA256：`84ea0ee45da9f38264cd56e582b19434c94f72edc560cafad45eccd228b9be16`。
代码与发布记录仅推用户 fork，未提 PR。正常接续试用交付完成；完整目标未完成。

### 后续验收准备与再次刷新包

用户再次要求新包，因此先收口独立认证恢复验收准备并刷新交付。增加独立
`crash-authenticated` fixture/runner/support：合成持久登录与业务提交分别记账，
原服务器验证当前代次请求携带同一凭据，响应完成后保存最后一次证据。
64/64 项本地 HTTP/helper/recorded-SDK 检查通过，输入前后摘要一致；语法、
import-only 及独立代码审阅通过。未运行真实认证恢复浏览器场景，旧四模式
门槛和两场 crash 失败保留；没有生产功能变更。

本次安装包拟从该提交重新构建，仍与原 480 份已测生产输入绑定。沿用原生
流程证据不等于重新运行；新的包版本、下载与核验结果将在实际完成后记录。

2026-10-23 再次刷新交付：已发布并核验 [preview-20261023-db87f52](https://github.com/mikyan/open-browser-use/releases/tag/preview-20261023-db87f52)，固定源码 `db87f52958d134923c75cbc81fb5ef66f813795e`。
生产功能与前包 `b71be03` 相同；新认证验收仅静态/HTTP 64 项通过，真实 Browser
尚未执行。新 EXE 独立构建、480 输入绑定、80 扩展/7 Skill 一致性、离线 CLI/MCP、
独立制品审计、四资产上传回下载及本地副本核验完成，本次没有启动浏览器。
完整 ZIP：10,724,932 字节；SHA256 `3c94e11e2a05001e08e717bd0a5d5ad4dcc0b11c533ad7b67740422983484d15`。
只推用户 fork，无 PR；两场原 crash 失败与完整目标继续开放。

2026-10-23 认证实测收口：首次 `mbr-c-xjToh2` 实际 exit 1，保留报告首次
unloaded 读取失败和其后真实认证 GET200 的区别。只对原 GET tab/target/URL
增加有界只读就绪观察，69 项定向检查通过；没有生产改动或网页操作重放。
新 `mbr-c-1bDtSK` 七阶段实际 exit 0，全契约独审通过，登录/原业务/后续 POST
为1/3/1，明确 Resume、新 SDK/claim、两项交付和三代真实清理完成。
新写 cookie 仍缺失、raw POST 页仍无可读 DOM，首次和更早失败不变；本次
readiness 首读已 complete，不将它说成等待状态转换的原生验证。沿用原构建，
本轮不再打包。完整目标继续 active；下一片转向 P15 正式入口同材料比较。

### 认证验收后按用户要求再次交付

用户再次询问是否结束并要求新包，已明确整体能力对齐尚未完成。
已发布并核验 [preview-20261023-928f217](https://github.com/mikyan/open-browser-use/releases/tag/preview-20261023-928f217)，制品固定源码 `928f217de27de48941c943e7875bd48d3b8a5c62`。
生产功能与上一`db87f52`包相同，最新提交是认证崩溃接续验收及说明，未提交的
P15四槽比较准备保留在工作区，不进入本包，也未启动正式比较任务。

从独立干净提交重建主机及扩展，480份生产输入、80份扩展和7份完整Skill绑定；
离线CLI/MCP、独立制品审计、四资产上传回下载及115份本地文件核验通过。
此前Go test/vet、3,381项Node与原生验收沿用，不将此次打包称为重跑。
69项定向检查和认证原生成功是打包前已有证据；保留其首次失败、两项旧crash失败
以及新cookie丢失/raw POST无DOM边界，普通公司Edge及完整目标继续开放。

完整ZIP为 10,725,508 字节，SHA256：`41ffe9ce180269c0e039f7fabdc6744f759d02b75b4ab15ec7adeabda30ec856`。
独立制品审计SHA256：`4a5088958eed268b3922c9518ba73303ae01544e8c9442fccbbc9c56b7a68a7b`。安装与覆盖步骤不变，代码和发布记录仅推用户fork，无PR。
