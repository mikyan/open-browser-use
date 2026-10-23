# Managed 浏览器进程重启后的接续

本文描述实验性 `managed run --restore`，已随 [preview-20261023-b71be03](https://github.com/mikyan/open-browser-use/releases/tag/preview-20261023-b71be03) 发布，
包含本轮 staging、目录边界及 offscreen 修复；普通公司电脑的安装步骤不变。当前 `mbr-build-hpfufae_` 构建已通过默认再次
启动对照和正常退出后的限定任务接续。已有 profile 的崩溃流程恢复了 GET
工作页、PRG 报告和 localStorage，但 cookie 未保留，仍按原门槛判失败；
首次 profile 的崩溃流程没有恢复任务页。完整崩溃接续尚未成功，工作仍在进行。

## 显式创建新 run

原会话已经结束并完成进程树清理后，在同一电脑和用户下，使用原专用资料的
名称与数据根目录启动。以下命令只适用于包含该功能的配套预览构建：

```powershell
& 'D:\Tools\OpenBrowserUse\open-browser-use.exe' managed run `
  --name work --root 'D:\BrowserData\OpenBrowserUse-Managed' --restore
```

此选项请求 Chromium 的 `--restore-last-session`，并仅在该次明确恢复时使用
`--hide-crash-restore-bubble`，使无界面启动不依赖点击崩溃恢复提示。它不修改
旧退出记录，不自动重复启动，也不附加默认启动的 `about:blank`。
省略选项的 run 及 setup 均不加这两个开关；同名 profile 的
运行锁仍然互斥。状态中的 `info.restoreRequested: true` 表示启动意图，
不能作为页面恢复、任务完成或恢复权限的证据。

新的 Browser、Native 连接、worker 和 run 形成新的任务身份。旧 SDK、页面
与定位器句柄、控制轮次、查看票据和交付权限均不能沿用，持久数字 tabId 或
分组名也不授予权限。重新读取状态并连接新的客户端，明确开启新轮次，对
实际存在的页面显式 claim；若当前仍暂停，须明确 Resume。不能把旧调用
重新发给新连接来消除原来的未知结果。

这与 [`managed recover`](managed-worker-recovery.md) 不同：Recover 在原
Browser 仍存活时替换 Native/worker，保留原页面。Browser 实际退出仍结束
原 Session；`run --restore` 不把原异常退出、未确认的 Browser.close 或强制
终止改成正常关闭，也不会恢复旧 DOM 身份。

## 页面和数据边界

原生会话恢复受浏览器、网站缓存与登录策略影响，不保证所有标签页、表单或
内存数据恢复。同一专用 profile 中的 cookie/localStorage 是否仍可用，必须
分别读取确认；持久存储接口的写入成功不等于异常退出后必然保留。真实登录
有效性还取决于网站，不能用资料复用推导任意 SSO/MFA 可用。
JavaScript 内存、旧页面对象和未持久保存的草稿不构成跨进程交接契约。

首次建立的 profile 还可能没有写入偏好文件；原生会话记录与偏好文件分别
持久化，存在会话文件并不保证 Chromium 会将其识别为可恢复的既有 profile。
程序不会伪造偏好文件或把未恢复的页面重新导航成“恢复成功”。最新首次
profile 流程 `mbr-c-JTmfpz` 在 A 实际退出后、B 启动前直接读到 Preferences
不存在；即使 B 带有两个恢复开关，仍只有新标签页。这个缺文件事实属于
该次运行，不回填为此前 `mbr-c-CsgGmL` 失败的已证实原因。

已完成的限定正常退出流程中，GET 工作页与 PRG 报告在新文档中重新读取；
工作页保留原持久 cookie/localStorage，内存草稿为“未暂存”。新客户端
显式 claim 后读取原服务器回执，再执行一笔独立的后续提交。

最新正常流程 `mbr-n-1YhV7o` 的可缓存 POST 与 no-store 页均未读到 DOM：
扩展读取失败，补充 CDP 读取也报告目标已导航或关闭。此前 `mbr-n-GRymnA`
及 `mbr-n-dY3rI5` 曾单次读到可缓存 POST 的原回执，仍只属于各自旧运行。
这些结果不能作为任意 POST 页恢复保证，也不凭 URL、标题或访问失败判断
为 `ERR_CACHE_MISS`。

已有 profile 流程 `mbr-c-1HPqxv` 先通过第 0 代真实空白 run/Stop 建立资料，
再由 A 完成业务；崩溃前只读等待磁盘 Preferences 的 `profile.exit_type`
变为 `Crashed`，实际退出后再次确认。B 的 GET 工作页、PRG 报告及新文档
身份已读到，工作页 localStorage 为原值，内存草稿为“未暂存”，但 cookie
显示“未保存”。验收在 Resume、新 SDK/claim 和后续提交之前失败，没有
降低 cookie 保留门槛，也没有把部分页面恢复称为完整任务接续。

随后只读检查保留的 Cookies 数据库字节，在内存 SQLite 中解析到总行数为 0；
原文件 SHA256 前后不变。该 cookie 明确为持久 cookie，保存至发起崩溃约 8.2 秒，
原 A 请求携带它而 B 恢复请求没有。固定 Chromium 的
[`SQLitePersistentCookieStore`](https://chromium.googlesource.com/chromium/src/+/634b046faf2137b83af71c87baf362b533af9104/net/extras/sqlite/sqlite_persistent_cookie_store.cc#1234)
将写操作排队，首批延迟 30 秒提交，累计 512 次操作可提前提交；
[`正常关闭`](https://chromium.googlesource.com/chromium/src/+/634b046faf2137b83af71c87baf362b533af9104/net/extras/sqlite/sqlite_persistent_store_backend_base.cc#235)
先提交待写操作。此次结果与原生异步持久化窗口吻合；不据此把严格崩溃验收改判通过，
也不通过复制 cookie、修改 profile 或重放业务来掩盖丢失。

实现不重放旧输入或业务请求；原生恢复仍可能重新加载页面，网站也可能产生
自己的副作用。通过的正常接续用完整 HTTP 账本确认三笔原 POST 各一次，
另有一笔独立 follow-up POST；两次最新 crash 均未执行 follow-up。不能把
这些结果推广为所有网站都不重提。
需要可靠保留成果时，仍应使用网站持久记录或已有导出功能。

## 原生恢复开关的源码边界

上述行为分析固定到 CfT `156.0.8078.12` 对应的 Chromium revision
`634b046faf2137b83af71c87baf362b533af9104`，不替代实际运行证据。
[`startup_browser_creator.cc`](https://chromium.googlesource.com/chromium/src/+/634b046faf2137b83af71c87baf362b533af9104/chrome/browser/ui/startup/startup_browser_creator.cc#931)
只在非新 profile 时由 `--restore-last-session` 选择恢复上次会话；
[`ProfileImpl::IsNewProfile`](https://chromium.googlesource.com/chromium/src/+/634b046faf2137b83af71c87baf362b533af9104/chrome/browser/profiles/profile_impl.cc#1657)
仍检查首次运行与新建偏好存储。因此隐藏崩溃提示不能绕过首次 profile 的门槛。

[`HasPendingUncleanExit`](https://chromium.googlesource.com/chromium/src/+/634b046faf2137b83af71c87baf362b533af9104/chrome/browser/ui/startup/startup_browser_creator.cc#1598)
遇到 `--hide-crash-restore-bubble` 会返回 false，使
[`startup_browser_creator_impl.cc`](https://chromium.googlesource.com/chromium/src/+/634b046faf2137b83af71c87baf362b533af9104/chrome/browser/ui/startup/startup_browser_creator_impl.cc#814)
不再因 post-crash 启动分支阻止自动会话恢复。这是用户明确 `--restore` 时
采用的原生启动策略，不是原退出记录修复。
[`SessionService` 的启动事件](https://chromium.googlesource.com/chromium/src/+/634b046faf2137b83af71c87baf362b533af9104/chrome/browser/sessions/session_service.cc#143)
也使用该派生判断，所以新启动日志中的 `crashed: false` 不能推翻原 Browser
的实际非零退出、原 lifecycle 错误或磁盘 `Crashed` 检查点。

## 每轮扩展入口与版本

managed 使用稳定扩展 ID，但每个 run 都有独立的 native host 与暂存目录。
只改变配置文件或 manifest version 不足以刷新此前注册的 service worker
模块图。本轮 staging 同时设置按完整 native 名派生的四段缓存版本，并新增
`managed-worker-<32位小写十六进制runId>.js` 模块入口，其内容仅为：

```js
import "./background.js";
```

入口独占创建，源文件冲突会失败；原 `background.js` 和导入模块不改写。
下载绑定、人工控制与后台文档重连均匹配该精确入口，不接受任意 worker URL。
同 run 的显式 Recover 继续使用原入口，原 Native Port 五字段身份挑战不变。
缓存版本不是权限凭据，也不保证数值逐轮递增。普通安装的源 manifest 与
`background.js` 入口保持原样。

`getInfo.version` 返回实际 manifest 的 `version`，所以 managed 下读到的是
缓存代次，不是产品版本或功能升级顺序。manifest 的 `version_name` 保留源
显示版本；源没有非空显示版本时使用源 `version`。当前 popup 代码仍读取
`version`，没有改为展示 `version_name`。包版本查看 `VERSION.txt`，具体能力
按对应的 metadata 字段协商，不能只比较暂存版本号。

offscreen 剪贴板文档从同包 `managed-config.js` 的严格配置校验结果派生
精确 worker 入口；普通 `null` 配置仍映射 `background.js`，无效配置拒绝
连接。它不调用 offscreen 不提供的 `chrome.runtime.getManifest()`。
此前 `mhc-TEBY19` 在首次 clipboard seed 阶段因该 API 缺失失败，尚未执行
任何复制用例；修复构建的 `mhc-ykKnIG` 七项复制/剪切用例通过，逐项保留
原生回执、原文档身份和 End 确认后的可信粘贴。其双浏览器均受固定版本及
内存剪贴板检查约束，不外推为系统剪贴板或公司 Edge 验收。

## 实际输入目录保护

root 与名称目录检查实际路径及祖先、有界普通 marker 文件的精确内容，并
设置当前用户范围的 ACL；没有匹配归属记录的非空目录仍拒绝接管。marker 不是对抗
同一操作系统用户任意代码的认证凭据。

取得名称锁后，启动器完整检查将被复用的 profile，仍拒绝其中的链接和
非普通文件。扩展源也保持完整检查。创建新的 runs/run 目录前验证其实际
路径，随机 run 目录必须独占创建；setup 与 run 共用这些约束。

新启动不遍历、读取或删除历史 run 的私有 user/temp 等环境。旧运行时生成
的缓存链接不作为新输入，也不会获得特殊路径或 reparse tag 豁免。实际
使用的 root/name、marker、profile、runs 祖先仍拒绝跨链接访问；这不意味着
允许链接进入将被浏览器使用的 profile 或扩展源。

## 验证记录与未验范围

当前记录限定 Windows amd64、CfT `156.0.8078.12` 及本地独立业务 fixture。
每轮保留冻结来源、原 HTTP 账本、SDK 调用、画面和真实清理回执。
当前生产构建 `.tmp/mbr-build-hpfufae_` 绑定 480 份输入，实际 Go test/vet、
123 份 Node 测试文件中的 3381 项检查、Go build/产物信息读取及扩展构建均
exit 0。SDK 复用已逐字节核对的既有产物，并未重新执行 TypeScript 编译。
后加的 crash-established 脚手架按各次运行来源另行冻结，不计入此前构建的
3381 项测试结果。

| 实际流程 | 来源与结果 | 已确认范围 |
| --- | --- | --- |
| `mbr-d-Wik1FD` | 当前 `mbr-build-hpfufae_`、480 输入；7 步通过、实际 exit 0，独审通过 | 默认新 run 不恢复原任务页；两恢复开关均未启用；原 POST 三笔不变、无 follow-up。 |
| `mbr-n-1YhV7o` | 同一当前构建；7 步通过、实际 exit 0，独审通过 | 正常 Stop 后恢复 GET/PRG、新文档身份、cookie/localStorage；明确 Resume、新 SDK/turn/claim 后唯一 follow-up 和两个新交付帧均确认。cache/no-store 均没有读取到 DOM。 |
| `mbr-c-1HPqxv` | 同一当前构建，独立 crash-established 脚手架；实际 exit 1，独审保留失败 | 第 0 代空白 Stop 建立资料，A 的磁盘 Crashed 检查点与真实崩溃成立；B 恢复工作页、PRG 和 localStorage，但 cookie 未保存，恢复 GET 的 HTTP Cookie 头为空。在 Resume、SDK/claim、follow-up 前失败。 |
| `mbr-c-JTmfpz` | 同一当前构建，fresh crash；实际 exit 1，独审保留失败 | A 退出后、B 启动前 Preferences 实际不存在；B 带两个恢复开关仍仅有新标签页，四种原任务页均无候选。 |
| `mbr-d-FnoftD` / `mbr-n-GRymnA` | 此前目录边界修复构建、480 输入；各 7 步通过、实际 exit 0 | 旧默认与正常接续证据；GRymnA 的可缓存 POST 曾读取到原回执，不作为最新运行结果。 |
| `mbr-c-CsgGmL` | 此前目录修复构建、480 输入，尚未加入 hide 开关；实际 exit 1 | 原 crash 清理和第二代新身份连接通过，但 B 只有 `chrome://newtab/`。这只是该次旧运行的页面结果，没有当时 Preferences 缺失的直接记录。 |
| `mbr-n-dY3rI5` | 此前唯一入口构建 `mbr-build-v1gdybj9`、479 输入；7 步通过、实际 exit 0，独审通过 | 目录修复前正常退出接续的原始证据，保留其原构建归属。 |
| `mbr-c-6k4Ebb` | 目录修复前的首次 crash；实际 exit 1 | 原 Browser 确实崩溃且 Job 清空；脚手架拒绝尚未分类的原 CDP 写断连错误，未进入新 run 验证。后续精确分类不改写这次失败。 |
| `mbr-c-sWjQxm` | 目录修复前的第二次 crash；实际 exit 1 | 严格崩溃清理通过；新启动因递归检查旧 run 的缓存 junction 被拒绝，尚无第二代 Browser。该失败促成本轮输入目录边界修复。 |

最新默认与正常流程的独审核对各 934 份运行来源快照和 480 份构建输入；
两代 Browser、Native 与 supervisor 均 exit 0，新结果没有继承旧 delivery
权限。最新已有 profile 和 fresh 两个 crash 流程各保留实际 exit 1，原 POST
均三笔、follow-up 均为 0。第 0 代（如有）、A、B 的 Job 均清空，原注册表
两视图、pipe、endpoint 和进程身份均确认清理，无强制终止、cleanup error
或 live runner child。A 的非零崩溃退出没有被改记为正常关闭。

最新 `results.json` 的 SHA256 分别为：

| 运行 | SHA256 |
| --- | --- |
| `mbr-d-Wik1FD` | `43e19377546db22fd539621463a43efa2d73fe7f8bc2038bdec9bdde2309a8b4` |
| `mbr-n-1YhV7o` | `a387fd31ea565db8c15ee5bd0671264141579dee6ea2ea78904c65a4bdba8837` |
| `mbr-c-1HPqxv` | `d49555d1369bd2fed997ae26638ca333d0d880c7702968fdaf91d9d6fb241194` |
| `mbr-c-JTmfpz` | `b96078eaa5c83e4d6f3c7ba9534794354e53a44eece5025ef9e2b5b86cb13715` |

原始记录位于本地 `.tmp/browser-integration/` 的对应目录，不随发布包提供。
独审记录位于 `.tmp/managed-restart-final-audit-20261023/`：

| 独审报告 | SHA256 |
| --- | --- |
| `restore-hide-build-audit.json` | `a604157904cd2e9b26f1e7dc574896317f9ea17ca8fd8f3a57c3cbff5663be0d` |
| `latest-default.json` | `1f45ea04a6abd0b65d1740b9b399284bc75fcb0453ef6c8b3b6346bd78951865` |
| `latest-normal.json` | `9366419f0a69b115becb0082c0af899b187a2c94a1b7845cd775dcb50e75f72e` |
| `latest-crash-established.json` | `1c147301c9e13e59bab6e9b50b03ab6e0a847fbc15ab1018e5f2dd2c3c5613df` |
| `latest-crash-fresh.json` | `302f72da7cf3ca4d1a4c46e8873a07ed4c033039d7c032f900964c42638d22a6` |

此前 `cases-default-normal.json`、`case-crash.json` 与各旧运行原始记录继续
保留；后续修复和新运行不改写原失败。剪贴板的旧失败与修复后成功分别记录
在同目录 `human-copy-audit.json`，没有将旧失败升级为通过。

OS 观察覆盖各流程的两代或三代，记录前台事件与离散光标样本；不能据此
宣称系统光标在所有时刻都不移动，标签与窗口观察也仅覆盖各 run ready 后
至停止前的区间。
最新构建的完整崩溃接续尚未成功，更广网站和平台仍待验证。普通公司
Edge 尚需用户手动授权完成验收；完整输入法与整体 Codex 能力对齐仍开放。
