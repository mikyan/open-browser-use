# 人工接管中的新窗口和页面切换

## 目标

用户在独立 managed 浏览器的查看器中完成页面操作，遇到新登录、确认或授权
子页时，可以明确选择并操作它，返回原页面，最后交回 Agent 继续原任务。
不能把新页仅显示在列表里作为完成，也不能用重新打开 URL 代替原页面。
整体 Browser Use 对齐目标继续 active；本片不新增 Pi 适配、不提 PR，普通
公司 Edge 人工验收仍按用户要求延期。

## 当前证据与基线

上一轮属于 progress：用户要求的新包已发布为 `preview-20261021-5b3d2f4`，
发布文档提交为 `70df3ad`。本片开始时工作树干净。产品冻结构建
`mso-build-ebanssld` 对应 463 份输入、79 份扩展；新包不会因目标续轮自动重发。

代码检查显示 `onCreatedNavigationTarget` 只进入 Agent page waiter；人工
接管时 Agent 已暂停。查看器只列 task/result，活跃 human 时只投影原页。
现有非空 select 又拒绝活跃 human。因此原生新子页没有完整接续入口。
正式 `mnp-zusBw5` 已通过一次原查看器点击确认缺口：原子页真实存在，
active 与 End 后列表均不可选；父子页 target/document 保持，子页没有输入
或 callback POST。七步诊断完成，`featurePassed:false`、
`diagnosticGapConfirmed:true`；End/Resume 后独立原任务恰一次 POST，
Stop 无强制结束、Job 为零。291 项独审通过，45 张 PNG 解码、29 个原进程
身份退出。原产品 463 输入、79 扩展与 run 快照核对通过后才开始生产修改。
原结果 SHA256 为 `3bbc830ddaf884deef92772909a22118559fc7e7197e7da5971debef20676f80`，
独审为 `ba636571ab30fdd6d513551d610a5fd57dac4c52cce9b88058b0b5e7d56211c2`。
两次审计脚本字段/版本误写的失败报告保留；第三版纠正脚本后通过，未修改原记录。

## 设计决策

继续复用一次只绑定一个原生 page target 的人工租约。切换必须先撤销旧输入，
等待原按键释放、原实际操作及 debugger 清理，再捕获并解码新页画面。每页
仍有独立 lease/generation/sequence，Agent 全程暂停，最终 Resume 仍显式进行。

原生开页事件只能作为页面关系的观察。webNavigation 创建事件缺少来源
documentId，CDP opener frame 身份也不等于原文档，不用 URL、时间接近或
事后读取来源页面来拼造因果授权。

采用可信查看器中的显式选页：用户从当前独立 managed Browser 的真实
页面中选择，选择能力绑定当前 run、原 Browser incarnation、worker/channel
以及原 target/tab；进入页面时重新检查真实文档、位置与网站策略。页面关系
只是提示，不自动接管。这样正常 noopener、父页导航和跨站登录也可继续。
该授权不进入 Agent RPC，不扩大普通浏览器控制范围，也不恢复旧任务轮次。

