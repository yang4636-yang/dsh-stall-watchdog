# stall-watchdog · 环节超时自查

> 一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) 插件：监控每一次工具调用，超过设定时长仍未返回时，自动向模型注入一条自查提醒——让它主动判断是否卡住，而不是无限等待。

AI Agent 最常见的坏状态不是报错，而是**安静地卡住**：一条命令挂在那里等交互输入、一个下载不动了、一个构建跑进了死循环。用户看得见界面无响应，模型却毫不知情。stall-watchdog 补上这只表：单个工具调用超过阈值（默认 10 分钟）没返回，就在它结束后模型读到的第一条上下文里放一条自查提醒，附上工具名、已运行时长和排查清单。

## 功能

- **按工具调用计时**：挂在 DSH 的工具派发链上，每个调用独立计时；调用正常返回则什么都不发生，零开销。
- **提醒注入而非打断**：不中止、不取消正在跑的命令。提醒消息进入该会话下一个被采纳的 step——也就是长调用返回后模型第一时间读到的位置，由模型自己决定：中止换方案，还是向用户说明预计耗时。
- **设置界面直接调**：插件详情页内置配置卡，超时阈值（秒）、重复提醒间隔（秒）、最多提醒次数、排除工具、自定义文案，全部**改完即生效，无需重启**。
- **防误报**：`job_output`、`generate_image`、`generate_video` 这类本就该长跑的后台工具默认排除；嵌套子调用不重复计时。

## 安装

要求 DSH ≥ 0.2.0-rc.2（插件页配置卡依赖新版 `configForms`）。

**方式一：从 GitHub 安装**（推荐）

在 DSH 的 插件 页 → 添加插件，填入本仓库地址：

```text
https://github.com/OWNER/dsh-stall-watchdog
```

**方式二：本地目录安装**

```bash
git clone https://github.com/OWNER/dsh-stall-watchdog.git
cd dsh-stall-watchdog
npm install          # 装 @deepseek-ai/schemastery（本地目录安装走软链，必须有这一步）
```

然后在 插件 页 → 添加插件 填入本目录的绝对路径。

> 从 npm 安装（若发布）则无需 `npm install`，依赖会自动解析。

## 使用

装好后无需配置即可工作：任何工具调用超过 **600 秒** 未返回，模型就会收到一条类似下面的提醒（这条消息会显示在对话里，来源标记为 `plugin:stall-watchdog`）：

```text
[stall-watchdog] 工具调用 `pwsh` 已运行 10 分钟 仍未返回（阈值 10 分钟）。
请自查这一步是否真的卡住：
- 是否在等待交互输入（提示符 / 分页器 / 密码 / y-n 确认）；
- 是否卡在网络下载、构建、索引或死循环上；
- 是否应拆成更小步骤、加超时参数、或改用不阻塞的方式。
若确认卡住：中止该调用并换方案，不要让同一个调用无限等待。
若确属长耗时：把预计耗时与当前在等什么告诉用户。
```

**调整参数**：打开 插件 → stall-watchdog · 环节超时自查 → 配置卡，直接改：

| 设置项 | 默认 | 说明 |
|---|---|---|
| 启用监控 | 开 | 总开关，关闭后不再注入任何提醒 |
| 超时阈值（秒） | 600 | 单个工具调用超过这个时长仍未返回就提醒 |
| 重复提醒间隔（秒） | 0 | 同一调用一直不返回时每隔多久再催一次；0 = 只提醒一次 |
| 最多提醒次数 | 3 | 仅在重复间隔 > 0 时生效 |
| 不监控的工具 | job_output 等 | 每行一个工具名，避免后台类工具误报 |
| 自定义提醒文案 | 空 | 支持占位符 `{tool}` `{elapsed}` `{threshold}` `{attempt}` |

所有修改即时生效：值会写进你的 profile 配置层，插件的下一个工具调用就用新值计时，不用重启 DSH。

也可以在 profile 的 `cordis.patch.yml` 里直接改（配置卡写入的就是这里）：

```yaml
- id: stall-watchdog
  name: dsh-stall-watchdog
  config:
    stallSec: 300
    repeatSec: 120
```

## 工作原理

```text
工具调用开始 ──▶ 起一个 stallSec 的定时器
      │
      ├─ 调用在阈值内返回 ──▶ 拆表，什么都不发生
      │
      └─ 到点仍未返回
             └─▶ 向该会话注入一条带来源标记的 user 消息
                    （agent.inject；会话空闲时改用 followup 唤醒）
                    └─▶ 长调用返回后，模型下一个 step 读到提醒并自行处置
```

实现只用 DSH 公开扩展点，不碰宿主内部：

- `tools/execute`（waterfall）：环绕一次工具派发，负责计时与拆表；
- `agent.inject()` / `agent.followup()`：注入提醒，消息带 producer-owned 来源 `plugin:stall-watchdog`；
- `Config`（全部字段 `.volatile()`）：DSH 设置模型的原生可编辑配置；
- `configForms` + `plugins.bundle.config` 槽：插件页的配置卡，写入走 DSH 自己的配置编辑器（保留你 profile 里其他插件的行）。

## 文件

```text
dsh-stall-watchdog/
├── index.js          # Host 半：计时、阈值、注入提醒、清理
├── client.js         # Client 半：插件页配置卡（纯 JS，免构建）
├── cordis.patch.yml  # bundle patch：插件行 + 默认排除工具
├── package.json      # dsh.bundle / dsh.client 声明
├── icon.svg          # 图标
└── locale/           # 插件管理器显示的中英文标题与说明
```

## 已知边界

- 提醒依赖模型读到注入消息后的自觉处置；插件**不会**替你强杀卡住的调用（DSH 的停止按钮仍是唯一硬中止）。
- 只计根级工具调用：由 `run_code` 等父工具转发的子调用由父调用的计时覆盖，不重复提醒。
- 会话空闲时收到超时（如长任务在后台跑完前你已停手），提醒用 `followup` 唤醒会话，可能让会话多走一步。

## License

MIT
