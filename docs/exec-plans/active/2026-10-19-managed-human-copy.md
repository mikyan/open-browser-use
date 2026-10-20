# 人工接管的本地复制和剪切

## 目标与当前缺口

继续完整Browser Use能力对齐。用户再次要求新包；本轮已接入正式
viewer/Go/extension 纯文本返回通道，完整 Go test/vet 和 2,999 项 Node
检查通过。正式双浏览器五种复制/剪切行为与七步生命周期验收通过，配套新包
[preview-20261021-b63b768](https://github.com/mikyan/open-browser-use/releases/tag/preview-20261021-b63b768)已发布。
具体协议与使用边界见[生产接口](../../references/managed-human-clipboard.md)。

需要保留一次原生复制/剪切，包括网页自定义结果、取消与实际剪切编辑，再把
本次结果返回本地。不能把读取selection冒称完整copy，也不能把旧全局剪贴板
内容当成此次操作结果。明确End、导航、失焦和未知回执时的本地写入及原生
清理。原输入不重试，不用辅助剪切或selection删除重演网页行为。

## 机制研究与验收

- [x] 当前源码审查确认返回通道缺失，区分已有SDK共享clipboard接口。
- [x] 本地端原生诊断：在可信快捷键内立即发起ClipboardItem Promise写入，
  原异步结果到达后完成；拒绝时保持原内存剪贴板。
- [x] 远端原生诊断：普通copy/cut、自定义setData/取消、传播阻断及后注册
  listener。证明同步bubble、microtask或ACK后读取不能普遍取得最终结果。
- [x] 固定原生ClipboardItem版本机制研究：18个不同copy/cut动作及两种读取
  竞争已观测，确认共享浏览器clipboard的版本检查可行；不授予页面来源证明。
- [x] 定义明确的浏览器共享clipboard产品契约、运行时能力检查及可靠返回接口。
- [x] 保留当前实际失败基线；实现正式viewer/Go/extension链路和生命周期。
- [x] 真实双隔离浏览器验收普通文本、重复复制、自定义复制、无选区、剪切
  与End；原文档、逐次ACK、本地原生paste、唯一业务提交和Stop通过。
- [ ] 扩展生产链路的网页取消、导航竞争与复杂iframe/OOPIF真实验收；
  普通Windows系统剪贴板及公司Edge仍待用户方便时补验。
- [x] 提交用户fork并发布配套新包；离线CLI/MCP、独立制品、四资产回下载
  及本地113文件副本核对通过，未创建PR。

## 已有证据与后续边界

详见[研究结论](../../references/managed-human-copy-research.md)及正式的
[本地机制诊断脚本](../../../scripts/browser-integration/managed-clipboard-local-probe.mjs)。

正式`clipboard-local-qbb9xe`实际退出0，三场异步复制确认/复制拒绝/剪切快捷键
确认通过。固定内存clipboard，无预授予permission；拒绝保留原seed，原生paste
核结果，8个原进程身份退出。它验证本地Promise写入机制，没有正式远端桥。
结果SHA256：`d1927418c505e9a0c0c8b301dfd5133c5ec84c9d211ac35e5407e0d90db738d4`。

`local-FgMmHT`实际退出0，三场复制确认/复制拒绝/剪切快捷键确认通过。只验证
本地ClipboardItem Promise机制，没有正式远端桥；无预授予permission，使用
固定156.0.8078.4的已审HeadlessClipboard、可信CDP按键与原生paste核结果。
拒绝保留原seed，原进程正常退出；没有读写系统剪贴板。
结果SHA256：`c75e7bbe49e93e8ff52bdb988b33e37bf470d09b2967c7fa6bf58a909475455e`。

`native-kgC8GL`实际退出0，11场、69原事件。capture的microtask早于网页
handler，普通bubble又可能早于后注册window handler或被传播阻断；ACK后
原DataTransfer已不可读。默认copy事件数据本来为空，默认cut删除后选区也
为空。因此该诊断否定“事件观察+selection即可完整桥接”的方案，不是产品
复制能力已通过。8个原进程身份退出，未调用Clipboard读取接口。
结果SHA256：`50e5f5a6d30f6dba44207bbb59a396354d141780925e47368b115799cdff9dc5`。
首次`native-tviJmU`因重复setDocumentContent保留顶层const而夹具失败，原记录
保留；新独立诊断只用IIFE修复夹具定义，不修改原失败或产品。

远端版本研究保留三个独立run的真实退出`1/1/0`，没有重跑其中已执行的C/X。
前两次失败来自错误预期：无setData的取消实际不写入；显式设置空文字实际
改变版本，但新item的types为空。原失败不改写为成功。18场原动作与两种竞争
的聚合研究有116项事实核查；原native读取遇另一写入以InvalidStateError拒绝，
已读Blob在交付前被另一合成tab写入后，原item末次检查同样拒绝。
报告SHA256：`d2a484a1f2a3466814a37c763ed646e6db8712a9de051acf1dc66be423e6c3ee`。

新版本可以来自同一浏览器的其他writer；不能声称属于原标签页或复制事件。
复制无新写入时不得返回旧clipboard，取消不能补发快捷键或模拟删除。正式
viewer/Go/extension链路与End/导航/断连清理已实现并通过回归检查。
正式`mhc-4Ft36v`五种复制/剪切行为和七步流程通过，原结果SHA256：
`8429fc8acdb32955e799e95a4fb5ab25b54e9fe55cfdedbe5fa9110d8e30e7d4`。
本轮固定内存剪贴板不覆盖iframe/OOPIF和本机系统剪贴板；整体目标保持active。
