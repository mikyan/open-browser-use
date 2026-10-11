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
| Opera Stable | `%APPDATA%\Opera Software\Opera Stable` | 同上；实际 HKCU launcher、发现及本片无组后台多页任务已通过 |
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

## 后台失败的原生命令诊断

显式 `OBU_TEST_NATIVE_DIAGNOSTICS=1` 只在隔离测试 worker 中加入有界 API
观察，原 connectNative、任务输入和焦点规则保持不变。诊断始终
`passed:false`；`diagnosticCompleted:true` 与 exit0 只表示原任务已到达、
记录连续且原生清理完成，不表示任务通过。原生命令 pending、截断字段
及未观察到的内部因果都不能推测为成功；用法见上述验收脚本说明。

Opera 首轮 `BnR9eF` 的初始快照早于 worker module 执行，整体诊断不完整。
将读取移到原有 native 握手后，`pmcGIj` 完整记录同一失败顺序：
`tabs.group` 成功返回，随后标签变为 `groupId=-1` 且组收到 `onRemoved`，
再调用 `tabGroups.update` 时才拒绝。可确认更新前组已经消失，事件本身
不能证明是浏览器自动处理还是其他原因。两轮没有 goto/输入/提交；
真实任务均失败。最终一轮连续零激活/零focus，原生 host/browser 正常
exit0、独占随机注册及私有进程清理通过。

Vivaldi stable `6TvJ0U` 的 debugger.attach 与 Target.getTargetInfo 成功，
实际新页 URL 仍为空。随后九条 renderer 初始化命令直到最后快照仍未
结算，尚未发送 Page.navigate 或 Input，实际 GET/POST 均为零。该轮
完整诊断与清理通过，任务失败；不能据此断言导航命令超时或键盘目标错误。
此前 `V8o50Q` 的 fill ACK 后实际空值证据仍独立保留。

另解包官方签名的 Vivaldi snapshot `8.3.4185.3`，其 `l5U4my` 在安装前
manager 页面首次求值超时，未到扩展、host 或任务。虽然浏览器正常退出、
随机注册和私有进程已清理，因为没有 host EOF，完整诊断仍未通过。
这不能评价新版分组或输入；该运行使用 stable catalogue 隔离目录覆盖，
也不证明 snapshot 默认目录发现。没有用新运行改写旧失败。

## 普通无组任务页的真实验收

新生产实现复用显式辅助归属，允许本次 admission 创建的单页组消失后
按真实 tab 单独管理，规则见 [普通无组任务页](ungrouped-task-tabs.md)。
`OBU_TEST_NATIVE_OWNERSHIP=1` 在原单页任务后增加两 session 的多页任务，
本片没有启用 API 诊断或修改生产 connectNative。

同一冻结源码与新 ZIP 的 Opera `native-installation-opera-7IDBb7`、Brave
`native-installation-brave-vC2mkf` 都已真实通过并独立审计。每轮原 12 步
后台任务及后续 35 步 ownership 流程完成，四个原始 GET、五个可信 POST
与页面收据逐项一致。A/B 的 foreign claim 被明确拒绝；handoff A 后 B
实际关闭，显式新 turn 接管 A 仍保留 agent 来源；交付 C 时 A 实际关闭，
C 保持非活动且无 debugger，更新控制范围后仍明确无权读取 C。

Opera 的 A/B/C 原生快照都无分组，Brave 保留真实任务组并在交付时进入
交付组，分别验证两条路径。每轮十个连续焦点检查点均零激活、零 focus、
零豁免，测量窗口约 2.0/2.4 秒；这不代表长时间压力或物理鼠标的独立测量。
真实 native host/browser 保留句柄均 exit0，精确进程、随机注册两视图清理
完整，固定生产注册不变。截图实际查看通过；fixture 的长收据有水平溢出，
完整原始 POST 独立核验，不借裁切截图推断全部值。

新 ZIP 为 1,260,454 字节、47 文件，SHA-256
`6ff5c281ad7769750abc66ffde203995a482cd60c5caf1fdfed3bd4e3a7ed5b3`。
独立审计匹配全部制品成员、369 源文件与 210 条旧运行结果；新安装包不
覆盖旧制品或失败证据。CI 为 1,001 项 Node（806 扩展、53 脚本、142
脚手架）、JS115、Python82、Go全包通过。没有推送、PR或日常浏览器安装
变更；其他生命周期和平台边界仍按前文保留。

同一生产版本的 Vivaldi `native-installation-vivaldi-b9p876` 保留失败：About、
管理页、扩展安装、真实 native 连接及 selector 发现都完成，但独立焦点
观察页的首次 readiness 求值超时 20,003 ms。同一 target 从扩展 URL 变成
空 URL/title；任务尚未开始，GET/POST 都为零，也没有建立连续焦点账本。
浏览器和原生 host 正常 exit0，清理完整。该记录既不证明 Vivaldi 任务通过，
也不能归因为新 ownership 路径回归；旧的实际输入与初始化失败仍开放。

对 attach 前原生提交状态的独立诊断、固定上游源码和推断边界见
[Vivaldi 首文档诊断](vivaldi-initial-document.md)。诊断不改默认验收或生产
输入，不因 target URL 变空就认定导航失败。
新 `7y16Q1` 两个设置页面均通过提交检查并进入任务，但 fill ACK 后实际值
仍空，唯一原始 POST 也为空；诊断完整、任务失败。默认 Brave `t8wpE8`
通过，生产 ZIP 未变。单次设置成功不解除 Vivaldi 原初始化及输入缺口。

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
