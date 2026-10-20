# Managed 人工新页面选择

## 行为

当前开发版允许人在独立 managed 浏览器的查看器中选择符合网站权限的原生
页面，包括人工操作新开的子页。活动接管显示“切换页面”：先结束原租约，
等原输入释放与附件清理确认，再用下拉列表选择另一页。新页选择成功后接管
该页；普通“完成接管”只结束当前租约。最终 Resume 仍须明确点击，Agent
在新轮次重新认领原页面后才能继续任务。

子页完成业务后自行关闭时，查看器先确认该原租约的实际清理，再允许选择
父页并明确开始接管。跨站 iframe 发起的原生新顶层页也经过同一个显式选页
入口。父页在回调后发生跨文档导航的返回流程仍有已知查看启动失败，尚未完成验收。

这里只列原独立 Browser 内的页面，不打开替代网址、不搬动或重新分组页面。
页面 title、URL 和 opener 关系只用于展示或诊断；原生来源事件不授予 Agent
控制权。普通安装的个人浏览器不会获得此目录。

## 选择与交接

`ManagedHumanPages` 集中管理只读目录、稳定的临时选择、实际结果登记和
原调用清理。每个目录绑定原 run、Browser incarnation、worker 和用户
channel。导航、关页、替换或位置变化撤销旧选择；移走再放回也不复用旧选择。
目录容量有界，刷新原未改变的页不会无限生成选择记录。

状态的 `pageSelectionVersion: 1` 在原 channel 固定，包括断线后的清理状态。
`kind: browser` 页面携带 `pageSelectionId`，与结果页的 `deliveryId` 互斥。
新的 select/humanBegin 必须携带原选择；成功响应另带精确
`pageSelectionReceipt: {tabId, pageSelectionId, deliveryId, retained: true}`。
旧 task/result 请求保持原合同，不附该回执。Go 和界面先丢弃旧状态，再检查
能力固定；列表或后来状态不能冒充原请求成功。

选页先暂停 Agent，等待旧查看/人工资源清理，再重新证明原 target、文档、
Browser、位置与网站策略，通过现有结果登记的 reserve、stage、实际 IDB
事务和 publish 保存。不会调用 Agent finalize，不增加 task membership、
auxiliary ownership 或 tabOrigins。随后使用实际 deliveryId 查看/接管，
结果页保窗认领与 worker 恢复复用原有机制。

IDB 事务完成是提交事实。调用者之后失联时，仍有效的原页面保持已提交结果，
但不向旧 channel 交付或启动新租约。原页面或位置真的失效时撤销确切记录并
等待 journal 清理。逻辑取消不替代原 Chrome 读取、提交或撤销的实际结算。
Resume 不得跨尚未结束的选页操作。当前人工页面的目录展示使用原租约元数据，
避免只读刷新撤销正在导航的结果。

原生关页撤销画面发布前，桥接先保留确切 `record.closing`。同一原租约的
End 可以加入该实际清理 Promise；新选择、新接管或断线后的旧 End 仍拒绝，
清理失败不能由后来状态改称成功。Go 将显式 End、Pause 或取消选择造成的
输入撤销与断线区分：未提交输入取消，已经提交的原调用沿原 deadline 等待
确切 native ACK，不重发、不延长期限。Stop、断线及未知失败保持原取消语义。

## 验证状态

旧实现的 `mnp-zusBw5` 七步诊断和 291 项独审已通过：一次原查看器点击
创建真实跨站子页，active/End 后列表都没有该页；父子原 target/document
保持，子页零输入、零 callback。原 End/Resume 后独立任务恰一次 POST，
Stop 无强制结束、29 个原进程身份退出，45 张 PNG 解码。
`featurePassed:false`，该运行只证明缺口，不能视为新功能验收。

新实现通过桥接 104 项、扩展相关 77 项和 UI 219 项定向检查，原失败日志
保留。修复了 Pause 期间目录刷新报错、已关闭选择卡住自动切换，以及 End
成功回执先发出而释放通道稍后才解除的竞态；均未放宽原输入清理门禁。

全新 `mso-build-vbhgx95q` 绑定 468 份输入与 80 份扩展，完整 Go test/vet
和 3,161 项 Node 检查通过，独立构建核对确认原字节与日志。另有 76 项
验收脚手架检查。构建 SHA256：
`ef6466ece03768491d7cc7977a560292b03f79ef9fb59ad72677634934ec2da0`。

同一构建的 `mnp-vSEJQb`（window.open）与 `mnp-SLnf2u`（target=_blank，
实际无 opener）各七步通过，均实际退出 0、`featurePassed:true`。原查看器
操作创建跨站子页，经原 End、显式选页与真实保存回执接管子页，一次可信
点击产生唯一 callback POST；再切回原父页，草稿和原文档保持。最终 End、
Resume、新轮次、SDK claimUserTab 及原 locator 读取确认回传内容，原
target/window/placement 保持；独立 handoff 另有一次唯一业务 POST。
根 agent 目视子页与返回父页截图，工具栏和“切换页面”入口显示正常。
两结果 SHA256 分别为：
`4da28c1eae6e066f8575cb91904a190d32ecaf079f3a4a748fd7dbdf19173b7f`、
`4965610c111ed98ca4a3effab2bb4909d0ae1cd9c6b827be326e3f6efb530494`。

