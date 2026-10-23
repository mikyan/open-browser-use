# Managed 独立 Agent 多页研究

2026-10-23，正式 managed 路径的 `mra-Ldr4sE` 原 runner 完成六阶段并实际退出 0。
两份新 variant-3 材料分别生成报告，每份回执包含六个来源；每轮唯一业务 POST、
5 个创建页面中的 4 个研究页关闭、两个报告共同保留，原 `about:blank` 仍在原位。
原 runner 与后置独审均完成；结论限于本次两份材料，不代表完整能力对齐。

## 入口与职责

[运行说明](../../scripts/browser-integration/README.md#independent-managed-agent-research-windows-experimental)
列出五个环境输入和 solver 协议。`managed-research-check.mjs` 使用实际
`managed run/status/stop`、正式 JS SDK 制品及真实查看器；它准备材料、监听
原生事件、验收结果和清理，不自动启动解题 Agent，也不代读资料或提交答案。
独立 solver 逐轮解题，各轮有新的任务键、材料和记录目录，第二轮等待第一轮 ACK。

solver 仅收到 launch card、公开 SDK 文档和
[通用被动记录器](../../scripts/browser-integration/recorded-agent-sdk.md)说明，
通过持久 Node REPL 调用正式 SDK，读取含动态跨站 iframe 的网页材料。
不提供私有评分、fixture 源码或其他 Agent 的结果。这是上下文和流程隔离，
不是强进程或文件访问隔离；独立性仍须核原始指令与调用记录。

业务预算从首次实际 task-URL 调用起为 900 秒，清理另有 60 秒；读文档与连接
准备有独立 180 秒观察上限。`start-N.json` 和终态文件均使用 `Date.now()`
安全整数，不能从文件时间推算实际开始。文件协议只表示里程碑，不证明 solver 存活。
每轮 finalize、SDK 连接关闭和日志封存后才写终态；仅正向 ACK 允许下一轮。
原始日志、失败和 pending 状态保留，不隐藏重试或重放提交。

## 原始运行与证据

最终六阶段覆盖输入冻结、正式启动、两轮独立解题交付、两报告共同查看和正式 Stop。
原回执及报告 DOM 通过比较、来源链接与唯一提交检查。独审核实 12 份当前来源的
实际 ariaSnapshot、257 次公开调用和两份报告；业务分别为 55.998、58.014 秒，
从最后业务返回至收到封存终态的保守清理上界为 114、103 毫秒，符合 900/60 秒预算。
日志封存包含原字节副本和树摘要；两轮没有直接操作旧页的 receiver。

独审保留 7,356 项机械核对中的 7,355 项通过及 1 项原失败：过严的
`unexpectedRequests=[]` 断言遇到唯一 `GET /favicon.ico`，冻结路由实际返回 404。
已按原请求分类为无关图标请求，无未解决验收失败；不能称该数组为空或全部原断言通过。

查看器先逐份选择结果，再复核两份原 document/delivery 并再次观看；最终页面清单
是原浏览器页加两份报告，不能为满足断言而关闭用户原页。根代理已目视 4 张原生 PNG
和 2 张最终查看器截图，能确认顶部摘要与实际显示；截图没有展示整张比较表，表格
内容依赖另存的原 DOM/receipt，不能用顶部画面冒充完整目视验收。

原 Browser 与 Native 均退出 0，Job 实际成员为 0，`forced:false`；29 个原进程
身份最终均消失，清理错误与存活 runner 子进程均为空。原生 created/removed/
activated/window-focus 账本核对页生命周期，观察区间无新增激活或窗口焦点事件。
只读 OS 采样不证明采样间系统鼠标从未移动，也不能仅按前台 PID 推断输入原因。

| 记录 | SHA-256 |
| --- | --- |
| `.tmp/browser-integration/mra-Ldr4sE/results.json` | `7ae013bf7efb2acd165f48307b95a9ce182f9f9dd08530a7381a66559e2689e2` |
| `.tmp/mra-input-bsl0c56k/preflight.json` | `c1ae965e00687cce94974c4e17ff0e19ffcc52abd36d6252e30fe61987fd851a` |
| `.tmp/mra-check-3u2k4jol/tests.tap`（67/67，无跳过） | `2dfea061b3b21a313b670eea9b6a2296b9efe587c517e67ce204eedfcee86d58` |
| `.tmp/managed-agent-research-audit-20261023/mra-Ldr4sE/independent-audit.json` | `c5bc0c39fbc4576fc51670ac58de93cd5c516b7f1aa5292f70c06475e006193d` |

preflight 绑定原冻结构建 `mob-build-6u_o0xn0`、474 个生产输入及 351 个复用输入，
并核主机、扩展、SDK 与独立 observer 来源。runner 自身仍保留 supplied host
来源未验证的标签，不把外部 preflight 改写成 runner 内建证明。生产代码没有变化；
沿用冻结构建及其既有 Go 结果，本轮验收没有重跑完整生产 Go/Node 测试。
用户随后要求重新打包，制品交付另行核验，不将重新打包算作网页业务重跑。
67 项是本轮定向脚手架检查。实际 Node REPL 无连接 factory smoke 留在
`mra-preparation-pTRX5a`，它不算网页验收。

## 保留的失败与范围

- `mra-LmbD4b`：准备阶段记录器依赖不存在的全局 `process`，失败终态又带入
  小数文件时间而被协议拒绝；业务尚未开始。原失败不改为通过。记录器改用显式
  `node:perf_hooks` 单调时钟，协议明确整数时间，并加入缺失宿主全局的回归。
- `mra-3PcTYH`：两轮业务及各自交付阶段通过，联合 viewer 断言错误地要求清单
  仅含两份报告，遗漏应保留的原 blank 页，因此整轮失败。修正检查为原页面加
  两个精确结果，不关闭原页或放宽报告身份；原失败记录继续保留。

本片只覆盖固定 Windows、CfT 156.0.8078.12 和有限本地采购研究任务。未与当前
Codex 在同一材料上比速，不证明任意网站研究质量、普通公司 Edge、真实 SSO/MFA、
浏览器进程重启后的任务恢复或完整 P01–P15 持平。两份报告在正式 Stop 前交付保留；
Stop 仍会关闭浏览器，不代表页面跨进程持久恢复。整体能力目标继续开放。
