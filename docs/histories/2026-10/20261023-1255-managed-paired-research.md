## 2026-10-23 | Task: 正式 managed 与当前 Codex 同材料研究比较

### User Query

持续开发，直到项目的 Browser Use 能力与 Codex 不相上下；仅推用户 fork，不提 PR。

### Changes Overview

新增单任务 managed 比较入口，使用外部 paired 服务器的原 ready 与四个固定任务，
保持旧两任务研究入口不变。独立 solver 只接自己的公开任务书与正式 SDK，使用
900秒业务及60秒清理预算，原API记录封存后再核原报告和真实查看器。原生生命周期、
资源和公开交付通过不等于业务比较成功，完整语义和全部POST须最终独立审查。

服务器新增有界的全路由HTTP账本，覆盖未知路径的404及请求/响应中止。正常停止
确认HTTP终结后封存，closed绑定原字节摘要；溢出、未终结或写盘错误明确失败。
不改变公开材料、ready契约、fixture原业务账本或生产功能。

3份新runner文件语法及7文件联合60项定向检查通过；其中ledger/server的9项本地
HTTP检查另行通过，两份独立代码审查无阻断。源文件前后摘要一致；这些都是准备证据，
准备提交时正式四次任务尚未运行。已验证当前Codex隐藏空白页生命周期和本地原记录保存能力，
不把准备检查算入业务成功。固定四次首次顺序为OBU1、Codex1、Codex2、OBU2。

用户要求的新包已另行完成交付，此处比较准备未进入该包；本轮不再次发布。
旧24次比较、既有managed研究结果及原失败保持各自分母，完整目标继续开放。

### Files Modified

- `scripts/browser-integration/managed-paired-research-{check,support,support.test}.mjs`
- `scripts/browser-integration/research-request-ledger{,.test}.mjs`
- `scripts/browser-integration/research-workflow-server{,.test}.mjs`
- `scripts/browser-integration/README.md` 与本片 execution plan


### 四次原始尝试与正常封存

四次已按OBU1、Codex1、Codex2、OBU2执行，原服务器正常stop且实际exit0。
全路由账本82请求全部正常响应，无未决/中止/溢出；各任务仅一份报告POST。
第1槽正式runner五阶段通过，第4槽原终态多出firstLocalError被严格schema
拒绝，实际exit1，后置报告DOM/真实viewer验收未执行。原SDK前本地初始化
错误、原报告和失败保留，不改字段或重跑转绿。Codex第1槽准备精确起点、
日志phase及firstError引用缺陷保留，三个API错误不删除。

两场OBU原进程、正式Stop、Job、注册项/pipe/endpoint及冻结来源独审通过；
第4槽清理成功不升级整项失败。原OS样本均无foreground事件，Codex没有
对等OS记录，不作连续鼠标/整体焦点推断。业务与完整验收分别归档于
[比较记录](../../references/managed-paired-research.md)。

安装包仍为preview-20261023-928f217，主ZIP原字节与远端digest再次核对一致。
HEAD其后只新增integration与docs，生产功能相同，无遗漏功能需要重包。
本轮收尾没有再次构建、启动浏览器或发布；旧24次分母和原失败不变，P15保持开放。

最终业务独审实际exit0：四槽六源实际读取、独立重算、原payload/回执和唯一
POST均通过，业务4/4、严格协议2/4分别保留。第1轮无合规方案，第2轮第三家
6558元最低。Codex原JPEG独立目视解码，原审计误判PNG的失败保留；第4槽
没有viewer帧，不补验为通过。精确时序/调用及摘要见脱敏索引。
