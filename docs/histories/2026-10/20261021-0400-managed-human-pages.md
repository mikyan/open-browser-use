# 2026-10-21 | 人工新页面选择与原页返回

## 用户诉求和范围

持续推进 Browser Use 能力对齐，使用用户 fork，不新增 Pi 适配、不提 PR。
此前明确请求的新包已交付为 preview-20261021-5b3d2f4；本轮继续开发人工
接管中新窗口的接续，不自动重发包。公司 Edge 人工验收继续延期。

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

尚未发布本功能；iframe 发起开页、父页回调导航、子页关闭回传、复杂 SSO、
公司 Edge 和完整能力对齐仍开放，本片计划保持 active。
