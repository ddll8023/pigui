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

1. 借用这台电脑已安装的 pi 的 SDK（见下“依赖解析”）；
2. 以当前目录为 `cwd` 起一个本地服务（端口由系统自动分配）；
3. **新建一个会话**（默认不碰该目录里已有的历史会话）；
4. 调 `orca tab create --url http://127.0.0.1:<port>/ --worktree active`，在本 worktree 打开页签。

停止：在该终端按 `Ctrl+C`。

## 参数

| 参数 | 说明 |
|---|---|
| `--no-open` | 只起服务并打印地址，不调 orca 开页签 |
| `--port <n>` | 指定端口（默认系统自动分配） |
| `--new` | 新建会话（默认行为） |
| `--continue` | 恢复该目录最近一次会话（可能正被 Orca / pi 使用，慎用） |
| `--session <path>` | 打开指定的会话文件（优先于 `--new` / `--continue`） |
| `-h`, `--help` | 显示帮助 |

## 页面内命令

在页面输入框里输入以下命令（回车执行，只在本页处理，**不会发给模型**）：

| 命令 | 作用 |
|---|---|
| `/resume` | 打开会话选择器：`↑`/`↓` 移动、`Enter` 切换、`Esc` 关闭，也可以直接点条目 |
| `/model` | 打开模型浮层：搜索并切换模型、调整思考等级（详见下节）；也可以写 `/model claude` 把搜索词预填进去 |
| `/new` | 新建会话（与顶栏“新建会话”按钮相同） |

打一个 `/` 就会出现命令提示条：`↑`/`↓` 移动、`Enter` 或 `Tab` 直接执行，也可以直接用鼠标点；继续输入会按前缀过滤（例如只打 `/re` 就只剩 `/resume`）。输入框失焦或不再以 `/` 开头时提示自动收起。

只有列在命令表里、且完全匹配（`/model` 带参数时首个词匹配）的输入会被当作命令；`/usr/local/bin` 这类以 `/` 开头的普通文本仍会照常发送。

## 模型与思考等级

在输入框执行 `/model` 打开浮层：

| 操作 | 作用 |
|---|---|
| 输入文字 | 按 `provider` / 模型 id / 名称子串过滤（忽略大小写） |
| `↑` / `↓` 或点击 | 选择模型（`●` 标记当前模型，“默认”标记全局默认模型） |
| `Enter` | 切换当前会话的模型 |
| `Ctrl+Enter` | 切换模型并写入**全局默认模型**（相当于 pi 里的“设为默认”） |
| `←` / `→` 或点击等级胶囊 | 调整当前会话的思考等级，立即生效（非思考模型只显示 `off`） |
| `Esc` / 点遮罩 | 关闭浮层，焦点回到输入框 |

行为说明：

- 可用模型列表来自本机已配鉴权的模型（`ModelRuntime.getAvailableSnapshot()`），没登录过的 provider 不会出现；列表为空时页面会直接提示。
- 默认只改当前会话（pi 的 `setModel(model, { persist: false })`），会往当前会话 JSONL 里追加一条 `model_change` 记录，**不会**动全局默认模型；只有 `Ctrl+Enter` 才写全局默认。
- 思考等级只改当前会话，不写全局默认；服务端会按当前模型能力收敛到支持的等级，顶栏元信息里会同步显示当前等级。
- 运行中（回合未结束）也可以切换模型：新模型从下一次模型请求开始生效，正在进行的那一次请求不受影响。

## 跳转与导航

- 顶栏「目录」按钮：列出本会话的**每条用户提问**（序号 + 首段摘要），`↑`/`↓` 选择、`Enter` 跳转、`Esc` 关闭，也可直接点；跳到的行会闪一下高亮。
- 消息区右侧的两个圆形按钮：往上滚离开底部时出现「↓ 最新」，往下滚离开顶部时出现「↑ 顶部」，点击平滑滚动过去。

## 正文渲染

助手输出按以下 Markdown 子集渲染，全部用 DOM API 构建（不解析 HTML，模型输出里的标签会原样显示为文本）：

- 标题 `#`～`######`、分隔线、段落（段落内单换行保留）
- 行内：`**粗体**`、`*斜体*`、`~~删除线~~`、行内码、`[链接](https://…)`、`![图片](https://…)`（仅 http/https）、反斜杠转义
- 列表：无序 / 有序（支持 `start`，如从 `3.` 开始）、嵌套（按缩进递归）、任务列表 `- [ ]` / `- [x]`
- 引用 `>`（内部同样按块级渲染）
- 围栏代码块：语言标签、复制按钮、`js/ts/json/py/bash/html/css/md` 轻量着色
- 表格：`|` 表格 + 分隔行，支持 `:---:` 对齐，宽表横向滚动