独立事件/业务审核分别 510、511 项通过，来源/生命周期审核分别 190、188
项通过。各轮核对 978 份原验收快照、80 份扩展、26 份 SDK；30 个原进程
身份均已退出，Browser/Native/viewer/supervisor 正常退出，Job 为零，双
注册视图、原管道与 endpoint 清空，无强制终止。两场 51、50 张 PNG 完整
解码。SDK 证据是冻结 runner 的原 await 结果，未另抓 IPC；callback 正文
核对服务器精确验值、原 116 字节和回执，没有宣称保留原正文抓包。
事件报告 SHA256：`7b5b4867faeafb357e673d453a0ce6429ff1dc77a724d527766f4a56a86bb5fe`、
`0ae92aeb1edfeb1d2ea481000762a00b6839485f606bff3ad47f90a6948a11b7`；
生命周期报告 SHA256：`09453698be0903429bdf2e48b320a0f29bb4c500a1ee7ba77b4eec976ae6b495`、
`b2bc1e0fa711c8068b266ab8238cbdbb5dc0ca685dfe803576cbc937b45ed767`。

随后增加 91 项纯脚手架检查和三个显式变体。旧产品的 `mnp-u7zi86` 实际
退出 1：原可信 callback 已成功，子页确实关闭，但原 up 与自动 End 都返回
`OPERATION_UNCONFIRMED`，后来清理状态成功不能覆盖这次失败。72 项失败
清理独审确认原记录、27 个原进程退出及资源清理；原失败完整保留。

修复上述桥接退休清理和 Go 已提交输入回执后，桥接 118 项及 Go 定向检查
通过。全新 `mso-build-5hq5mhv0` 绑定 470 份输入、80 份扩展，完整 Go
test/vet 和 3,175 项 Node 通过；构建 SHA256：
`46fa5346371d2338605de789e76f30c6181a4f2946a9c72458ce095d9d3122e4`。

该构建的 `mnp-rFuyoq`（child-close）和 `mnp-sCc9Xa`（iframe）各七步
实际退出 0、featurePassed true。关闭场由原可信点击提交 callback，实际
响应后立即 window.close，没有为 ACK 增加延时；原 tab/target 消失和原
清理确认后，用户明确选择父页及 Begin。iframe 场核对原跨站 frame 的
document、真实点击和到顶层画面的坐标投影。两轮都返回原父文档，经
End/Resume/新轮次和 SDK 原页认领读取，再完成独立唯一 POST 与 Stop。
两场原结果 SHA256：
`453d7b16000953316f457eb3565ba584d819ef4d74b33592cab6e8b82727ee13`、
`684fbb5c5249bbd2542f47ee9a4ec25d75b6afd652576779b2d1f32fc1c52c4d`。

两场事件/业务独审各 353 项通过；来源/生命周期分别 3,871、3,875 项，
核对 980 份原快照、80 份扩展、26 份 SDK，28/30 个原进程均退出，51/52
张 PNG 解码，Job、注册、管道和 endpoint 清理完成。根 agent 目视关闭后
父页及 iframe 子页截图，原文字、工具栏和切换入口正常。每轮五次 End 与
实际业务输入回执成功；两个 End 后的负探针按预期拒绝。关闭实测中的 up ACK
先于 close，不能声称现场覆盖了
迟到 ACK 分支，该分支由定向测试证明。关闭场保留 198 字节原 callback
正文；iframe 场保留 116 字节计数、回执和可信 DOM，未保留原正文抓包。
事件报告 SHA256：`266811fb7f62aec1c9b993eef2931fbbf27589f4a97115337847d340fa70a3e4`、
`9fa2dd7bf876328056b685cb9a1b59d0fdc38119c47e57c436c702fe58f92e34`；
生命周期报告 SHA256：`79ee726cbfac177b88409bd6d17f4e0dffe98865cb9b5334db64a799fe330dc5`、
`a556059bf382ef9ff3c029af4e14c806c705d682397ef8de8b30edf8bc68d738`。

同构建 `mnp-OxVElx` 的 parent-navigate 首场实际退出 1、featurePassed
false。callback 后原 tab/target 已导航到新 document，夹具应用通过
sessionStorage 迁移草稿，这不属于 Browser Use 自动保存草稿的能力。
原 child End 成功，随后选择使用该回执提供的新令牌，父页也已出现新的
result delivery；但查看保持“页面正在跳转”且没有取得首帧，select 最终
返回 `OPERATION_UNCONFIRMED`。底层机制尚未确认，不能称为已解决，也
不能用已保存结果、callback 成功或完整测试通过替代此流程验收。原结果
SHA256：`e9f0e7eaca01f24939cd7e7ca15917bc7a644fe6b35f894ba64583d7be7f29ae`。

已按用户要求发布
[preview-20261021-be3a0f9](https://github.com/mikyan/open-browser-use/releases/tag/preview-20261021-be3a0f9)，
源提交为 `be3a0f9d4dacc343944797aa96fe978e3f80429f`。完整包/扩展/Skill
分别为 111/80/7 文件；发布 EXE 从干净提交独立重建，470 份源码与已测
字节绑定，80 份未加 key 的扩展文件与已测制品一致。离线 CLI/MCP 30 工具、
4,777 项制品独审、四资产回下载和 115 份本地副本核对通过；发布 EXE 未
重跑原网页业务。完整 ZIP 10,690,643 字节，SHA256：
`0dd0670934197da3195d932e7d54753ce05fde9d6e33f3c9235e1cc9efd2a27d`。
公司 Edge 人工验收继续延期。复杂 SSO/MFA、更多 iframe 开页变体、父页回调导航及完整 Browser
Use 能力对齐仍开放，不能由目前已通过的有限合成页面证明。

执行记录见[本片计划](../exec-plans/active/2026-10-21-managed-human-pages.md)。
