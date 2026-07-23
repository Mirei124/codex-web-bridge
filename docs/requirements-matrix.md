# 需求验收矩阵

本文件用于驱动“实现 → 测试 → 评审 → 缺口审计 → 继续迭代”的循环。只有必需项均有自动化测试或真实冒烟证据后，项目目标才算完成。

| 编号 | 必需能力 | 验收证据 | 状态 |
| --- | --- | --- | --- |
| CLI-01 | CLI 提供 start、stop、restart、status | `cli.integration.test.ts` 在允许回环监听的环境通过 | 通过 |
| CLI-02 | start 后 daemon 脱离终端持续运行 | CLI 集成测试覆盖 detached daemon 与 readiness marker并通过 | 通过 |
| CLI-03 | 重复 start/stop 幂等且不会误杀其他进程 | PID marker、`/proc` 身份校验及 CLI 集成测试 | 通过 |
| CLI-04 | Web 支持的主机、线程、消息、请求和终端操作均可由 CLI 完成 | `cli-command.test.ts` 命令矩阵、`control.test.ts` 业务映射 | 通过 |
| CLI-05 | 面向 LLM 提供稳定 JSON/JSONL、stderr 错误和退出码 | CLI parser/client 单测及构建后集成测试 | 通过 |
| CLI-06 | CLI 使用私有本机控制通道，不需要 Web 密码且不削弱 Web 认证与传输边界 | Unix Socket `0600`、目录 `0700`、origin/代理边界和活 socket 保护测试 | 通过 |
| CLI-07 | wait/watch 不丢失初始化窗口事件，Plan 问题和审批可结构化解决 | 订阅竞态、多问题 answers 和 approval 控制通道测试 | 通过 |
| SEC-01 | daemon 默认仅监听回环地址，公网 HTTP 绑定必须显式接受风险 | 默认 `127.0.0.1`；`--accept-risk` 才配置 `0.0.0.0` | 通过 |
| SEC-02 | 直连请求服从配置 origin，伪造或不可信代理元数据在认证前被拒绝 | `server.test.ts` HTTP/HTTPS 边界测试 | 通过 |
| SEC-03 | 密码使用 Argon2id 哈希，Cookie 为 Secure、HttpOnly、SameSite=Strict | `auth.test.ts`、`server.test.ts` | 通过 |
| SEC-04 | WebSocket 校验传输模式、登录会话、Origin 与 CSRF/操作令牌 | 服务端握手实现；Dashboard CSRF URL/重连测试 | 通过（真实 Caddy E2E 待部署） |
| SEC-05 | SSH 固定主机指纹，不自动信任未知主机 | `runtime-manager.test.ts` OpenSSH SHA-256 指纹测试 | 通过 |
| HOST-01 | 支持配置和展示多台 A 主机 | Server API/SQLite 测试、`HostManager.test.tsx` | 通过 |
| HOST-02 | SSH 断线可重连，且不会终止远端 tmux | Runtime 退避重连测试；真实 SSH/tmux 基础链路冒烟 | 代码通过，网络断线待真实 A |
| THR-01 | 每个线程创建独立 tmux，会话含 app-server 与远程 TUI | `remote-runtime/test/runtime.test.ts` 命令契约 | 代码/模拟通过，待真实 A |
| THR-02 | 创建新 Codex 原生线程并保存 thread id 映射 | Codex client、Server fake runtime、SQLite 测试 | 代码/模拟通过，待真实 A |
| THR-03 | 发现并恢复 Codex 历史线程 | `thread/list` 客户端、历史线程 API 与 Dashboard 单测 | 代码/模拟通过，待真实 A |
| THR-04 | 退出只销毁运行实例，不删除或归档 Codex 历史 | Server exit 与 runtime stop 测试 | 代码/模拟通过，待真实 A |
| THR-05 | daemon 重启后重连仍存活的 tmux 和 app-server | 同端口恢复、现存 pane 发现与重连测试 | 代码/模拟通过，待真实 A |
| MSG-01 | 发送普通用户消息并流式展示回答 | Codex client、Server 投影、Dashboard 事件顺序测试 | 通过 |
| MSG-02 | 展示计划更新与步骤状态 | Server `turn/plan/updated` 投影与前端消息测试 | 通过 |
| MSG-03 | 展示并回答带选项或自由输入的用户问题 | Questions 请求/answers Dashboard 测试与 pending 存储 | 通过 |
| MSG-04 | 处理命令、文件修改和权限审批 | 三类 0.144.6 request 映射、原始 RPC 关联与响应实现 | 代码/模拟通过，待真实 Codex 审批 |
| MSG-05 | 中断当前轮次 | Client/Server 路由及 Dashboard 操作测试 | 通过 |
| MSG-06 | 待处理交互在浏览器重连后仍可见且不可重复解决 | SQLite pending、snapshot 与 resolve-after-RPC 逻辑 | 通过 |
| TERM-01 | pipe-pane ANSI 流经 SSH 和 WebSocket 到浏览器 xterm | Fake SSH 字节流、UTF-8 ANSI Dashboard 测试 | 代码/模拟通过，待真实 A |
| TERM-02 | 新连接用 capture-pane 正确获得当前屏幕 | Runtime capture seed 与 Dashboard snapshot 测试 | 代码/模拟通过，待真实 A |
| TERM-03 | 默认只读，仅一个明确接管者可写入 | Server lease、断连释放与 Dashboard 只读测试 | 通过 |
| TERM-04 | 接管输入通过 tmux send-keys/paste-buffer，结构化输入仍走 RPC | Runtime 命令契约和 Server 路由测试 | 代码/模拟通过，待真实 A |
| SHOT-01 | 按需将当前 pane 用临时 xterm-headless 渲染为 PNG | `TerminalSnapshotRenderer` PNG 单测 | 通过 |
| SHOT-02 | 空闲时不轮询渲染，尺寸与资源有硬上限 | 按请求渲染；行列 clamp 单测 | 通过 |
| UI-01 | 登录、主机列表、线程列表、会话详情可用 | React Testing Library 单测；Playwright 场景已记录但未运行 | 单元通过，待真实 E2E |
| UI-02 | 创建、恢复、退出、中断和审批操作可用 | `App.test.tsx`、`HostManager.test.tsx`；Playwright 未运行 | 单元通过，待真实 E2E |
| OPS-01 | 提供 Caddy 与 systemd 示例及部署说明 | `deploy/` 示例与 README 操作步骤 | 通过（未在目标 B 验证） |
| COMP-01 | 固定支持的 Codex 版本并对生成协议执行契约检查 | 0.144.6 映射；`app-server.smoke.test.ts` 已真实执行通过 | 通过 |

## 完成门槛

1. 所有必需项状态为“通过”或有用户明确接受的限制。
2. 全量构建、单元测试、集成测试和浏览器端到端测试通过。
3. 独立评审代理没有未解决的阻塞级或高严重度问题。
4. 在具备 SSH、tmux 和 Codex 的环境完成一次真实纵向冒烟，并记录命令与结果。
5. 从干净环境按照文档可以启动 daemon 并打开 dashboard。

## 当前证据边界

- 当前环境已通过全量 TypeScript 类型检查、生产构建、单元/模拟集成测试和 CLI daemon 回环集成测试。
- 已真实执行 Codex CLI 0.144.6 `initialize → initialized → thread/list` 协议冒烟。
- 已用一次性本机 sshd 真实执行 `SSH → tmux → Codex app-server → SSH 端口转发 → thread/list → 清理` 纵向冒烟。
- 尚未提供独立机器 A，因此首次真实模型 turn、审批、物理网络断线恢复及实际 Caddy 证书仍需部署验收。
- `apps/web/e2e/SCENARIOS.md` 是待执行清单，不等同于已通过的 Playwright 证据。
