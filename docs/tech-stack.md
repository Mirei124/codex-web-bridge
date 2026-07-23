# 技术选型

## 结论

采用 TypeScript 全栈单仓库：

| 层 | 选择 | 用途 |
| --- | --- | --- |
| 运行时 | Node.js 22 | 与参考项目 botmux 一致，适合长连接、子进程和协议桥接 |
| 包管理 | pnpm workspace | 管理服务端、WebUI 和共享协议类型 |
| 服务端 | Fastify + TypeScript | 提供认证、REST API、WebSocket 与生命周期编排 |
| WebUI | React + Vite | 实现线程列表、对话流、计划选项和审批界面 |
| 浏览器实时通道 | WebSocket | 推送 Codex 事件、状态变化与断线补偿游标 |
| 本地状态 | SQLite + Drizzle ORM | 保存主机配置、线程映射、事件游标和登录会话 |
| SSH | ssh2 | 从 B 执行 A 上的 tmux 管理命令，并建立 TCP 转发 |
| 密码 | Argon2id | 保存单用户密码哈希 |
| 入口代理 | Caddy | 终止 TLS，并将 HTTPS/WSS 代理到回环监听的应用 |
| 测试 | Vitest + Playwright | 协议单测、SSH/tmux 集成测试和浏览器端到端测试 |

## 与 botmux 的关系

botmux 已验证以下工程判断，本项目直接沿用：

- Node.js/TypeScript 适合编排 CLI、tmux、WebSocket 与流式界面。
- 每个会话使用独立 tmux，可让管理进程重启而不终止 CLI。
- Codex 使用 app-server JSON-RPC 发送输入，比向 TUI 粘贴文本更可靠。
- Codex 原生线程编号与桥接系统自己的会话编号需要分别保存。
- 恢复时必须同时恢复结构化协议连接和对应的 Codex 线程。
- 实时通道必须处理重连、重复事件、请求超时与服务进程死亡。

不沿用 botmux 中与本项目无关的部分：飞书适配、多 CLI 适配、终端截图、无头 xterm 渲染、工作流引擎、桌面端和多机器人配置。

## Codex 接入选择

在 A 上，每个桥接线程创建一个 tmux 会话，tmux 中运行一个仅监听 A 回环地址的 Codex app-server：

```text
tmux session
└── codex app-server --listen ws://127.0.0.1:<线程端口>
```

B 通过 SSH 完成两类操作：

1. 执行幂等的 tmux 创建、检查和退出命令。
2. 将 app-server 的远端回环端口转发为 B 进程内的连接，再由服务端作为 JSON-RPC 客户端交互。

不直接把 app-server 暴露到 A 的局域网，也不让浏览器直接连接 A。浏览器只能连接 B，所有 Codex 请求都经过 B 的认证、授权和审计边界。

当前环境中的 Codex CLI 0.144.6 可以生成 TypeScript 协议类型，并确认存在以下所需接口：

- `thread/start`、`thread/resume`、`thread/list`；
- `turn/start`、`turn/interrupt`；
- 流式消息、计划更新和线程状态通知；
- 命令、文件、权限审批请求；
- `item/tool/requestUserInput` 及选项回答。

`codex app-server` 仍标记为实验功能，因此项目必须固定并记录支持的 Codex CLI 版本。构建或兼容性测试应从目标版本执行 `codex app-server generate-ts`，将生成类型作为协议适配层的输入；升级 Codex 时先跑协议契约测试，不能假设事件结构永久不变。

## 状态所有权

- Codex 原生会话记录：仅由 A 上的 Codex 管理，是历史内容的事实来源。
- tmux：仅表示当前运行实例是否存活。
- B 上的 SQLite：保存主机、桥接线程编号、Codex 线程编号、tmux 名称、状态投影、待处理交互和事件游标，不复制 Codex 凭据。
- 浏览器：只保存短期界面状态，不作为会话事实来源。

## 后端模块边界

```text
认证与 HTTPS 门禁
        │
HTTP / WebSocket API
        │
线程编排服务
   ├── SSH 连接池
   ├── tmux 生命周期
   ├── Codex JSON-RPC 客户端
   ├── 事件投影与待处理交互
   └── SQLite 存储
```

建议的仓库结构：

```text
codex-web-bridge/
├── apps/
│   ├── server/
│   └── web/
├── packages/
│   ├── protocol/       # 浏览器 API 与事件类型
│   ├── codex-client/   # app-server JSON-RPC 适配
│   └── test-support/   # 假 SSH、假 app-server
├── docs/
├── deploy/
│   ├── Caddyfile.example
│   └── systemd/
├── package.json
└── pnpm-workspace.yaml
```

`codex-client` 是必要的外部协议隔离层，不应把生成的 Codex 类型泄漏到 WebUI；WebUI 只依赖项目自己的稳定事件模型。

## 关键安全实现

1. 服务端监听 `127.0.0.1`，不监听公网网卡。
2. 在路由、静态资源和登录处理之前执行 HTTPS 门禁；仅接受来自已配置回环代理且 `X-Forwarded-Proto=https` 的请求。
3. 使用服务端登录会话、`HttpOnly`、`Secure`、`SameSite=Strict` Cookie；登录和敏感操作执行跨站请求伪造防护。
4. WebSocket 握手同时校验安全协议、登录会话和 `Origin`。
5. 登录失败统一响应并限速，不泄漏密码是否正确或系统是否已配置。
6. SSH 使用专用密钥、固定主机指纹和受限账户；禁止首次连接时自动信任未知主机。
7. 审批响应必须绑定主机、线程、轮次、请求编号和当前登录会话，已解决或过期请求不可重复执行。
8. 不在日志中记录密码、Cookie、SSH 私钥、Codex 凭据、完整用户输入或审批秘密字段。

## 暂不选择的方案

- 解析 tmux/TUI 文本：无法稳定表达结构化选项和审批，随 Codex 界面更新容易失效。
- 浏览器直接连接 A：扩大攻击面，并把 SSH/Codex 凭据问题推给浏览器。
- 在 A 部署自定义常驻代理：首版没有必要；SSH 与 tmux 已能完成管理和保活。
- PostgreSQL：单用户控制面使用 SQLite 足够，增加独立数据库只会提高部署成本。
- Next.js 等全栈框架：本项目核心是长连接和远程进程编排，独立 Fastify 服务边界更直接。

## 下一阶段

1. 固化 Codex 协议契约与本项目事件模型。
2. 定义 SQLite 表、REST API 和 WebSocket 消息。
3. 实现 SSH/tmux/app-server 最小闭环。
4. 实现密码认证与 HTTPS 门禁。
5. 实现线程列表、对话流、计划选项和审批 WebUI。
6. 增加断线恢复、安全与端到端测试。
