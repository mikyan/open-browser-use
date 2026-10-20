# 2026-10-21 | 人工新页面选择与原页返回

已按用户请求发布 [preview-20261021-96595fc](https://github.com/mikyan/open-browser-use/releases/tag/preview-20261021-96595fc)，制品源码固定为 `96595fcae1112d81ad6d868f934fa9912cec84f5`。完整包/扩展/Skill 为 111/80/7 文件；完整 ZIP 10,693,484 字节，SHA256：`da80a8442a5a0fcfb63cca391104d68c6870b77571683045ca2aa1fb1ff2c79b`。发布 EXE 从精确干净源码独立重建，离线 CLI/MCP 30 工具、4,807 项制品独审（报告 SHA256：`cb365d4ff941e00d4ca0af69857c5ddbc8366965cbbddfeb87dc76590bb28929`）、四资产回下载及 115 份本地副本核对通过。发布 EXE 未重跑网页业务；后续文档提交只记录交付，不改变制品源码。

普通公司 Edge、真实 SSO/MFA、更多 iframe 组合及完整 P01–P15 仍开放。下文保留各轮开发与发布历史。

## 用户诉求和范围

持续推进 Browser Use 能力对齐，使用用户 fork，不新增 Pi 适配、不提 PR。
此前明确请求的新包已交付为 preview-20261021-5b3d2f4；本轮继续开发人工
接管中新窗口的接续。用户随后再次要求新包，已交付新增功能并明确父页回调
导航的已知限制；实际发布记录见下。
公司 Edge 人工验收继续延期。

## 改动和原因

旧版只列 Agent task 和已交付 result，人工操作产生的原生子页没有可选入口。
正式基线 mnp-zusBw5 与 291 项独审确认这个缺口，featurePassed 为 false。

新增 ManagedHumanPages 管理原独立 Browser 的只读目录和用户显式选择。
选择绑定原 channel/Browser/target/document/位置与网站权限；导航或位置
变化撤销旧选择。Pause 和旧输入清理完成后，使用原结果 journal 的实际
IDB 事务保存原页，不借用 Agent finalize、不建立任务成员权或移动窗口。
真实提交后断线不会伪称回滚，也不会给旧调用者新的人工租约。

Go、桥接和 UI 固定 pageSelectionVersion，选择令牌与 deliveryId 互斥，
原保存回执绑定 tab/choice/实际 delivery。查看器新增“切换页面”，严格
等待原 End 清理回执，再选页与接管。旧 task/result 行为保持；普通完成
接管不恢复 Agent，恢复后仍须新轮次和显式认领。

审查修复 Pause 期间目录读取失败、已关闭选页卡住自动切换、End 回执先于
释放 admission 的时序问题。原失败日志保留。桥接新增测试最初有三项仅
等待一次调度而过早断言，改为确切 entered/committed 信号后通过，产品
没有为计时假设修改。

主要改动为扩展 managed-human-pages、background 与 managed-user-bridge，
Go managedprotocol/managedbrowser/managedviewer，以及正式查看器和六个
new-page 验收文件。完整合同与证据见[人工新页面选择](../../references/managed-human-pages.md)。

后续 child-close 首场揭示原生关页已完成，但桥接先撤销 stream 再处理同租约
自动 End，导致真实清理与原 End 错误矛盾。桥接现在先登记实际 close Promise，
确切退休租约可加入原清理；后继选择/接管、断线和实际清理失败仍阻止成功。
Go 为显式释放增加专用取消原因，已提交输入继续等待同一调用的原 native ACK
与原 deadline，不重新发送或用页面业务成功补造 ACK。未提交输入、断线、
Stop 和其他失败仍按原方式撤销。

## 验证

扩展相关 77 项、桥接 104 项、UI 219 项及三个 Go 包定向检查通过；验收
脚手架 76 项通过。全新 mso-build-vbhgx95q 绑定 468 份输入与 80 份扩展，
完整 Go test/vet、3,161 项 Node 检查通过。构建独审核对全部原字节与日志，
SHA256 为 `4fb0b4a16d65f2d6628a42cc449fa753cd4e287200d68da2729a7ffeba205bc3`。

正式 mnp-vSEJQb 与 mnp-SLnf2u 各七步、实际退出 0、featurePassed true。
两种原生触发分别为 window.open 与 target=_blank（确认无 opener）。
原子页可信点击完成唯一 callback，切回原父页保留草稿，再经 End/Resume、
新轮次和 SDK claim/read 确认原回传与原 target/window。独立 handoff
另有一次唯一 POST，最后正式 Stop。根 agent 目视两张原截图，工具栏与
返回父页内容正确。两场事件/业务独审 510/511 项、来源/生命周期独审
190/188 项首轮通过，各 30 个原进程退出、51/50 张 PNG 解码、注册与
管道清理通过，无强制终止。原 SDK await 结果和服务器精确 callback 验值
构成业务证据，未另做 IPC 或原正文抓包。精确报告摘要见上述参考说明。

新增三个变体的 91 项纯检查通过，保留 null 配置默认值与 iframe mock 矩形
两次脚手架失败；未为验收改变关闭速度。桥接 118 项及 Go 定向检查通过。
新 mso-build-5hq5mhv0 绑定 470 输入/80 扩展，完整 Go test/vet、3,175
项 Node 通过。旧 child-close mnp-u7zi86 实际退出 1，原 up/End 错误及
其后真实清理保留，72 项失败清理独审通过，不能当成功验收。

新 child-close mnp-rFuyoq 和 iframe mnp-sCc9Xa 各七步实际退出 0。
子页可信 callback、原 page 身份、真实清理和显式返父页、原 SDK 后续、
独立唯一 POST 与 Stop 均通过。事件独审各 353 项，来源/生命周期独审
3,871/3,875 项，28/30 原进程退出、51/52 PNG 解码、原资源清理通过。
根 agent 目视原截图，工具栏与回传内容正常。关闭场保留 198 字节原正文，
iframe 场只有原 116 字节计数、回执和可信 DOM；不声称原正文抓包。关闭
实测 up ACK 先于 close，迟到 ACK 代码分支的证据仅为定向测试。

parent-navigate mnp-OxVElx 首场实际退出 1。原父 tab/target 与新的文档
身份已确认，child End 和新选择令牌正确，结果登记已完成；查看未取得首帧，
select 最后返回 OPERATION_UNCONFIRMED。底层机制尚未确认。该夹具用
sessionStorage 迁移应用草稿，不能归功于 Browser Use 自动保存。此失败不
阻止交付另外两项已验变体，但不能标记导航返回流程完成。父页回调导航、
更多 iframe/SSO 组合、公司 Edge 和完整能力对齐仍开放，本片计划保持 active。

## 按用户请求发布

源码 `be3a0f9d4dacc343944797aa96fe978e3f80429f` 已推送用户 fork，配套
[preview-20261021-be3a0f9](https://github.com/mikyan/open-browser-use/releases/tag/preview-20261021-be3a0f9)
已确认为非草稿预览版。完整包/扩展/Skill 为 111/80/7 文件；完整 ZIP
10,690,643 字节，SHA256：
`0dd0670934197da3195d932e7d54753ce05fde9d6e33f3c9235e1cc9efd2a27d`。

470 份源码与已测字节及精确 Git 对象绑定，发布 EXE 从干净提交独立重建，
80 份未加 key 的扩展文件一致。离线 CLI/MCP 30 工具、4,777 项独立制品
检查、四资产回下载和 115 份本地副本核对通过。制品独审 SHA256：
`5ec406aa893cfe35edba631f95615ba8c039d1260cc49fcd20da5dee754c241c`。
本次打包没有重跑内部构建的网页业务，不把发布 EXE 当成原运行制品。
安装说明保留正常 Edge/Chrome 安装和覆盖更新，主机、扩展与 Skill 配套交付。
父页回调导航首帧失败明确写入安装包与发布说明，整体目标保持 active。

## 同功能重新打包

用户再次要求新包后，以精确干净提交
`719d0084f6641a7226713a0ae9c4823066e4e706` 重新构建并发布
[preview-20261021-719d008](https://github.com/mikyan/open-browser-use/releases/tag/preview-20261021-719d008)。
相对上一包仅六份仓库文档变化；470 份生产输入和 80 份扩展保持原已测
内容，未提交的原生诊断脚手架不在交付范围。包内明确说明功能与 be3a0f9
相同，未包含后台画面恢复修复，也未重新运行网页验收。

完整包仍为 111 文件，ZIP 10,690,793 字节，SHA256：
`ebae8569768da5eeafff3fe2264e36c26d63e5a5890b7ef29f2720eac2af61ef`。
发布 EXE 从此提交独立重建，离线 CLI/MCP 30 工具检查、4,781 项独立制品
检查、四资产上传后回下载及 115 份本地副本核对通过。独立审计 SHA256：
`384bb88e3f9d41b409abe9023b8d632713ffda2b862d2c1dc337b22cfaf584f8`。
发布为非草稿预览版；原父页导航首帧问题、公司 Edge 和整体能力对齐仍未完成。

## 后台父页新文档首帧与再次打包请求

用户询问是否结束并明确再次要求新包；整体目标仍未结束，本轮先完成已经
接近收尾的父页首帧修复验证，再交付新版本。原产品 mnp-vY2HSC 的有界
原生诊断确认录屏 start 已 ACK，约五秒没有原帧；77 原调用全部结算，
526 项诊断审核通过。诊断不当作产品通过，旧报告保留。

BrowserRendering 增加默认关闭的 captureHiddenSurface。仅 fresh 只读
view 在原 start ACK 后尚未发布帧时发起一次无 clip 的原 surface 截图；
截图回复不解决 ready，仍要求原 TimeTicks 门禁与实际录屏 ACK。调用进入
原队列、代次检查和实际清理屏障，不激活页面或设置焦点，人工输入路径不变。
rendering 35 项、human control 220 项及新全量构建 3,195 项 Node、Go
test/vet 通过；470 源码和 80 扩展冻结一致。

默认自动切换 mnp-uazoRV 通过但缺只读帧图像，所以新增普通 UI 的只读
阶段验收。mnp-yZ1Gwm 因错误要求整个窗口 focused=false 失败；原报告
与旧未修复报告均显示开子页后该值已经为 true。Chromium headless 的此
字段是逻辑活动状态，与父文档隐藏和系统前台不同。只改验收为原窗口状态
保持，页面依然严格 hidden/noFocus/inactive；新增前后变化反例，84 项通过。

mnp-kpUpaB（父页只读）和 mnp-FCpwvq（子页关闭）各七步真实退出 0，
事件业务独审分别 408/361 项通过。只读场确切 user-view seq1 PNG、原
lease/stream/generation、实际查看器解码和 Begin 前截图一致；根 agent
目视新父页标题、草稿及 callback 文本正确。SDK 原父页认领、独立唯一
POST 和正常 Stop 完成。原 PNG 证明与被动焦点快照不冒充全 OS 观测。
草稿由夹具网站自己迁移，普通 Edge/SSO/MFA 与完整能力对齐仍待验。
完整哈希与实现边界记录在 managed-human-pages 参考文档中。
