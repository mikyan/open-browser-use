# P15：正式 managed 与当前 Codex 的同材料研究

## 目标与基线

上一片为 progress：`928f217` 已提交已有持久合成登录的崩溃接续验收，
原失败与新写 cookie 丢失边界保留。本片不继续扩展 cookie 组合。
目标是在正式产品入口完成两轮同材料研究比较，记录全部四次首次尝试。

旧24次结果中的 OBU 使用测试 Native Port adapter；正式 managed 两轮研究
`mra-Ldr4sE` 没有当前 Codex 的同材料对照。二者不能拼成正式入口已对齐。
本片只推进 P15 的研究任务，动态表单、上传下载、诊断等完整范围仍保持原要求。

## 固定范围

- 用已有 `research-workflow-server.mjs --paired-comparison` 生成两轮材料。
  同轮双方不同任务 key/账本、相同事实 nonce，第二轮材料不同；独立事后核验。
- 固定首次顺序：OBU1 → Codex1 → Codex2 → OBU2，共4次，不重选任务抹去失败。
- OBU 使用正式 managed run/status/stop、实际 Native host、公开 SDK和查看器；
  新单次 runner 只接外部 ready，保留原已通过的两任务 runner 与断言。
- Codex 使用当次正式 Browser Use 工具返回的 API，不用宿主 Playwright/CDP
  替代业务能力。工具不支持的能力记录原 unsupported/error，不补造接口。
- 双方 solver 不继承审计/fixture 私有上下文，只得公开任务书、本人任务URL
  与接口资料。不能读源码 oracle、管理账本或对方答案；记录实际工具调用。
- 每次准备180秒、业务900秒、清理60秒。业务自首次任务URL/业务调用取早开始，
  包含思考与工具往返；清理不能补解题/提交。文件里程碑不证明 solver 存活。
- root 独占本地测试 Browser/fixture server 进程启动。Codex solver 的正式工具
  仅创建/操作隐藏任务页；不调用系统鼠标键盘或个人 profile，不删除用户页。

## 业务与验证

共同任务：为团队比较12台扩展坞，读取三家当前报价和条款，排除旧摘要；
核预算、到货、PD、网速、保修，计算含运费总价，列全部适用理由和六条当前
来源，选最低价合规项或无合规项，只保存一次报告，读报告并保留结果页，
关闭本任务其他资料页，保留全部初始页面。

完整公开 trace 与页面 DOM证明真实读取和交互；最终服务器原账本证明唯一
POST及原body/响应/报告一致。runner 不代读资料或提交答案。server 正常停止
并封存后才能完成最终业务审计，不能用早期快照排除晚到重复提交。

OBU 核原 Browser/Native/supervisor退出、Job0、精确进程身份、注册项/pipe/
endpoint、实际viewer解码及原生tab/focus事件。Codex只记录正式工具可取得的
库存、DOM和截图，缺少对等OS观察明确写未观测。OS样本不证明连续鼠标静止。
成功率、业务wall、API次数与清理分开，不将两轮少量任务推成速度或整体持平。

所有首次失败/timeout/unsupported/blocked-environment/contaminated 保留。
旧24条、mra结果、三项crash失败及普通公司Edge待人工验收均不改写。
本片生产输入可复用已验证hpfufae_，新runner按实际源快照单独冻结；不称全量重测。

## 实施与状态

1. 新增单次 managed 配对 runner/support/定向测试，复用现有正式生命周期helper；
   不增加Pi适配或通用框架，不改旧两任务门槛。
2. 严格校验ready四槽、同origin/variant/pair/独立任务、公开card边界、封存/终态
   与唯一报告；定向测试和独立审阅后冻结所有生产/integration输入。
3. root预登记四槽及源/制品/预算，持有server原stdin句柄，依固定顺序运行。
4. 全部尝试与清理终结后正常stop server，独审原trace/账本/结果/资源并留摘要。
5. 根据真实差距改产品、再做必要验证；不能只凭测试设施完成把P15标为完成。

执行前准备：3个新文件已冻结，语法检查及7文件联合60项定向检查通过；其中server/ledger
的9项本地HTTP检查也另行通过，两项独立审查无阻断。当时尚未启动本片server或浏览器，
四槽尚未执行。用户再次要求的新包已从已验证的`928f217`独立构建并交付，
`23a42ad`记录原制品与回下载核验。本片准备没有进入该包；现在继续正式比较，
不再次打包。上一轮交付改变了实际发布状态，判为progress，完整目标保持active。

准备核查：root 已通过当前正式 CUA/IAB 工具创建隐藏 about:blank、读取AX、
关闭并核空库存；只证明本次root任务外接口可用，不算任何slot通过或替代solver
自己的连接与业务证据。现成paired服务器的allowlist外404缺少请求记录，
已补独立有界全请求method/URL/status/finish账本，正常stop后封存；不改材料
和公开任务。原fixture账本继续保留完整业务body与回执，新增账本补全部路由
覆盖，溢出或写失败必须显式失败。三文件单次runner与该小修分别由代理完成，
最终业务/配对顺序/全部POST审计须待四次正式尝试及服务器真实终结后进行。
当前CUA的本地证据exclusive写入与SHA计算已实测可用；solver仍须在自己的
持续turn中保存原API调用/返回、UTC及截图bytes，不继承root或其他solver答案。


## 四次原始尝试终结

四槽已依固定顺序执行，原服务器实际 exit 0 并封存82条完整HTTP记录。
OBU第1槽exit0；第4槽因终态额外firstLocalError字段触发严格schema而exit1，
其后置真实viewer未到达，原错误和negative ACK保留。两槽失败/正常路径
的实际Stop、原进程身份与资源清理独审通过，源输入未变。Codex两槽均封存，
第一槽准备起点/阶段标签/firstError引用缺陷与三个API错误保留。
详见[原始结果与证据边界](../../references/managed-paired-research.md)。
依据已收口的业务独审决定下一步；不重跑当前任务或删除错误，也不以四份报告
替代完整P15。生产与已交付包相同，本轮不另发包，完整目标保持active。

最终业务/原始时序审计已完成：业务4/4、严格协议2/4，结果独立归档。
本片没有发现需要改生产实现的业务错误；下一步优先将旧adapter覆盖的动态
表单、上传下载和诊断任务移到正式managed入口，不继续堆同布局研究次数。
第4槽未来验收应使用原七字段终态、错误另存；当前失败及缺失viewer证据不变。
