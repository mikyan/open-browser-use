# 实验性独立浏览器会话

`managed run` 在 Windows 中运行一个独立的 Headless Chromium，使用专用
profile 和真实 Native Messaging。当前源码的实验功能包含本地实时画面、用户
暂停/继续/停止、串行可见登录准备、连续人工接管和已交付结果页接续；后两项
已完成固定浏览器的限定流程验收。普通公司电脑安装仍按完整包里的
`README-先看这里.md` 操作：解压到固定目录、运行对应浏览器的安装脚本，
在扩展页加载 `extension`；不需要为普通安装运行 managed 命令。

本文记录当前源码的使用方式与已验证边界；包内版本以 `VERSION.txt` 为准。

2026-10-23，[Managed 独立 Agent 多页研究](managed-agent-research.md)的原六阶段及独审通过，
正式 managed 运行 `mra-Ldr4sE` 实际退出 0，67/67 项定向检查通过。两轮各读六份
当前来源并唯一提交报告，保留原 blank 页与前轮报告；四次真实 viewer 解码及正式 Stop
清理完成，29 个原进程退出。此结果只覆盖固定 Windows 的有限采购研究任务；旧 24 次
比较的分母与失败不变，未作同材料 Codex 比速，P15 及整体能力目标继续开放。

以下包段落记录该包打包时状态。
最新完整包为 [preview-20261023-7043c58](https://github.com/mikyan/open-browser-use/releases/tag/preview-20261023-7043c58)，产品功能与 preview-20261021-afb415a 相同。
本次从精确干净提交 `7043c5815a6f7bfd24a3bf3b502362b94045870e` 重建发布 EXE；474份生产输入与原冻结构建绑定，
80份扩展字节一致。离线 CLI/MCP、独立制品核验、四资产回下载与本地副本核对通过。
原完整测试和网页验收按相同生产输入复用，本次未重跑。保留跨站 iframe 历史恢复、
人工接管与 AI 操作反馈；源码另补充 worker 恢复后完整任务接续验证。当时独立研究验收尚未完成，
后续有限任务结果见上文专题。
普通公司电脑安装步骤不变，主程序、扩展与 Skill 配套更新，旧会话正常结束后重启。

此前 [preview-20261021-748af2f](https://github.com/mikyan/open-browser-use/releases/tag/preview-20261021-748af2f)
新增[人工文件选择与上传](managed-human-files.md)，修复重新认领原结果页搬窗
导致的后台点击超时。Go test/vet、3,084 项 Node 和正式四步上传流程通过；
460 份输入与 79 份扩展绑定。发布 EXE 单独重建，离线 CLI/MCP、2,752 项
制品核验、四资产回下载与 114 份本地副本核对通过。普通安装流程保持不变。

此前 [preview-20261021-4249c40](https://github.com/mikyan/open-browser-use/releases/tag/preview-20261021-4249c40)，
修复本地剪贴板写入失败后尚未发送的复制/剪切仍可能留在队列中的问题。
Go test/vet、3009 项 Node 检查及原浏览器流程通过；448 份输入、78 份
扩展与发布构建绑定，发布 EXE 单独重建，离线检查和四资产回下载通过。

此前 [preview-20261021-b63b768](https://github.com/mikyan/open-browser-use/releases/tag/preview-20261021-b63b768)，
新增[人工复制和剪切](managed-human-clipboard.md)。正式双浏览器五种行为及
七步生命周期通过，448份源码输入绑定、78份扩展字节一致。发布EXE单独重建，
离线CLI/MCP、独立制品和四资产回下载通过；主机、扩展及Skill需配套更新。
真实系统剪贴板及公司Edge仍待验收，完整能力对齐仍在进行。

上一轮 [preview-20261019-0f65eb8](https://github.com/mikyan/open-browser-use/releases/tag/preview-20261019-0f65eb8) 与此前534b881的生产功能相同。

此前 [preview-20261019-534b881](https://github.com/mikyan/open-browser-use/releases/tag/preview-20261019-534b881) 包含人工接管真实重复按键，正式七步流程及原清理通过。
440份输入与原Go test/vet、2926项Node已测快照及提交对象相符，77份扩展
与实测字节一致。离线CLI/MCP、9231项独立制品检查、四资产回下载及本地
副本核对通过。发布EXE单独重建，打包未重跑原网页业务。主机和扩展需配套
更新，范围见[重复按键](managed-human-key-repeat.md)。

此前完整包为 [preview-20261019-99c1be1](https://github.com/mikyan/open-browser-use/releases/tag/preview-20261019-99c1be1)，包含人工 Enter 的自然换行、网页取消和
单行表单提交修复，保留本地纯文字粘贴、原生弹窗来源与既有接管能力。
七场固定浏览器行为及原handoff/End/Stop通过，见[人工 Enter](managed-human-keyboard.md)。
437份发布输入与原Go test/vet、2898项Node已测快照及提交对象相同；77份
扩展逐字节一致。离线CLI/MCP、独立制品审计、四资产回下载及本地副本
核对通过；发布EXE从干净99c1be1重建，打包未重跑上述测试或网页业务。
历史d07ae52发布EXE与扩展的六步组合输入验收仍见[组合输入验收](managed-human-ime.md)，
不算作新包重新实测。普通系统剪贴板、真实输入法、公司Edge及完整对齐仍未完成。
弹窗的既有验证范围见[人工网页弹窗](managed-human-dialogs.md)。

历史完整包为 [preview-20261018-e3fee2a](https://github.com/mikyan/open-browser-use/releases/tag/preview-20261018-e3fee2a)，包含跨站prompt及结束接管提示修复。
407份源码及76个扩展文件与实测构建绑定，离线CLI/MCP、独立包审计和四资产回下载通过；发布EXE单独重建。

历史完整包为 [preview-20261018-6a3bee5](https://github.com/mikyan/open-browser-use/releases/tag/preview-20261018-6a3bee5)，
从干净提交 `6a3bee5b1c05c154bce945fa35abce2fbe3422c2` 重建，新增稳定同源及嵌套子页面的人工prompt回答。
完整包/扩展/Skill为102/75/7文件；离线CLI/MCP、独立制品、上传回下载和本地副本校验通过。
发布EXE未重跑网页业务；该包不包含下面续轮的 OOPIF 和 End 提示修复。
历史验收 `mod-BENPnK` 通过主/同源/嵌套/单层跨站 OOPIF prompt 及正常
End/Stop；该续轮已进入上述e3fee2a包。后续3241ff0包另通过固定初始/导航
场景，并新增独立来源显示。复杂 iframe 和完整能力对齐仍开放，见
[人工网页弹窗](managed-human-dialogs.md)。

历史完整包为 [preview-20261018-95e7b29](https://github.com/mikyan/open-browser-use/releases/tag/preview-20261018-95e7b29)，
从干净提交 `95e7b29e3c079506445c52d3db192561adca6ced` 重建，新增主页面人工网页弹窗及五分钟累计等待预算、更新后的Skill。
完整包/扩展/Skill为101/74/7文件；离线CLI/MCP30工具、独立制品、四资产回下载及本地副本校验通过。
本次未重跑网页业务；子frame弹窗WIP未入包，完整能力对齐仍在进行。

历史完整包为 [preview-20261018-853ea92](https://github.com/mikyan/open-browser-use/releases/tag/preview-20261018-853ea92)，
从干净提交 `853ea9211b15ccdebe84dd3fe0df955853b80a0b` 重建，包含下文的 worker 替换恢复。
离线 CLI/MCP 30 工具、独立制品 8,437 项检查、4 个资产回下载及 103 个本地文件校验通过。
完整包/扩展/Skill 分别为 99/72/6 文件。本轮未重跑网页业务；发布 EXE 单独重建，原始功能验收和失败证据保留。
下一轮 workflow/OS 观测脚本及 Skill 草稿未纳入本包；完整能力对齐仍未结束。

历史完整包为 [preview-20261017-6588984](https://github.com/mikyan/open-browser-use/releases/tag/preview-20261017-6588984)，
从干净提交 `65889844f5266f2e2702f5ee9726ab9105ec2c1f` 重建。运行功能与 a4e6b0c 相同，
该次提交差异仅文档；当时正在开发的扩展后台重启恢复未入该旧包。离线 CLI/MCP
30 工具、独立制品 5,507 项检查、4 个资产回下载哈希及本地副本核对通过。
本次打包未重跑网页业务，既有功能验收不计为发布 EXE 的新运行。
上一同功能完整包为 [preview-20261017-a4e6b0c](https://github.com/mikyan/open-browser-use/releases/tag/preview-20261017-a4e6b0c)，
从干净提交 `a4e6b0cb5142d7e34c94c2857e4420ce28804a61` 重建，包含固定 CfT 156.0.8078.12、
旧 155 缓存共存升级和同一存活 worker 的显式 `managed recover`。离线 CLI/MCP 30 工具、独立制品 5,510 项检查、4 个发布资产回下载哈希及本地副本核对通过。
完整包/扩展/Skill 分别为 98/71/6 文件，499 项源码输入逐项匹配。本次打包未重跑网页业务；原 `A6UPE3` 六步
恢复验收与停止后独审是功能源码的既有证据，不计为发布 EXE 的新运行。
上一完整包 [preview-20261017-81cfdae](https://github.com/mikyan/open-browser-use/releases/tag/preview-20261017-81cfdae)
验证了 CfT 155 的安装和普通查看，后续确认其缺少结果查看/人工接管需要的原生
捕获时间字段。旧 155 用户更新程序后须显式再运行 `managed browser install`；
启动不会自动下载或升级。原旧文件和字典保留，默认只选新推荐版本。
此前连续接管、结果页及原下载的 Chromium 156 验收保持为历史证据。
更早完整包为 [preview-20261017-d0605b1](https://github.com/mikyan/open-browser-use/releases/tag/preview-20261017-d0605b1)，
包含连续导航和结果页接续。干净构建、离线 CLI/MCP、独立制品审计和四资产
回下载哈希核对通过；发布 EXE 单独重建，未在该 EXE 上重跑网页业务。
旧包 [preview-20261017-93f54a1](https://github.com/mikyan/open-browser-use/releases/tag/preview-20261017-93f54a1)
仅包含同文档人工接管，没有连续导航和结果页接续；其干净重建、离线 CLI/MCP、
独立制品审计和上传后回下载校验通过。
历史旧包 [preview-20261017-2547e6e](https://github.com/mikyan/open-browser-use/releases/tag/preview-20261017-2547e6e)
的运行功能与 b3fd56a 相同，包含登录准备和实时查看，不包含同文档人工接管。
更早的 `preview-20261017-41577de` 只有实时查看，
`preview-20261017-f2d3421` 只提供启动、状态和停止命令。
npm 上游包和旧预览包不能直接套用下面的新功能；请使用同一次构建的程序和扩展。

## 准备

- Windows 10 或更新版本；需要具有创建当前用户 Native Messaging 注册项
  的权限。公司策略可能禁止扩展或调试，应遵守公司的软件安装规定。
- `managed browser install` 可显式准备固定推荐的 Chrome for Testing；
  新预览包含上述兼容版本修正。安装后 `run/setup` 可以省略
  browser-path，启动只做离线检查，不隐式下载或更新。仍可用 browser-path
  明确指定自备 Chromium/CfT；不会搜索日常 Edge/Chrome 或替用户启用远程调试。
- 使用同一次构建的 `open-browser-use.exe` 与完整扩展目录；扩展目录必须
  含生成的引擎文件、`managed-config.js`、`managed-native-host.js`、
  `managed-user-bridge.js`、`managed-human-control.js` 和 `managed-result-pages.js`。
  源码 checkout 可用 `pnpm build:chrome-extension` 生成
  `dist/chrome-extension-unpacked`。Windows 完整包中的目录名为 `extension`。
- 为 managed 数据选择全新的专用目录，或由此入口创建并带匹配归属标记的
  原目录。不要指向已有浏览器 profile、日常文件目录或链接目录。

## 启动、使用和结束

### 由程序准备专用浏览器

在包含此功能的新构建中运行：

```powershell
& 'D:\Tools\OpenBrowserUse\open-browser-use.exe' managed browser install
& 'D:\Tools\OpenBrowserUse\open-browser-use.exe' managed browser status
```

本次预览的安装入口使用编译时固定的 Chrome for Testing win64 `156.0.8078.12` 及 ZIP
摘要，首次下载后验证完整文件再发布；重复安装复用已核验文件。无需 Go、Node
或管理员权限。固定下载来源见 [Chrome for Testing](https://github.com/GoogleChromeLabs/chrome-for-testing)。
`status` 是离线检查，不会下载浏览器。缓存位于当前用户的
`%LOCALAPPDATA%\OpenBrowserUse\browser`；需要其他位置时，在 install、status、
run 和 setup 中使用同一个绝对路径 `--browser-cache`。

升级后的安装命令可在原缓存内并列安装 156，保留已验证的旧 155 文件和字典；
默认启动只选择当前推荐版本。它不会覆盖损坏的旧安装、移除未知文件，或沿链接
目录操作。旧 155 的结果查看不兼容来自原生协议字段缺失，不能用修改系统时间
或刷新页面解决。固定版本依据见
[Chromium 156 捕获实现](https://chromium.googlesource.com/chromium/src/+/refs/tags/156.0.8078.12/content/browser/devtools/protocol/page_handler.cc)。

完整安装包的 EXE 旁有 `extension` 时，可以直接启动：

```powershell
& 'D:\Tools\OpenBrowserUse\open-browser-use.exe' managed run --name work
```

此时浏览器来自已安装的推荐版本，扩展来自 EXE 相邻目录，与终端当前目录无关。
显式 browser-path/extension-dir 优先；自备浏览器时不读取推荐缓存。缓存缺失
或损坏会报错，不会改用日常浏览器；完整内容检查失败也不会覆盖已有目录。
浏览器自身产生的 Dictionaries 字典文件作为有界运行数据处理，原安装文件仍
逐项校验；不会因首次运行下载字典而误判原安装损坏。字典不属于已核验的官方
归档内容。登录准备和任务运行仍串行使用同名专用 profile，浏览器缓存不存放登录资料。

### 可选：先在专用浏览器登录

`managed setup` 是可选的登录准备入口，旧 `preview-20261017-41577de`
不包含它。它只打开专用浏览器资料目录，不开放 Agent 任务连接。使用与
后续 run 相同的名称、数据目录和浏览器程序：

```powershell
& 'D:\Tools\OpenBrowserUse\open-browser-use.exe' managed setup `
  --name work `
  --root 'D:\BrowserData\OpenBrowserUse-Managed'
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
请先保存任务结果再结束旧 run。需要保留当前页面时，可使用下文的同文档
人工接管；它仍受导航和输入范围限制。

### 运行 Agent 会话

下面是完成 browser install 后的 PowerShell 示例。将程序路径换成实际安装位置；
`--root` 指向 managed 数据目录。它与程序目录分开，便于保留专用 profile。

```powershell
& 'D:\Tools\OpenBrowserUse\open-browser-use.exe' managed run `
  --name work `
  --root 'D:\BrowserData\OpenBrowserUse-Managed' `
  --startup-timeout 30s
```

自备兼容 Chromium/CfT 时，可在 setup/run 增加
`--browser-path 'D:\Tools\Chromium\chrome.exe'`。扩展未放在 EXE 旁时，在 run
增加 `--extension-dir 'D:\Tools\OpenBrowserUse\extension'`。

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

## 人工接管（实验功能）

1. 任务运行时，在查看页选择原任务标签页，点击“接管此页”。系统先暂停
   Agent 并等待其原控制释放，再取得当前页面的人工控制，不关闭或重新加载
   页面。已暂停且丢失任务归属的标签不能仅凭 tabId 开始接管。
2. 等待当前接管的首帧实际解码、界面结束“等待当前画面解码”的提示，再
   点击画面输入文字、按键、指针和滚轮。输入按顺序等待原生确认，不自动重试。
3. 点击“完成接管”，等待原按键、按钮和渲染资源释放。结束后 Agent 保持
   暂停；明确点击“继续操作”后，Agent 仍须开启新轮次并重新取得页面控制。

当前源码支持在接管输入区使用 Ctrl+V（另处理 Meta+V、Shift+Insert）粘贴
本地纯文字。只提交当前粘贴事件提供的文本，不上传 HTML 或文件，也不读取
被控浏览器的剪贴板。一次最多4096个UTF-16单位，超限整体拒绝并结束接管；
不支持的控制字符和孤立surrogate整体拒绝。多行内容遵循目标输入控件的
换行规则。验证范围仅为隔离浏览器内存剪贴板，普通可见浏览器的系统剪贴板、
完整输入法和非Windows平台仍待验收。

新源码还接入 Ctrl+C / Ctrl+X 的纯文本返回，最多 64 KiB UTF-8；要求配套
主程序、扩展及核准的专用浏览器版本。成功、失败和仍在等待的本地写入分别
显示；已经执行的远端剪切不能因本地写入失败而撤回。具体适用范围和本轮
验收状态见[人工复制和剪切](managed-human-clipboard.md)。

网页请求文件时，查看器可显示来源和文件选择卡片。选择本地文件后逐块传给
原网页；取消保留原文件列表，已提交文件可在 End 后由 Agent 继续提交。
传输限制、暂存清理与验收范围见[人工上传](managed-human-files.md)。

通常输入区失焦、查看窗口失焦或页面被隐藏都会结束接管。本地文件选择框的
失焦例外只绑定原可信选择点击与原请求，隐藏页面仍结束。源码新增的网页弹窗
交互会临时停用页面输入框，其本地失焦不会结束接管；可在画面上方确认、
取消或填写 prompt，见[人工网页弹窗](managed-human-dialogs.md)。新源码的
接管为原生弹窗提供最多五分钟等待，同一原输入中的多个弹窗共用该额度；
普通处理仍有30秒期限，旧版会话不自动延长。按住鼠标按钮时移出
当前画面，或此时发生指针取消/捕获丢失，也会停止接纳输入并等待实际释放；
没有按住按钮时，仅把指针移出画面不会结束接管。连接断开同样会释放人工
控制，Agent 保持暂停。不要把失联或超时当作释放成功。

携带旧任务轮次或旧控制代次的请求、固定旧归属的页面句柄、旧人工租约与迟到输入均被
拒绝；普通 Tab 包装对象使用客户端显式开启后的新轮次，不等同于旧控制权限。

当前支持同一标签页内主 frame 重定向、子 frame 导航及 hash/history 等 SPA
跳转。切换文档时暂停输入，验证当前页面并解码新画面后继续；视口几何不再
符合输入条件时释放接管。输入坐标按当前原生画面的完整 CSS 尺寸换算，包含
原页面滚动条；内容区尺寸另行核对，当前代次首帧到达前禁止输入。
当前只接受未缩放、无可视偏移的画面；
完整 IME 输入法、真实网站登录及 SSO/MFA、Windows 原生文件框焦点行为、
新独立窗口接续仍未验收。
观看模式的断线不会自动暂停任务；人工接管时任务已经暂停，释放后不会自动
恢复。重新获取查看链接时，`managed view` 会等待原连接的清理确认；超时
只表示未确认，不能重放网页输入。停止会话仍沿原进程退出流程执行。

### 连续接管的范围

源码新增同一接管租约内的页面跳转、重定向、子 frame 导航和 hash/history
路由切换。跳转时自动暂停人工输入并清除旧地址；新页面已验证且画面实际
解码后可继续操作，无需再次点击接管。用户完成接管后，仍要明确继续 Agent。
当前画面的标题和地址取自该代次的原生页面检查，不复用接管开始时的地址。

新旧代次各自保留输入序号和实际回执。已发送的点击即使触发导航，仍按原
请求返回；未发送的旧队列不重放。失联、未知输入结果、权限或归属变化、
不支持的几何仍会释放整个接管。导航停用输入框产生的本地失焦不会结束租约；
真正切换查看窗口、隐藏页面、完成接管或停止会话仍会结束它。

画面使用 Chromium 原生 `Performance.Timestamp` 和 screencast
`monotonicTimestamp` 的 TimeTicks 捕获屏障；换 streamId 本身不能证明
画面来自新页面。此实现要求这些原生字段可用，缺失时不启用输入。时钟依据见
[Chromium Page 实现](https://raw.githubusercontent.com/chromium/chromium/main/content/browser/devtools/protocol/page_handler.cc)
及 [Performance 实现](https://raw.githubusercontent.com/chromium/chromium/main/third_party/blink/renderer/core/inspector/inspector_performance_agent.cc)。
CDP 输入没有 documentId 条件参数：观察到跳转后可撤销尚未提交的旧输入，
已经提交给浏览器的输入不能撤回；这些检查不构成跨文档原子事务。

## 已交付结果页接续（实验功能）

Agent 通过 `finalizeTabs` 保留的原页面会显示为“已交付结果”。用户可以只读
查看，再明确点击“操作结果页”输入；这两种操作不需要 Agent 重新取得页面。
Agent 已暂停且清理完成时同样可用，完成接管后仍保持暂停。人工跳转后再次
查看时沿用原标签页的当前文档，不重新打开原地址或重放表单。

查看结果不授予输入权限，也不恢复 Agent 的旧轮次。明确接管、切换页面、
继续 Agent 或断开连接时，都要等待原查看资源的真实释放。页面被关闭、移动、
替换或由新的合法任务重新取得控制后，旧结果选择失效。

Agent 显式继续并开启新轮次后，可通过 `claimUserTab` 重新取得原结果页。
对已验证、未固定、未分组且位于普通窗口的原 managed 结果，重新认领保持
原窗口，避免分组搬窗使后台画面停止更新。该页使用独立的用户来源归属，
不改变任务里其他普通标签的分组方式；finalize 遗漏该页只释放，不关闭。
原文档、目标或位置发生变化时不能沿用这次认领证明。具体新增验证记录见
[人工上传](managed-human-files.md)。

新包支持在同一存活 Browser/run 中显式恢复 worker 替换前已验证的原结果，
不会根据展示分组自动恢复权限；旧链接与租约失效，新查看器仍保持暂停。见
[worker 替换恢复](managed-worker-recovery.md)。
`managed stop` 仍会关闭整个浏览器，不提供停止后保留窗口；需先保存或导出结果。

固定 Windows Chromium 的 `managed-result-VGrDlV` 六步实际 exit 0：
正式 finalize 原 A，运行和暂停时只读查看，50 项人工输入经过 302、子 frame
和 SPA，唯一 483 B POST；End 后再次查看和零输入接管仍为原 B、草稿和结果。
两次 Begin/End 不需要恢复 Agent，原进程和 Job 正常退出。观看阶段前后原页面
事件与草稿不变；未在真实只读画面上主动尝试输入。普通 viewer 的 `o6PuJl`
四步回归也通过。旧 93f54a1 包不含本段功能；发布制品的构建与核验记录另列。
结果流程停止后独审通过 868 项，完整解码 37 张原生 PNG 和 7 张查看器截图；
普通 viewer 独审通过 8 项，完整解码 38 张原生 PNG 和 7 张截图。初始审计器
字段名错误和短时 TCP 探测超时均保留，修正审计器/补充有界只读观察后通过，
没有重跑或修改原浏览器流程。

## 生命周期与隔离范围

### Native 断线后的显式恢复（实验功能，已进入 a4e6b0c 预览）

当专用会话的 Native 连接进程退出时，恢复路径保留原浏览器和页面，
`managed status` 显示 `degraded`，不再返回可用任务 endpoint。用户可在终端执行：

```powershell
& 'D:\Tools\OpenBrowserUse\open-browser-use.exe' managed recover `
  --name work --root 'D:\BrowserData\OpenBrowserUse-Managed'
```

成功返回新的 `viewerURL`，原链接和原控制权限不能沿用。原结果页保留原 tab、
target 和 document，Agent 仍暂停；要继续自动操作，需在新查看器明确 Resume，
再让 Agent 开启新轮次。`managed view` 只领取正常连接的查看链接，不隐式恢复。

恢复要求原扩展 worker 和执行上下文仍在、原输入和画面流已真实释放、新 Native
进程属于原 Browser Job，并通过新的连接挑战。无法确认清理、worker 替换、原
浏览器退出或不完整的新连接均不授权恢复；仍可 `managed stop` 结束原会话。
不会重新打开页面 URL、恢复旧租约、重放输入或重提表单。每次运行最多保留 32
个 Native 连接代次；到达上限需停止并新建会话。固定 Windows CfT 156.0.8078.12
的 `A6UPE3` 六步验收通过：一次真实 Native 退出、显式恢复、原结果查看和人工
接续、旧票据拒绝及最终清理均确认。原结果文档和唯一提交回执保留，恢复后未
自动 Resume。该有限结果不包含真正 worker 替换、浏览器重启或在途输入恢复。

以上为 a4e6b0c 起的同 worker 恢复边界；853ea92 新包另包含真正 worker
替换恢复，见[契约与验证入口](managed-worker-recovery.md)。两条路径均要求
原 Browser 存活及确切清理，未知输入与浏览器重启仍不授权恢复。

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
[受限网站下载边界](restricted-page-downloads.md)约束。固定 Windows Chromium
的 `managed-download-LWwtqG` 已通过正式入口的八项原下载验证：7 份原文件
17,524 B、真实在途取消、仅取消等待后继续传输、16 次外部 session 拒绝和
原进程正常退出。没有配置下载目录或重发请求；详见
[独立下载证据](original-page-download-delivery.md#managed-production-entrypoint-acceptance)。
本片同时修复 reader 处理 attach 回复和后续事件之间的 session 发布竞态，
晚到原回复仍只供原资源清理。该 Go 修正尚未进入 d0605b1 已发布包。

### 推荐浏览器安装与默认选择验收（2026-10-17）

固定 CfT win64 155.0.8059.84 的生产 EXE 首次安装、离线状态和重复安装均
实际通过；305 个原文件与独立 ZIP 清单逐项匹配。最终 `managed-viewer-1wBVEd`
从新工作目录省略浏览器/扩展参数，四步实际 exit 0，包含真实 Native Messaging、
40 张实时帧、原生子页唯一提交、暂停/继续/停止和原进程清理。运行后离线状态与
重复安装也通过，独审 10 项及 47 PNG 完整解码通过。首次字典运行数据被误拒绝的
失败已保留并修复。Go 全包/vet/build
与安装边界测试通过；此轮没有重新验证可见 setup 或普通公司 Edge。

## 当前未完成

- 真实网站登录兼容、完整输入法、跨站/OOPIF 输入、按住按键或按钮时跳转的真实浏览器验收、可见交付页；实时 viewer 的更广兼容与异常生命周期验收。
- 更广推荐浏览器版本兼容、更新迁移以及 macOS/Linux managed 实现。
- 普通已登录浏览器的原生弹窗抢焦点问题。Headless 内部激活事件也不能
  直接证明操作系统前台焦点保持，需另有相同范围的观察证据。
- 完整能力对齐。原型或 launcher 的单项通过不能代表所有 Browser Use 任务。

## 当前验证

当前源码的 `managed-human-navigation-fRIjwN` 六步实际 exit 0：一次接管经过
A 的唯一可信点击、302 到 B、子 frame 导航和同文档 SPA，47 项输入按实际
代次分别取得原生回执；原 B 保留草稿，明确 End/Resume 和新 Agent 轮次后
完成唯一 483 B POST。三次导航的标题、地址和画面身份均检查；原进程 exit 0、
Job/注册/endpoint 清理通过，无强制终止。独审完整解码 59 张 PNG。结果 SHA：
`69fe80235ebebb1dc2a843d3a0c23b620b4e607ed8a6e6f86124bd7589e1b6f6`。
首轮标题/地址滞留、审计整数投影修正及零业务 PID 观察器失败均保留在计划，
未以新结果覆盖。真实跨站登录和 held-input 导航仍待验。

同一生产版本的同文档回归 `managed-human-w1KteZ` 六步实际 exit 0，30 项
输入、Shift/左键按住时的原 WS 断线释放、显式新轮次接回、唯一 299 B POST
和正常退出通过。报告 SHA：
`b70b2f128a1cbe0f7e52d422d40eff39fe1170ae5db03bded45919641fabb865`。
该结果覆盖同文档断线，不是按住输入时导航的真实验收。

2026-10-17，同文档人工接管 `managed-human-6U55vc` 六步实际 exit 0。
原表单只加载一次：Agent 草稿保留，viewer 实际传递 30 项有序输入，包括
指针、Shift 按住时的文字、ASCII/Unicode 与双向滚轮。原 WS 断开时仍按住的
Shift/鼠标由原页面实际释放；新查看连接取得确切租约清理回执后，用户显式
继续，Agent 开启新轮次并沿同一 Document 完成唯一 299 B POST。旧人工
租约和原任务控制代次均拒绝。最后通过 UI Stop，原 browser/native/supervisor
与独立 viewer 均 exit 0，Job、注册及 endpoint 清理通过，无强制终止。
结果 SHA-256：`6454f2397a11e4f332dbaaa4a2775573a4fbe9a151d8a8a56264d49725a2a749`。

同源码普通查看回归 `managed-viewer-q5L0so` 四步实际 exit 0：12 个原生帧、
AI 光标及元素反馈、唯一提交、暂停/显式新轮次继续/停止和正常清理通过。
结果 SHA-256：`b22dac7bce5f818b896f9e8fada0c484feb515601f585aef893cd831c67350cf`。
扩展 1,966 项、UI 37 项、Go 全包/vet 及跨层清理回归通过。原先的六次失败
保留在执行计划；独立诊断修正了日志换行、测试窗口尺寸和断开旧状态回执，
没有重放已提交业务。这些结果不证明真实 IME、SSO/MFA、系统前台焦点、
普通公司 Edge 或跨平台。

### 历史验证

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