原生依据：固定 Chromium 156 的 [Page.windowOpen 实现](https://github.com/chromium/chromium/blob/156.0.8078.12/third_party/blink/renderer/core/inspector/inspector_page_agent.cc#L1236)
不携带 child target 或原 document；[opener frame token](https://github.com/chromium/chromium/blob/156.0.8078.12/content/browser/renderer_host/frame_tree_node.h#L176)
属于 frame attribution，不能当作文档身份。`noopener` 也可能保留此元数据，
见[原创建实现](https://github.com/chromium/chromium/blob/156.0.8078.12/content/browser/web_contents/web_contents_impl.cc#L12831)。

页面列表、选择能力的失效和原页面交接应集中在小 Interface 后。不能把
不同顶层 target 塞入只管理 iframe 的 document graph，也不能伪造 deliveryId
或 Agent scope 复用现有入口。仅用户实际选择的页才能在 Pause、旧资源清理、
新原身份验证后，经 reserve/stage/真实 IDB commit/publish 成为保留结果，
随后复用既有 result 的查看、接管、导航和保窗认领。不能调用 Agent finalize
来发布用户页，因为它可能移动、分组或关闭别的页面。

状态新增 channel 固定的 `pageSelectionVersion: 1`；browser 页面携带互斥于
deliveryId 的 pageSelectionId。select/humanBegin 只有带原选择令牌的新入口
才要求 pageSelectionReceipt；回执绑定原 tab/choice 和实际新 deliveryId。
旧 task/result 合同保持。返回因回调发生导航的父页时，重新选择当前原页面，
不静默推进旧结果记录。原 task 父页由 Pause 保留，返回时也可取得新的选择。

IDB transaction 成功是实际提交点。原调用方之后失联不伪称提交未发生；
原页面仍有效时完成保留，但不向旧 channel 交付、不启动新 human。真正
页面/位置失效时撤销确切 record，并等待原 journal 撤销实际完成。未提交的
选择立即撤权；所有原读取、提交和必要撤销仍由 drain 等待。

## 工作顺序

- [x] 检查当前源码、已发布状态与仍有效的用户约束。
- [x] 新增有界、可复用的正式 new-page 诊断场景和 68 项纯脚手架检查。
- [x] root 在冻结产品与脚手架上运行原查看器单次触发，保存原子页、来源、
  原输入回执、列表缺口与完整 End/Resume/原任务唯一提交/Stop。
- [x] 固定原生能力研究及显式选页合同，确定持久交接与生命周期责任。
- [x] 实现用户页面选择、单页安全切换、返父页和 Agent 后续交接。
- [x] 运行模块/跨层反例及 root window.open、target=_blank/noopener
  真实浏览器验收，检查实际原文档、唯一 callback 和 Agent SDK 后续读取。
- [x] 验收跨站 iframe 发起的新顶层页，以及子页回调后关闭、原清理与返回父页。
- [x] 修复父页回调后跨文档导航的查看首帧失败，完成固定场景原页返回与 Agent 后续验收。
- [x] 同步架构、权限说明、产品状态与 history；通过后提交用户 fork。

当前实现中：扩展目录/真实结果登记、Go/查看器合同、桥接由三个互不覆盖的
修改面协作。桥接原 92 项回归及新增 12 项选择/清理/回执反例已通过；新测试
首轮有三项过早检查异步 Pause，改为等待确切 entered/committed 信号后通过，
未修改产品以适配计时。正式 UI 使用“切换页面”先等待原 End 清理确认，
再从下拉选择并接管新页；普通“完成接管”保持原语义。

新构建 `mso-build-vbhgx95q` 的 468 输入/80 扩展、完整 Go test/vet 和
3,161 项 Node 通过；独立构建审计确认全部输入/原 snapshot、扩展、EXE
与实际日志。`mnp-vSEJQb` 和 `mnp-SLnf2u` 两正式运行各七步实际退出 0、
featurePassed true。覆盖原 child callback、三次独立 human lease、切回父页
草稿保持、End/Resume 后 SDK 原父页 claim/read，以及独立 handoff 唯一
POST/Stop。事件独审 510/511 项、来源/生命周期独审 190/188 项首轮通过；
各 30 原进程退出、51/50 PNG 解码、实际资源清理完成。详细证据集中在
[参考说明](../../references/managed-human-pages.md)。尚不据此关闭本计划或整体目标。

本片实现已在 `eff1cdb` 提交并推送用户 fork；上一轮为实际 progress。
后续三个独立变体使用相同正式入口：跨站 iframe 的原点击创建顶层子页，
callback 后原父 tab 导航到新文档，以及 callback 后原子页自行关闭。
关闭页应由真实生命周期状态确认原租约清理，再由用户明确选择和接管父页，
不制造 humanEnd 回执。纯验收脚本变化可复用经逐字节核对的原产品构建；
产品源码变化则重新构建。各场原报告和失败保留，业务证据仍须完成 SDK
后续读取、独立唯一提交与正常 Stop。

三个变体的 91 项纯检查通过。旧构建 child-close `mnp-u7zi86` 首场真实
失败：callback 和关页已完成，原 up/自动 End 返回未知操作错误，后来
cleanup=true 不能抹掉失败。修复桥接中原关闭 Promise 的登记顺序，并允许
确切退休租约 End 加入实际清理；Go 显式释放仅取消未提交输入，已提交输入
沿原调用和原期限等待 ACK，不重发。新 bridge 118 项与 Go 定向检查通过。

新构建 `mso-build-5hq5mhv0` 为 470 输入/80 扩展，完整 Go test/vet 与
3,175 项 Node 通过。child-close `mnp-rFuyoq`、iframe `mnp-sCc9Xa`
各七步实际退出 0；两场事件独审各 353 项、来源/生命周期独审 3,871/3,875
项通过，28/30 原进程退出，51/52 PNG 解码，原资源清理完成。关闭场不加
业务延时，明确核原 child 缺席、原清理、显式父页选择与 Begin；两场原
SDK 后续、唯一 callback 与独立 POST 通过。关闭实测 ACK 先于 close，
迟到原 ACK 分支仍只据定向测试，不夸大为真实现场覆盖。

parent-navigate `mnp-OxVElx` 首场实际退出 1：原父 tab/target 已到新
document，业务草稿由夹具 sessionStorage 迁移；child End 后使用正确新
选择令牌，原结果已保存，但查看未取得首帧，select 返回未知操作错误。
底层原因仍在调查，该变体保持未完成。全部失败报告保留，详见参考说明。
用户再次要求新包后，已发布 `preview-20261021-be3a0f9` 并明确此限制。
完整包 111 文件、10,690,643 字节；470 份已测源码绑定到精确提交，发布
EXE 独立重建，离线 CLI/MCP、4,777 项制品独审、四资产回下载与本地副本
核对通过，未重跑原网页业务。制品摘要见参考说明；打包完成不关闭本计划或整体目标。

## 父页新文档首帧修复

原产品诊断 `mnp-vY2HSC` 再次在返回父页的 select 失败，实际退出 1；
它明确标为 instrumented，不作为正式验收。原生记录完整恢复且无丢失，
77 次发送均收到真实成功回执。父页新文档的两次 frame tree 一致，
TimeTicks barrier 取得后 startScreencast 立即成功，visibility 为 false；
之后约五秒没有原 screencastFrame，原 stop 也成功。不是已收到帧被门禁
丢弃，亦不是启动命令仍未确认。报告 SHA256：
`66fb98f434b724701e55b047e33769f11b9b4b6eed49e27839e4b5d3dbaec8f7`。

修复仅在 fresh-attachment 的只读 view 启动中，原 start ACK 后仍无
已发布帧时，使用同队列和真实 drain 发起一次无 clip 的原生 surface 截图。
不模拟焦点、不激活页面，也不以截图回复完成 ready；原 TimeTicks 和真实
录屏 ACK 门禁、五秒期限、撤权及原清理保持。新冻结构建的完整 Go test/vet、
3,195 项 Node 与 470/80 份输入通过。默认自动切换 mnp-uazoRV 七步通过，
但没有只读 PNG，故另验实际 End/select/只读解码/Begin 的正常 UI 路径。

首场 mnp-yZ1Gwm 保留为失败：脚手架把整个 headless 窗口 focused=false
错误当作前提；原页隐藏失焦不意味着整个逻辑窗口失焦。旧未修复场也在开
子页后变为 focused=true。仅修脚手架为前后窗口原状态不变，84 项检查通过。
最终 mnp-kpUpaB 的原只读 seq1 PNG、查看器解码和 Begin 前截图均核对；
根 agent 目视新父文档内容正确。mnp-FCpwvq 子页关闭回归亦七步通过，
两场 actual exit0，原 callback、SDK 后续、唯一独立提交与清理完成。
事件独审分别 408/361 项。原失败与所有快照保留，完整证据见参考说明。
用户本轮明确再次要求新包；因此在本修复提交后独立构建和核验发行包。
旧 719d008 包不含此修复，打包不结束整体目标或普通公司 Edge 待验事项。

## 验证要求

基线诊断不冒充功能通过。没有原生子页或原输入回执时记失败或证据不足；
确实存在原子页且正式列表不可选择时才记录缺口。诊断的子页业务不能自动
完成，真实操作后才允许回传。原 handoff 的唯一提交与清理继续独立核验。

最终验收覆盖普通 window.open、target=_blank/noopener、跨站子页、来自
iframe 的新顶层页、父子返回和子页关闭回传。原父页保持真实 target/window，
Agent 恢复后的原业务完成；不允许用新建同网址页面冒充接续。

必要反例包括旧选择能力、target/tab 改变、网站权限改变、父页导航、切换时
持键与未结算输入、End/断线/worker 丢失、失败清理阻止新输入、迟到响应
不能污染后继页面。原结果页和任务页接管、文件/剪贴板与多击仍保持其合同。

浏览器运行只由 root 启动，使用独立测试环境；不操作系统鼠标、键盘或剪贴板，
不触碰个人浏览器。每次实际运行前冻结源码与脚手架，所有失败原报告保留。
没有必要不重复已通过的完整套件；功能验收不得由构造 JSON 或纯列表检查代替。
