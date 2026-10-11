# Original page download delivery

## Goal and current evidence

继续完整Browser Use对齐目标，补P10/P15中“网页生成文件后，Agent取得这次
原文件用于分析”的完整任务。上一片三SDK连接身份已实现并推送`19a39ef`，
Windows真实完整125/125、Windows/Linux SDK及原生IPC通过，属于progress。
旧preview保持不变，不创建PR、不移动系统鼠标或选中用户tab，不增加Pi适配。

现有`expectDownload`能确认Page GUID、原tab/frame/session/epoch并等待完成，
但`downloadPath`对Page GUID明确返回`OBU_DOWNLOAD_PATH_UNAVAILABLE`。可靠
路径仅来自本项目主动`chrome.downloads.download`返回的numeric ID；新GET
不能替代POST报表、一次性响应或立即撤销的Blob。现有浏览器测试已核原始
文件，但其私有下载目录差分只是验收手段，不是公开产品能力。

`chrome.downloads`没有Page GUID或source tab字段；既有实验已经证明普通
extension debugger拒绝Browser下载配置。冻结CRX中的对应分支只返回
resolved Promise，synthetic `/tmp/downloads`也不是原生路径证据。History
只读SQLite已有锁失败，不能再次把猜测、拷贝变化数据库或绕过锁当作方案。

历史Codex扩展1.1.4快照的`handleDownloadCreated`在浏览器控制活跃时向外
发送全局numeric ID、filename、URL；此层没有任务tab绑定。它是历史线索，
不是当前Codex能力或跨任务归属证明，更不是复制全局下载可见性的理由。
当前文件任务尚未做同场Codex验收，先核当前公开工具表面和真实输出。

## Candidate native mechanisms, not implemented claims

正式[Browser CDP协议](https://chromedevtools.github.io/devtools-protocol/tot/Browser/)
的downloadProgress包含GUID和可选filePath；Chromium从同一个DownloadItem
产生二者。真正browser-level连接可在default行为下启用events，或在专用
context使用allowAndName按GUID命名。前者也修改context下载配置，不能
覆盖其他连接的设置；后者改变保存位置/命名/提示，不能默默用于用户profile。
filePath缺失必须失败，不能补猜路径。当前extension transport没有此域。

官方[Chrome当前会话连接说明](https://developer.chrome.com/blog/chrome-devtools-mcp-debug-your-browser-session)
提供M144+显式启用和逐连接授权的候选入口，存在授权UI/自动化横幅，其他
品牌不能外推。另一入口是host创建的独立受控profile，登录状态不同。
这些是待验证连接方式，不把改变运行模式当作既有扩展能力已经补齐。

Fetch原响应捕获可另行提供HTTP正文能力，但没有GUID归属且不完整覆盖Blob，
不能替代本片任务。网页重发GET、按URL/时间/文件名猜匹配都不接受。

## Work and acceptance

- [ ] 核当前Codex同组文件流程：原POST、Blob、返回路径/内容及后续读取，
  记录实际支持与限制，区分IAB和扩展，不以旧源码或描述代替实测。
- [ ] 以独立合成页面验证真正browser-level传输，固定实际browser身份，
  只读记录原Page/Browser事件；任何下载配置变化限于明确受控context。
  若当前profile入口需人机授权，先完成可审查的独立实现再说明真实需求。
- [ ] 正式入口保留ready→trigger→collect，原POST只允许一次；替代GET
  返回不同内容并计错。Blob触发后立即revoke，原GUID必须对应真实原字节。
- [ ] root、动态OOPIF、两个owner同URL/同filename并发及无关下载对照；
  依据原GUID/原生来源绑定，不泄露其他任务或用户文件。
- [ ] 在实际连接/控制范围内取得单一文件句柄，返回可用产物或可靠路径，
  字节数/SHA与原响应或Blob逐字节相同，Agent能继续分析这个原文件。
- [ ] 验证连接丢失、scope撤销、危险/失败下载、文件消失、取消与清理。
  继承上一片连接终态，不为恢复重新点击或重发请求。
- [ ] 验证任务tab后台、系统鼠标不动、连续focus记录；必要授权UI单列，
  不冒称原生连接无打扰。不得放宽旧验收或替换旧发布ZIP。
- [ ] 通过正式CLI/MCP/SDK的同组任务、来源与原字节独立审计后更新文档，
  再提交推送。若某入口未完成，明确保留，不能以窄模式成功代替完整目标。

## Relevant paths

- `apps/chrome-extension/background.js`：owned Page GUID、downloadPath与事件来源。
- `apps/chrome-extension/browser-downloads.js`：明确新下载的numeric ID、路径和取消。
- `internal/host/`、`internal/transport/`：实际浏览器连接的可能扩展边界。
- `scripts/browser-integration/download-waits-fixture.mjs`：已有原始响应、文件与等待验收。
- `docs/references/file-transfers.md`：现有完成语义及已验证限制。
- `docs/product-specs/browser-use-parity.md`：完整P01–P15矩阵。

后台新页ready/跟进、其他平台及guard丢失恢复继续开放；本片不改写整体
成功条件，也不把单独browser-level连接方案当作已解决所有浏览器的安装。
