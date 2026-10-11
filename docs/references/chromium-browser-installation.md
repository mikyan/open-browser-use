# Chromium 浏览器安装与发现

本片将浏览器 profile 目录与 Native Messaging 注册位置分别建模。相同
Chromium 内核不代表相同 profile 布局，也不意味着每个品牌都有独立 host
注册空间。Edge 的既有入口和边界见 [Edge 安装](edge-installation.md)。

## 入口与注册行为

已安装扩展时，使用扩展管理页显示的 ID，例如：

```powershell
open-browser-use install-manifest --browser brave --extension-id <extension-id>
open-browser-use profiles --connected --json
open-browser-use info --browser brave --profile Default
```

Windows 同样接受 `opera` 和 `vivaldi`。本地 ZIP 使用
`setup --zip <extension.zip> --browser <brand> --no-open`，再按打印的路径手动
Load unpacked。普通自动分发 setup 和自动打开这些浏览器仍不支持，并会明确
拒绝；不应根据 Chromium 内核推断 Chrome 的安装流程适用。

| Windows 浏览器 | 默认 profile 根目录 | Native Messaging namespace |
| --- | --- | --- |
| Brave | `%LOCALAPPDATA%\BraveSoftware\Brave-Browser\User Data` | `HKCU\Software\Google\Chrome\NativeMessagingHosts` |
| Opera Stable | `%APPDATA%\Opera Software\Opera Stable` | 同上；实际 HKCU launcher 及发现已验证，后台任务未通过 |
| Vivaldi | `%LOCALAPPDATA%\Vivaldi\User Data` | 同上；实际 HKCU launcher 连接已验证，后台任务未通过 |

三者和 Chrome/Chrome Beta 共用原有 manifest 路径。再次注册时先验证现有
manifest 的名称、stdio 类型、稳定 host 路径和 origin 格式，再合并合法
`allowed_origins`，避免安装另一个浏览器后原扩展断连。已存在的合法注册
路径继续使用；冲突、损坏配置或两种 registry 视图指向不同 manifest 时明确
失败。对共享 host 加进程间锁，并在锁内重新检查；manifest 单文件替换是
原子的，host 复制、manifest 与 registry 的整个安装不是一个可回滚事务。

`--output` 保留导出和准备稳定 host 文件的语义，不读取、合并或修改已有
注册。不会根据浏览器品牌自动撤销以前授权的 extension origin。

实例识别读取实际扩展存储。同一 UUID 出现在多个 profile 时保留歧义，不能
按目录顺序归给第一个浏览器。Opera 目录可能直接包含 profile 或包含
`Default` 子目录；根 profile 用 `.` 表示。自定义目录和便携版仍不自动发现。

## Windows 实测设计

使用官网下载、签名有效的 Brave、Opera 和 Vivaldi 程序，直接解包到测试
目录，不运行安装器。每次建立独立 HOME、LOCALAPPDATA、APPDATA 和真实
浏览器 profile；不复制日常 profile，不伪造 Preferences 或 extension UUID。
浏览器身份由可执行文件 hash、签名、产品版本、实际 browser PID 和品牌
版本页共同确认，不能只凭可能包含 Chrome 的 CDP product 字段判断。

生产默认 host 名用于正常用户注册，验收不覆盖它。CLI 通过 `--output`
导出 manifest，测试只改随机 host 名并注册事前不存在的 HKCU 叶，再由
浏览器真实启动 native host。该路径验证导出、注册 namespace 和原生
launcher；不等于生产固定名称 installer 已完整实测。测试在原 host EOF
退出、endpoint 回收和浏览器进程退出后核对并删除自己创建的注册叶。

profile 发现必须读取真实目录里的扩展记录，并将 live `getInfo` 的实例
UUID 关联到正确品牌。随后用公开 selector 读取实例，执行后台输入、点击、
真实 HTTP 提交、截图和 finalize；连续独立观察页记录所有 tab 激活和窗口
focus，不为品牌差异增加隐含豁免。

