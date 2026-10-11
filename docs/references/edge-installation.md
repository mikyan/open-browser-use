# Edge 浏览器选择与安装边界

当前实现为 Edge Stable 增加 profile 发现、`--browser edge` 选择和用户级 native
messaging 注册。它仍使用相同的 MV3 extension、Go host、CLI/MCP 与 SDK 协议。
默认浏览器仍是 Chrome。P03 多浏览器目标仍未完成，不能把这次切片当作所有
Chromium 浏览器和安装渠道均已支持。

## 可以使用的入口

已安装扩展时，用该扩展在 `edge://extensions` 显示的 ID 注册 host：

```powershell
open-browser-use install-manifest --browser edge --extension-id <extension-id>
open-browser-use info --browser edge
open-browser-use profiles --json
```

本地扩展 ZIP 可以由 CLI 解压和配置，然后手动选择目录：

```powershell
open-browser-use setup --zip <extension.zip> --browser edge --no-open
```

该入口打印 `edge://extensions`、Developer mode 和 Load unpacked 操作，使用 ZIP
中固定 key 对应的扩展 ID。命令不自动启动 Edge。普通 `setup --browser edge`
以及未加 `--no-open` 的 Edge ZIP setup 会在写入前明确报错。

`--browser` 接受 `edge` 或 `Microsoft Edge`，忽略大小写。连接已有实例时还可
使用 `edge:Default` 等 profile target；安装入口选择浏览器，不选择某一个
profile。实例识别使用 extension instance ID 和实际 profile 目录，显示名相同的
Chrome/Edge profile 不会仅凭显示名互相匹配。

## 路径与隔离

| 平台 | Edge Stable 默认 user-data 根目录 | 用户级 native host 注册 |
| --- | --- | --- |
| Windows | `%LOCALAPPDATA%\Microsoft\Edge\User Data` | `HKCU\Software\Microsoft\Edge\NativeMessagingHosts\<host-name>` |
| macOS | `~/Library/Application Support/Microsoft Edge` | user-data 下的 `NativeMessagingHosts` |
| Linux | `~/.config/microsoft-edge` | user-data 下的 `NativeMessagingHosts` |

Windows Edge manifest 放在
`%LOCALAPPDATA%\OpenBrowserUse\NativeMessagingHosts\edge\<host-name>.json`。
Chrome 保留原 manifest 位置及 Google Chrome 注册项，避免不同扩展 ID 的
`allowed_origins` 互相覆盖。两者仍共用稳定 host 可执行文件。

`install-manifest --output <file>` 导出指定 manifest 并准备稳定 host 文件，不执行
registry 注册，也不额外写默认 manifest 路径。未知 browser selector 即使带有
`--output` 也会在复制 host、写 manifest、下载或解压 ZIP 前失败。

Edge 的 Windows profile 位置来自 Microsoft 的
[profile 文档](https://learn.microsoft.com/en-us/troubleshoot/microsoft-edge/security/edge-profile-wont-load-locked)。
用户级注册、macOS/Linux 路径及 Edge 查询 Chrome 注册的 fallback 行为来自
[native messaging 文档](https://learn.microsoft.com/en-us/microsoft-edge/extensions/developer-guide/native-messaging)。
这里显式注册 Edge，避免依赖 fallback 及 Chrome 的扩展 origin。

## 验证与限制

Go 单测覆盖三个平台的安装计划、Windows 环境变量 fallback、selector、同名
profile 身份隔离、Chrome/Edge origin 隔离、导出不注册、未知浏览器零写入和
Edge 本地 ZIP setup。执行：

```text
go test ./cmd/open-browser-use
```

2026-10-10 在 Windows 的独立 Edge 153.0.4234.48 profile 完成真实 native
messaging smoke：仅改测试制品的 host 名和扩展 key，使用随机且事前不存在的
HKCU Edge host 注册项，经真实 Go host、named pipe 和 JS SDK 完成 role/name
点击、输入、YAML snapshot 和截图。`info --browser edge` 找到该真实实例，
`profiles --json` 识别到 `edge:Default`。后台任务期间 sentinel 标签页未改变。
测试在 finally 中删除临时 host 注册项；没有修改日常 profile、已有 host 注册、
HKLM 或浏览器策略。测试证明此路径可用，不代表手动安装流程已经自动化。

本切片尚未覆盖 Edge Beta/Dev/Canary、便携安装、自定义 user-data 路径的自动
发现、Edge 自动启动，以及普通 setup 的扩展分发。macOS/Linux 路径已做纯函数
验证，尚未在这两个系统上完成真实 Edge smoke。Microsoft 的
[Windows 外部分发文档](https://learn.microsoft.com/en-us/microsoft-edge/extensions/developer-guide/alternate-distribution-options)
使用 HKLM 分发扩展；本切片没有将 Chrome 的 HKCU 安装逻辑换一个名称直接套用。

Brave、Opera、Vivaldi 的 Windows 默认目录表与共享 Google namespace 入口见
[Chromium 浏览器安装与发现](chromium-browser-installation.md)。该 reference
分别记录 profile、注册与真实 launcher 的验证范围；不因它们使用 Chromium
内核而推断其他平台或安装渠道已经支持。
