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

3份新runner文件语法及7文件联合60项定向检查通过；ledger/server另有9项本地
HTTP检查通过，两份独立代码审查无阻断。源文件前后摘要一致；这些都是准备证据，
正式四次任务尚未运行。已验证当前Codex隐藏空白页生命周期和本地原记录保存能力，
不把准备检查算入业务成功。固定四次首次顺序为OBU1、Codex1、Codex2、OBU2。

用户要求的新包已另行完成交付，此处比较准备未进入该包；本轮不再次发布。
旧24次比较、既有managed研究结果及原失败保持各自分母，完整目标继续开放。

### Files Modified

- `scripts/browser-integration/managed-paired-research-{check,support,support.test}.mjs`
- `scripts/browser-integration/research-request-ledger{,.test}.mjs`
- `scripts/browser-integration/research-workflow-server{,.test}.mjs`
- `scripts/browser-integration/README.md` 与本片 execution plan
