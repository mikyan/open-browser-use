# Managed 人工新页面选择

## 行为

当前开发版允许人在独立 managed 浏览器的查看器中选择符合网站权限的原生
页面，包括人工操作新开的子页。活动接管显示“切换页面”：先结束原租约，
等原输入释放与附件清理确认，再用下拉列表选择另一页。新页选择成功后接管
该页；普通“完成接管”只结束当前租约。最终 Resume 仍须明确点击，Agent
在新轮次重新认领原页面后才能继续任务。

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

新功能尚未发布；当前可下载包仍为
[preview-20261021-5b3d2f4](https://github.com/mikyan/open-browser-use/releases/tag/preview-20261021-5b3d2f4)。
公司 Edge 人工验收继续延期。复杂 SSO/MFA、所有 iframe 开页变体、父页回调
导航、子页关闭回传及完整 Browser Use 能力对齐不能由这两种合成页面证明。

执行记录见[本片计划](../exec-plans/active/2026-10-21-managed-human-pages.md)。
