# 实验性独立浏览器会话

`managed run` 在 Windows 中运行一个独立的 Headless Chromium，使用专用
profile 和真实 Native Messaging。它是可选的实验入口，提供本地实时画面和
用户暂停、继续、停止按钮。本轮预览新增串行的可见登录准备，任务中途的
同文档人工接管仍未实现。普通公司电脑安装仍按完整包里的
`README-先看这里.md` 操作：解压到固定目录、运行对应浏览器的安装脚本，
在扩展页加载 `extension`；不需要为普通安装运行 managed 命令。

本文对应当前开发分支。正式 CLI 已完成下文限定范围的真实浏览器验收；
登录准备和实时画面已包含在 [preview-20261017-2547e6e 完整包](https://github.com/mikyan/open-browser-use/releases/tag/preview-20261017-2547e6e)。
此包按用户要求从最新已提交源码重新构建，运行功能与 b3fd56a 相同；
离线 CLI/MCP、独立制品检查及上传后回下载校验通过，历史网页验证未重跑。
正在开发的同文档人工接管尚未验收，不在该包内。
旧 `preview-20261017-41577de` 只有实时查看，`preview-20261017-f2d3421`
只提供启动、状态和停止命令。npm 上游包和旧预览包不能直接套用下面的新命令。

## 准备

- Windows 10 或更新版本；需要具有创建当前用户 Native Messaging 注册项
  的权限。公司策略可能禁止扩展或调试，应遵守公司的软件安装规定。
- 自行准备 Chromium 或 Chrome for Testing 可执行文件，使用绝对路径。
  启动器不会搜索、下载或安装浏览器，也不会替用户启用普通 Edge/Chrome
  的远程调试授权。当前加载方式不能假定兼容普通 branded 浏览器。
- 使用同一次构建的 `open-browser-use.exe` 与完整扩展目录；扩展目录必须
  含生成的引擎文件、`managed-config.js`、`managed-native-host.js` 和 `managed-user-bridge.js`。
  源码 checkout 可用 `pnpm build:chrome-extension` 生成
  `dist/chrome-extension-unpacked`。Windows 完整包中的目录名为 `extension`。
- 为 managed 数据选择全新的专用目录，或由此入口创建并带匹配归属标记的
  原目录。不要指向已有浏览器 profile、日常文件目录或链接目录。

## 启动、使用和结束

### 可选：先在专用浏览器登录

`managed setup` 是本轮预览新增的入口，旧 `preview-20261017-41577de`
尚不包含它。它只打开专用浏览器资料目录，不开放 Agent 任务连接。使用与
后续 run 相同的名称、数据目录和浏览器程序：

```powershell
& 'D:\Tools\OpenBrowserUse\open-browser-use.exe' managed setup `
  --name work `
  --root 'D:\BrowserData\OpenBrowserUse-Managed' `
  --browser-path 'D:\Tools\Chromium\chrome.exe'
```

在新窗口的地址栏打开网站，自己完成登录。完成后关闭整个独立浏览器，
等待终端退出，再执行下面的 `managed run`。也可在另一个终端用同名
`managed stop` 结束；`managed status` 会明确显示 `state: "setup"`。
setup 期间不加载任务扩展，CLI/MCP 连接会被拒绝。不能同时运行同一名称的
setup 和 run，也不会自动从登录准备切换为 Agent 操作。

这条流程复用同一电脑、用户和专用资料目录中的持久网站数据，不复制日常
浏览器登录资料。未提交表单、sessionStorage 和仅内存令牌不能随重启交接；
网站也可能主动使会话失效。实际网站 SSO、Windows Hello、硬件密钥和 MFA
兼容仍须分别验证；受监督 Chromium 的自动化标识也可能影响网站支持。
请先保存任务结果再结束旧 run。要保留当前文档的中途人工接管尚未提供。

### 运行 Agent 会话

下面是 PowerShell 示例。将程序、浏览器、扩展路径换成实际安装位置；
`--root` 指向 managed 数据目录。它与程序目录分开，便于保留专用 profile。

```powershell
& 'D:\Tools\OpenBrowserUse\open-browser-use.exe' managed run `
  --name work `
  --root 'D:\BrowserData\OpenBrowserUse-Managed' `
  --browser-path 'D:\Tools\Chromium\chrome.exe' `
  --extension-dir 'D:\Tools\OpenBrowserUse\extension' `
  --startup-timeout 30s
```

保持这个终端运行。只有输出 `state: "ready"` 后才可以接入；其中 `info`
包含本次 `runId`、确切任务 `socketPath`、profile 和运行记录目录。
同次输出的 `viewerURL` 是本机查看链接，复制到自己的浏览器打开即可。
链接只可使用一次，有效期十分钟；刷新或重新打开时，运行下面的 `managed view`
领取新链接。不要把带凭据的完整链接发给 Agent、网站或其他人。
`--name` 为 1–48 个小写字母、数字或连字符，以字母开头；Windows 设备名
不可用。省略 `--root` 时使用当前用户的 `%APPDATA%\OpenBrowserUse\managed`。
同一名称/profile 只能有一个存活会话。

在另一个 PowerShell 终端检查并使用同一会话：

```powershell
& 'D:\Tools\OpenBrowserUse\open-browser-use.exe' managed status `
  --name work --root 'D:\BrowserData\OpenBrowserUse-Managed'

& 'D:\Tools\OpenBrowserUse\open-browser-use.exe' managed view `
  --name work --root 'D:\BrowserData\OpenBrowserUse-Managed'

& 'D:\Tools\OpenBrowserUse\open-browser-use.exe' info `
  --managed work --managed-root 'D:\BrowserData\OpenBrowserUse-Managed'

& 'D:\Tools\OpenBrowserUse\open-browser-use.exe' user-tabs `
  --managed work --managed-root 'D:\BrowserData\OpenBrowserUse-Managed'

& 'D:\Tools\OpenBrowserUse\open-browser-use.exe' managed stop `
  --name work --root 'D:\BrowserData\OpenBrowserUse-Managed'
```

查看页中选择已由任务使用的标签页即可开始查看。可用“停止查看”暂停画面订阅，
再用“开始查看”恢复观看；这两个按钮不暂停 Agent 的操作。画面来自独立浏览器，
可显示网页内容、AI 光标和元素反馈；查看页不接管系统鼠标。
点击暂停会撤销当前任务控制并等待清理；继续只解除暂停，Agent 需要开启新轮次并
重新取得页面句柄。旧轮次不会自动恢复，观看也需要重新选择。停止会关闭整个独立
浏览器；按钮成功回执表示原会话已经完成清理。断线或超时保持失败或未知状态，
不能据此认定操作完成。同一时间只支持一个查看连接。

也可以在运行 `managed run` 的原终端按 Ctrl+C 结束。`stop` 关闭整个独立
浏览器及其页面；先保存或导出需要的结果。它不是暂停，不提供恢复旧轮次
或保留可见交付窗口。只有原会话实际完成清理，命令才返回成功；超时或
连接丢失表示结果未知，不能据此认定浏览器已经关闭。

普通 CLI 的 `--managed` 与 `--browser`、`--profile`、`--socket`、
`--socket-dir` 互斥。`--managed-root` 必须同时带 `--managed`。没有存活
会话时明确报错，不会连接日常浏览器；命令不会自动启动或重启 managed。
重新启动后必须取得新的会话和页面句柄，旧 endpoint/控制权不再有效。

MCP 同样连接已经运行的会话。手工配置支持 stdio 的 Agent：

```toml
[mcp_servers.open_browser_use_managed]
command = 'D:\Tools\OpenBrowserUse\open-browser-use.exe'
args = ["mcp", "--managed", "work", "--managed-root", 'D:\BrowserData\OpenBrowserUse-Managed']
```

SDK 继续使用自己的确切 endpoint 参数。例如 JavaScript SDK 的
`connectOpenBrowserUse({ socketPath, sessionId, turnId })` 中，`socketPath`
来自当前存活 `managed status` 的 `info.socketPath`。SDK 尚无 managed 名称
解析入口。任务仍须遵守原有 turn、页面归属、下载和网站权限契约。

## 生命周期与隔离范围

Go `internal/managedbrowser` 负责专用目录归属、profile 锁、随机运行目录、
唯一 HKCU Native Messaging 注册和浏览器进程树。暂存扩展只变更公开 key
与 managed 数据配置，普通扩展的默认配置为 `null`，仍使用原固定 host。
专用 host 直接复制到运行目录，不调用普通安装器，不覆盖其稳定注册。

浏览器在创建时加入自有 Windows Job，句柄不可继承；启动器不按进程名或
旧 PID 文件清场。浏览器使用独立 TEMP/TMP、应用数据目录及用户目录环境。
启动期限覆盖端口发布、CDP 版本和参数、真实 native 进程归属、扩展 ID /
实例 / host 名以及原 Native Port 的 Browser binding 挑战。连接只读取
本次私有 descriptor；没有全局 endpoint 回退，也不禁用 sandbox。

正常停止发送原 `Browser.close`，等待浏览器和 native host 退出以及 Job
成员归零；超时才终止自有 Job，并在记录中保留强制终止和错误。调用者停止
等待不代表清理完成：profile 锁保持到自有树实际退出。启动进程异常终止
时 kill-on-close Job 用于约束自有树，磁盘运行记录及注册项仍可能遗留，
不能把进程保护机制视为完整清理回执。

`info.runDir` 下的 `lifecycle.json` 保留 ready 身份、原 Browser.close 回执、
原进程句柄退出码、实际 Job 清空、注册及 endpoint 清理结果。没有观察到的
结果保持缺失或错误。该文件可包含本机路径、运行身份和浏览器资料，分享
问题报告前应脱敏；它不是权限凭据，也不能授权杀进程。

启动器会绑定该私有 Browser root 的原下载通路，但下载能力仍受既有
[原生下载契约](original-page-download-delivery.md)和
[受限网站下载边界](restricted-page-downloads.md)约束。本轮是否实际验证
文件下载须独立报告，不能由 binding 成功推导。

## 当前未完成

- 真实网站登录兼容、同文档人工接管、可见交付页；实时 viewer 的更广兼容与异常生命周期验收。
- 浏览器自动获取/兼容发现以及 macOS/Linux managed 实现。
- 普通已登录浏览器的原生弹窗抢焦点问题。Headless 内部激活事件也不能
  直接证明操作系统前台焦点保持，需另有相同范围的观察证据。
- 完整能力对齐。原型或 launcher 的单项通过不能代表所有 Browser Use 任务。

## 当前验证

2026-10-17，登录准备原始流程 `managed-setup-QyXNkx` 五步实际 exit 0。
同一专用 profile 先在可见 setup 窗口完成唯一合成登录 POST，保存持久
HttpOnly cookie 与 localStorage；正常关闭后，由正式 SDK 在新 run 访问
受保护页并完成唯一后续 POST。setup/run 双向互斥、CLI/MCP/view 拒绝、
同名资料复用和另名未认证资料均验证。显式 stop 有原 Browser.close 回执，
另一个独立 setup 自然关闭没有伪造该回执；三次原浏览器均 exit 0、Job 归零，
没有强制终止。原窗口可见与退出后消失由只读 Windows 观察确认；测试 actor
经 CDP 操作合成本地页，不代表真人、SSO/MFA 或系统前台焦点验收。
结果 SHA-256：`daadcaeb558f43b3fc9ad0f55a7fc32696ff748060347b524c5fb155a13fad37`。

同源码实时查看回归 `managed-viewer-cOCeeU` 四步实际 exit 0，38 原生帧、
唯一 190 B POST、暂停/新轮次继续/停止与正常清理通过；停止后独审 19 项
通过。结果 SHA-256：`47edc6b450932e144649a8c6302a17c70c9bc2260f542b4158f3739e8f295018`。
Go 全包测试及 vet 通过；扩展源码未改，旧扩展测试保留为历史结果。

两次零业务前置失败保留：`managed-viewer-ocDaKN` 在读取刚发布的端口文件时
遇到 Windows EBUSY，独立查看进程经强制清理，未取得完整原进程身份清单；
修正为在原启动期限观察同一文件。`managed-setup-XjPnhh` 的验收断言误把
所有 extension target 当成本项目扩展；改为按本项目公开 key/ID 核对，并
如实记录其他未分类目标。两次修正都只改验收设施，未重放已提交业务。

2026-10-17，实时查看原始验收 `managed-viewer-5xVYLn` 四步全部通过，runner
实际 exit 0。独立查看页收到 38 个原生 PNG 帧，全部保留；画面显示 AI 光标
和按钮蓝框。通过真实页面按钮完成暂停、继续和停止：暂停后输入被拒、原表单
尚未提交；继续后旧句柄仍被拒，开启新轮次后接续同一子页、保留原字段并只
提交一次。观看流显式重建，停止回执及 browser/native exit 0、Job 归零和
原进程退出均确认，没有强制终止。源码和构建清单在验收期间保持不变。
结果 SHA-256：
`4ced0acb55a4e2d21f4d834baa051f381d65270fb2345f0fc37d1f9dd752f585`。
Go 全包测试及 vet、扩展 1,873 项、builder 25 项、UI/验收辅助 20 项通过。
停止后独立审计实际 exit 0，19 项检查确认唯一 190 B POST、原控制回执、
45 张 PNG 像素解码及当前资源清理。审计 SHA-256：
`81ba4fc00134c5064c324e300d957a9462d9fb0c6c676116709a4a9f9c1eb379`。
这些结果限于固定 Chromium 和此原始流程，不等同于完整能力或安装验收。

2026-10-17，固定 Chromium 156.0.8078.4 的正式 launcher 首次原始尝试
`managed-launcher-xgfAuQ` 完成三步，runner 实际 exit 0：CLI/MCP 均选择
原私有 host，同名启动被拒绝且没有新增 run；正式 JS SDK 以一次可信
Control-click 打开原 child，再完成唯一 192 B POST。截图为 758×369，
目视包含 AI 光标和目标反馈。turnEnded 后旧句柄被拒绝。

原 `Browser.close` 回执为 `{}`，原 browser/native 句柄均记录 exit 0；Job
实际成员为零，无强制终止，注册和 endpoint 清理完成，原进程身份已退出。
结果文件 SHA-256：
`8c398e632daa1db8d4e627a8b36ac80ddb6905ec85d89a1a94f1cac7a22ed790`。
独立停止后审计实际 exit 0，37 项证据检查通过，包括原业务字节、PNG 解码、
15 个去重后的原进程身份均退出，以及当前注册、端点和管理/任务 pipe 已清除。
旧句柄拒绝只有原 runner 的通过断言，未另存原异常内容，不声称复核了精确错误码。
审计 SHA-256：
`8271414aba4e013c7c82fc837e424ad854dd03150279e0a360a0f9897eebddbd`。

Go 包测试和扩展/构建专项检查通过。这一轮没有验证普通安装 Edge、公司
电脑政策、OS 前台焦点、真实下载文件、profile 重启登录或完整任务矩阵。
后续进度保留在
[执行计划](../exec-plans/active/2026-10-16-managed-browser-session.md)。