Opera 的 native inventory 额外返回 `opera-ad-blocker`。官方将它说明为
[无需安装的内置功能](https://addons.opera.com/en/extensions/details/opera-ad-blocker/)，
本次实际 tuple 为 `FROM_STORE / DISABLED / INTERNAL`。测试只在真实签名
Opera 身份通过后，将最多一个该准确关闭条目单独记录为 browser feature；
启用、重复、未知或跨品牌条目仍失败，原始清单不删改。通用 Chrome/Edge
清单校验器保持原规则。

Brave `155.1.97.56` 的 `native-installation-brave-f2CLp5` 已通过该场景。
真实 profile 为 `Default`，公开 CLI 正确关联 live 实例，错误品牌和 profile
被拒绝；唯一原始 POST 的 input/change/click 均可信，后台 PNG 的随机色块
与收据一致，finalize 后任务 tab 和 debugger attachment 消失。测量区间
零 tab 激活、零窗口 focus、无豁免；宿主与浏览器保留句柄均 exit0，随机
注册叶、endpoint 和自有进程清理通过。原生产注册和扩展 ZIP 未改。

最终 Opera 发现修复后的 host 与最终脚手架另跑
`native-installation-brave-eF73Op`，再次完整通过。新增只读观察确认 fill 前
为空，之后准确写入 nonce 文本、活动元素为目标 input 且收到可信 input；
最终原始 POST 保留该事件并追加可信 change/click。四个连续焦点检查点均
零事件，截图、finalize 和精确进程退出独立核验。生产 ZIP 仍为原字节。

此前四次 Brave 脚手架失败依次为 PS5 模块混载、中文版本页解析、品牌开关
点击未生效，以及异步创建标签页返回空 URL；原始失败均保留，未计为通过。
测试现核对版本页的实际 profile 字段、已观测开关及加载后的准确哨兵 URL。
外部输入法进程根据路径与 profile 参数区别于浏览器所有权，记录但不终止。
这次焦点记录不等于独立测量了系统物理鼠标，也不覆盖重启、签名更新或
全部能力矩阵。执行方法见 [验收脚本说明](../../scripts/browser-integration/README.md)。

Vivaldi `8.2.4133.84` 已验证真实 native launcher、profile/UUID 发现及 selector。
其私有 UI 创建诊断页后才有可求值文档；测试记录原生 `tabs.create` 返回及
唯一新增 target，并为独立 observer 仅授权实际 UI extension ID 的准确 HTML
资源。该准备步骤不替代任务操作，也没有给后台任务添加焦点豁免。
`native-installation-vivaldi-V8o50Q` 的公开 fill 返回成功，但唯一实际提交为空、
没有 input 事件，点击事件为可信；因此整项失败。加入只读输入前后观察后，
`native-installation-vivaldi-eNV0Su` 又在首次 goto 的十秒期限失败，尚未到输入。
两轮均正常退出并清理。输入及导航原因仍待定位，不能把原生连接通过称作
Vivaldi 后台能力通过。

Opera `137.0.6036.39` 的 `native-installation-opera-KVzWiz` 已成功原生连接，
但 CLI 连续发现为空。退出后的实际 Secure Preferences 将扩展记录存于
`extensions.opsettings`，旧扫描仅读取 `extensions.settings`。该失败记录保留；
修复后仅 Opera 按已知品牌读取该字段；冲突双表不跨品牌回退，Default 与
根 profile 均有回归。新 host 的 `native-installation-opera-b2zz2L` 已实际通过
安装发现、连接归属及正反 selector 检查，但 newTab 报 `No group with id`，
尚未到输入、点击和截图。整项仍失败，未把发现修复称作完整任务通过；原生
host 与浏览器正常 exit0、零前台事件和随机注册清理均独立保留。

## 官方资料与来源

- [Brave 官方发布](https://github.com/brave/brave-browser/releases/tag/v1.97.56)：
  Windows x64 ZIP 及其 SHA-256；解包的 Brave Browser 产品版本为
  `155.1.97.56`，签名发布者为 Brave Software, Inc.。
  Windows profile 常量和断言见固定提交的
  [install modes](https://github.com/brave/brave-core/blob/5e268a047e51ba615c536db3aabbb782eb34550c/chromium_src/chrome/install_static/chromium_install_modes.h)
  与 [profile 测试](https://github.com/brave/brave-core/blob/5e268a047e51ba615c536db3aabbb782eb34550c/chromium_src/chrome/install_static/brave_user_data_dir_win_unittest.cc)。
- [Vivaldi 官方下载](https://vivaldi.com/download/) 与
  [官方构建说明](https://help.vivaldi.com/desktop/install-update/obtaining-official-builds/)：
  Windows x64 `8.2.4133.84`；签名发布者为 Vivaldi Technologies AS。
  [About 页](https://help.vivaldi.com/desktop/install-update/about-page/)
  提供 profile 路径。仅解包官方安装包，不执行注册默认浏览器的安装流程。
- [Opera 官方下载](https://www.opera.com/download)：Windows x64 离线包
  `137.0.6036.39`，签名发布者为 Opera Norway AS。
  [Native Messaging 文档](https://help.opera.com/en/extensions/message-passing/)
  使用 Google Chrome namespace，但 Windows 示例写的是 HKLM；不能将
  文档示例直接当作 HKCU 已实际验证的证据。

二进制中的 NativeMessagingHosts 字符串只能说明存在候选路径，不能证明
实际查询次序。新增浏览器真实验收结果会单独记录；macOS/Linux 不因 Windows
成功而视为已验证，便携和自定义 profile 路径也不由默认目录扫描自动覆盖。

Linux 仅增加有官方源码依据的 Brave：
[`chrome_paths_linux.cc`](https://github.com/brave/brave-core/blob/5e268a047e51ba615c536db3aabbb782eb34550c/chromium_src/chrome/common/chrome_paths_linux.cc)
定义 `$XDG_CONFIG_HOME/BraveSoftware/Brave-Browser`，未设时使用 `~/.config`；
[`brave_main_delegate.cc`](https://github.com/brave/brave-core/blob/5e268a047e51ba615c536db3aabbb782eb34550c/app/brave_main_delegate.cc)
将用户 native manifest 放在该根下的 `NativeMessagingHosts`。Windows/macOS/
Linux 的相关 Go 代码通过编译和单测不等于在三个系统真实运行；本片不增加
macOS 的三个品牌或 Linux 的 Opera/Vivaldi 默认安装路径。
