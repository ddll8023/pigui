# pigui

为当前工作目录打开 **pi 的网页对话界面**：一条命令起本地服务，并让 Orca 用它自己的浏览器页签打开页面。

它在哪台机器、哪个 worktree 里运行，页面就是那个工作区——不需要在页面里选目录，也不管理目录结构。

## 安装（跨机器）

```bash
npm i -g github:ddll8023/pi-extensions
```

npm 会生成 `pigui` / `pigui.cmd` / `pigui.ps1` 三个入口，之后在任意目录可直接执行 `pigui`。

> 这是**独立的命令行工具**，不是 pi 扩展：`pigui/` 里没有 `index.ts`，所以不会被打包根 `package.json` 的 `pi.extensions`（`./*/index.ts`）加载。

## 用法

在 Orca 的某个 worktree 终端里：

```bash
cd D:\path\to\your\worktree
pigui
```

它会：

1. 借用这台电脑已安装的 pi 的 SDK（见下"依赖解析"）；
2. 以当前目录为 `cwd` 起一个本地服务（端口由系统自动分配）；
3. 调 `orca tab create --url http://127.0.0.1:<port>/ --worktree active`，在本 worktree 打开页签。

停止：在该终端按 `Ctrl+C`。

## 参数

| 参数 | 说明 |
|---|---|
| `--no-open` | 只起服务并打印地址，不调 orca 开页签 |
| `--port <n>` | 指定端口（默认系统自动分配） |
| `--new` | 新建会话（默认恢复该目录最近一次会话） |
| `--session <path>` | 打开指定的会话文件 |
| `-h`, `--help` | 显示帮助 |

## 环境变量

| 变量 | 说明 |
|---|---|
| `PIGUI_PI_SDK` | 手动指定 pi 包目录（或 `dist/index.js` 路径） |
| `PI_AGENT_DIR` | 覆盖 pi 配置目录，默认 `~/.pi/agent` |

## 依赖解析

pi 的 SDK **不写进 package.json**，而是借用本机已装的 pi，依次尝试：

1. `PIGUI_PI_SDK`
2. `PI_MANAGED_INSTALL_ROOT` 对应的 managed 安装
3. `~/.pi/agent/install/current-version` 指向的版本
4. `npm root -g` 下的 `@earendil-works/pi-coding-agent`
5. `where pi` / `which -a pi` 找到的可执行文件（自动识别官方 launcher 与 npm shim）
6. 当前项目的 `node_modules`

都找不到时会报错并提示先安装 pi（或设置 `PIGUI_PI_SDK`）。这样做的好处：不额外下载，且 SDK 版本与你实际使用的 pi 始终一致。

## HTTP 接口

服务只监听 `127.0.0.1`，**无鉴权**（与在本机跑 TUI 等价）。页面可替换，只需照下面的约定调用。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/` | 页面（`index.html`） |
| GET | `/api/context` | 当前上下文 + 该目录最近 30 个会话列表 |
| GET | `/api/messages` | 当前会话的消息（`{role, text, blocks}`） |
| GET | `/api/sessions` | 该目录的会话列表 |
| GET | `/api/events` | SSE 事件流，连接时先补 `session` 与 `history` 两帧 |
| POST | `/api/prompt` | `{message}`；运行中会自动改为 steer |
| POST | `/api/steer` | `{message}`；强制 steer |
| POST | `/api/abort` | 中止当前回合 |
| POST | `/api/new` | 新建会话（旧的会被释放） |
| POST | `/api/shutdown` | 关闭服务 |

SSE 帧类型：`session`（上下文/模型/busy）、`history`（历史消息）、`delta`（助手文本增量）、`thinking`（思考增量）、`message`（完成的消息）、`event`（其它 pi 事件，带 `type` 与少量细节，含 `toolCallId`）、`error`。

**消息结构**：`{ role, text, blocks }`。`blocks` 是内容块数组，块类型有 `thinking`、`text`、`toolCall`（带 `name`、`arguments`）、`toolResult`（带 `toolCallId`，便于折到对应调用下面）；`text` 是全部块拼成的纯文本，供简单渲染使用。

默认不转发 `tool_execution_update`、`message_start`、`turn_start` 这类高频/噪声事件；设 `PIGUI_DEBUG=1` 可拿到全部事件（并额外输出调试日志）。

## 会话目录与并发注意

会话默认存在 pi 的共享目录 `~/.pi/agent/sessions/--<编码后的 cwd>--/`，与 pi / Orca 是同一份，所以能在页面里续上该目录的历史会话。

**风险**：默认的"恢复最近会话"很可能指向 Orca 里正在使用的那个会话文件。两个进程同时写同一个 JSONL 会互相干扰。建议：

- 想和 Orca 里的对话完全分开：用 `pigui --new`；
- 想在 pigui 里继续某个历史会话：用 `pigui --session <该会话文件路径>`，并确保它没有在别处同时打开。

## 卸载

```bash
npm uninstall -g pi-extensions
```