## 工具调用与输出

- 执行记录：同一条助手消息里**相邻的工具调用合成一个「执行记录」面板**，每条记录包含工具名、参数摘要（压成一行、超长省略号，悬停或展开看全文）、状态标记和输出；调用与输出按 `toolCallId` 归属到同一条记录。
- 状态标记：等待结果 / 运行中 / 完成 / 失败 / 未确认。`toolCall` 块本身不代表成功，状态只依据 `tool_execution_end.isError` 或工具结果的 `isError`；两者都缺失时标「未确认」，不显示「完成」。
- 输出：默认折叠，**失败时默认展开一次**（之后不再覆盖你手动折叠的选择）；标签为 `输出 · N 行 · M 字节`，内容为等宽纯文本（不着色，最高 400px，超出面板内部滚动）。
- 无法归属的结果：工具结果没有匹配到调用 ID 时**单独保留**（不按工具名猜配），仍可展开查看输出。
- 工具执行过程中的增量输出默认不转发，设 `PIGUI_DEBUG=1` 才发。

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
| GET | `/api/models` | `{current, default, models, thinkingLevel, thinkingLevels}`；`models` 为本机已配鉴权的可用模型（裁剪后的 `provider/id/name/reasoning/contextWindow/input`，当前模型置顶） |
| GET | `/api/messages` | 当前会话的消息（`{role, text, blocks}`） |
| GET | `/api/sessions` | 该目录的会话列表 |
| GET | `/api/events` | SSE 事件流，连接时先补 `session` 与 `history` 两帧；新建 / 切换会话后也会广播 `session` + `history` |
| POST | `/api/prompt` | `{message}`；运行中会自动改为 steer |
| POST | `/api/steer` | `{message}`；强制 steer |
| POST | `/api/abort` | 中止当前回合 |
| POST | `/api/model` | `{provider, id, persist?}`；切换模型（默认只改本会话，`persist: true` 同时写全局默认）；不在可用列表内 404，未配鉴权 400 |
| POST | `/api/thinking` | `{level}`；切换本会话思考等级（只接受 `off/minimal/low/medium/high/xhigh/max`，按模型能力收敛） |
| POST | `/api/new` | 新建会话（旧的会被释放） |
| POST | `/api/switch` | `{sessionFile}`；切换到该目录下的某个会话（不属于该目录则 404） |
| POST | `/api/shutdown` | 关闭服务 |

SSE 帧类型：`session`（上下文/模型/模型名/思考等级/busy；切换模型与思考等级后也会广播）、`history`（历史消息；长会话会按 `part`/`parts` 分片，`part` 为 0 时页面清空重绘）、`delta`（助手文本增量）、`thinking`（思考增量）、`message`（完成的消息）、`event`（其它 pi 事件，带 `type` 与少量细节，含 `toolCallId`、`thinking_level_changed` 的 `level`；单帧过大时降级为 `frame_truncated`）、`error`。

单个内容块文本超过 48 KB 会被截断并标记 `truncated: true`（避免几 MB 的工具输出把整帧撑爆）。

**消息结构**：`{ role, text, blocks }`。`blocks` 是内容块数组，块类型有 `thinking`、`text`、`toolCall`（带 `name`、`arguments`、`toolCallId`）、`toolResult`（带 `toolCallId`）；`text` 是全部块拼成的纯文本，供简单渲染使用。`role` 为 `toolResult` 的消息额外带消息级字段 `toolCallId`、`toolName` 与 `isError`（页面据此把输出归到对应调用并显示失败标记）。

默认不转发 `tool_execution_update`、`message_start`、`turn_start` 这类高频/噪声事件；设 `PIGUI_DEBUG=1` 可拿到全部事件（并额外输出调试日志）。

## 会话目录与并发注意

会话默认存在 pi 的共享目录 `~/.pi/agent/sessions/--<编码后的 cwd>--/`，与 pi / Orca 是同一份，所以能在页面里续上该目录的历史会话。

**默认行为**：`pigui` 每次都会新建会话，不会去碰该目录里已有的历史会话（早先默认的“恢复最近会话”曾撞上 Orca 正在使用的会话文件；两个进程同时写同一个 JSONL 会互相干扰，因此改为默认新建）。

页面里的 `/resume` 走的是同一条路径（切换到列表里的某个会话），选之前同样要确认那个会话没有被别处打开。

需要接续旧会话时：

- 恢复该目录最近写入的会话：`pigui --continue`，使用前确认它没有在 Orca / pi 里同时打开；
- 打开某个确定的会话文件：`pigui --session <该会话文件路径>`。

## 卸载

```bash
npm uninstall -g pi-extensions
```
