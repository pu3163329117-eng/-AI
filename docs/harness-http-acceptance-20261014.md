# Harness Bridge 本机 HTTP 模拟验收

日期：2026-10-14。结果：通过。模式：`mock`；真实模型调用保持关闭。

本轮按用户要求正常重启 `127.0.0.1:8000` 后端并加载协作接口。关闭原进程前核对了命令行、监听端口及控制台成员；仅向该后端独占控制台发送 Ctrl+C，未强制结束现有服务。3080 的 PID 19768 全程保留。验收器持有的 8000 子进程正常退出时，日志明确记录 `Application shutdown complete`。

## 实际 HTTP 结果

在正式本机 8000 上创建的合成任务：`409dda81-b743-4b21-aaf8-7b7ddc470c50`。

| 操作 | 实际结果 |
| --- | --- |
| 创建任务及 manifest v1 | HTTP 201，来源分类 synthetic |
| 明确创建 run | HTTP 201；目标 run 经 RUNNING 到 WAITING_REVIEW |
| 执行中追加追问 | HTTP 202，追问先保持 QUEUED，随后完成；同任务 session 和 parent run 绑定正确 |
| 读取结果与 handoff | 返回 synthetic CANDIDATE，包含对应输入 manifest 和审计 |
| 重复提交同一追问 | HTTP 200，返回原追问/run，不创建新记录 |
| SSE 游标读取 | `Last-Event-ID` 只返回更大的序号，不重发执行 |
| 排队取消 | HTTP 200，CANCELLED，未进入执行 |
| 运行中取消 | HTTP 200，最终 CANCELLED，未生成候选 artifact |
| 正常停止与重启 8000 | handoff 前后完全一致；同幂等键恢复 run 和追问，无新增 run |
| 无令牌/非法 Origin | 分别 HTTP 401 / 403，未创建任务 |

主任务的首次 run 为 `087cbe45-bae3-492a-9496-9656e8df0774`，追问 run 为 `c32621e0-5512-4caf-a3b5-a3c3e9967a86`。本轮协作库留有两组明确标为合成验收的数据（首次收尾辅助进程判定失败的记录也保留）；它们不涉及学习记录。

## 异常退出恢复

异常退出测试只作用于验收器自己创建的 8001 子进程，协作库保存在 `output/harness-http-acceptance-20261014`，学习库使用内存数据库。先通过 HTTP 确认首个 run 已 RUNNING 且获得 mock 入队回执，再排入追问，然后对这个测试子进程注入强制退出并以相同测试库重启。

结果：首个 run `3e13808d-c457-4c5d-9baa-a4130e16fe16` 恢复为 `OUTCOME_UNKNOWN / BRIDGE_RESTARTED_AFTER_DISPATCH`，没有候选结果且只有一次 `run.started`；排队追问恢复为 `WAITING_REVIEW`。重提原幂等键返回原 OUTCOME_UNKNOWN，没有自动重发。8001 随后正常关闭，8000 保持可用。

Windows Ctrl+C 的控制事件异步送达：首次收尾时辅助进程的退出码被误判为服务关闭失败，而后端日志已确认正常关闭。辅助进程现会等待信号送达，并用后端退出及 shutdown 日志核验成功；复跑得到完整 PASS 报告。

## 数据与修复

重启前使用 SQLite backup API 创建本机一致性备份 `output/backups/wenyan-before-harness-http-20261014.db`。重启和模拟验收后，25 张学习库表的行数及完整行指纹全部一致，`missing_or_changed` 全为 0，`integrity_check=ok`。

核对接口时修复了追问幂等恢复重新选父 run 的问题，并将 API/worker 事务及审计序号分配串行化；取消发生在 claim 与适配器启动之间时也会保留取消标志。专项测试新增并发同键追问去重和取消窗口两项，共 14 项通过。

原始结果见本机 `output/harness-http-acceptance-20261014/acceptance.json`，日志同目录。报告不保存令牌、模型密钥或学习正文。服务令牌由验收 supervisor 生成，仅保留在 supervisor/后端进程内存；当前 mock 每步延迟 0.4 秒，用于稳定观测 RUNNING 与取消窗口。以后手动重启可自行设置进程环境令牌，或运行所附验收器。

仍未执行真实 Harness 合成联调、真实付费调用或外部资料发送。操作系统级强沙箱与真实厂商事件/费用验收仍在原待确认范围。
