# nemoclaw-deploy

`nemoclaw-deploy` 是一个 Node.js / TypeScript CLI，用于在已经部署好的 NemoClaw sandbox 中安全部署 OpenClaw agent。

它负责：

- 创建或确认 OpenClaw agent
- 安全上传 agent 初始化内容
- 安装 skills 目录下的所有 skill
- 安装 OpenClaw 插件（如 wecom、advbot），启用并写入 channel 配置
- 配置 `tools.profile`（默认 coding）及额外 tools 配置
- 配置 `channels.advbot`
- 应用 network policy 目录下的所有策略文件
- 合并写入 workspace `.env`
- 在 workspace 中安装依赖
- 按需重启 OpenClaw gateway 和完成基础验证
- 可选在部署最后重启 OpenClaw 网关，使插件和 channel 配置生效

它不负责安装 NemoClaw，也不负责创建 sandbox。

## 安装

```bash
npm install -g @advantech-axa/nemoclaw-deploy
```

## 使用

交互式部署：

```bash
nemoclaw-deploy
```

配置文件部署：

```bash
nemoclaw-deploy deploy --config deploy.yaml
```

非交互部署：

```bash
nemoclaw-deploy deploy --config deploy.yaml --non-interactive
```

只查看计划：

```bash
nemoclaw-deploy deploy --config deploy.yaml --dry-run
```

生成配置模板：

```bash
nemoclaw-deploy init-config --output deploy.yaml
```

检查环境：

```bash
nemoclaw-deploy doctor
nemoclaw-deploy doctor --sandbox demo
```

## 配置格式

```yaml
sandboxName: demo
agentName: my-agent

workspace: ""

agentContent:
  enabled: true
  hostDir: ./agent-content
  conflictStrategy: ask
  ignore:
    - .git
    - node_modules
    - "*.log"

skill:
  enabled: true
  hostDir: ./skills

plugins:
  enabled: true
  items:
    - id: wecom-openclaw-plugin
      channelId: wecom
      source: "@wecom/wecom-openclaw-plugin"
      channel:
        enabled: true
        defaultAccount: default
        accounts:
          default:
            enabled: true
            botId: your-bot-id
            secret: your-bot-secret
            connectionMode: websocket
            websocketUrl: wss://openws.work.weixin.qq.com
    - id: advbot
      source: ./plugins/advbot

tools:
  enabled: true
  profile: coding
  config: {}

channel:
  enabled: true
  type: advbot
  accountId: default
  channelServerUrl: http://127.0.0.1:8086
  gatewayToken: ""
  gatewayUrl: ""

networkPolicy:
  enabled: true
  dir: ./policies

env:
  enabled: false
  targetFile: .env
  variables:
    NODE_ENV: production

dependencies:
  enabled: false
  workingDir: ""
  commands:
    - npm install
  continueOnError: false

options:
  restartGateway: true
```

`workspace` 为空时默认使用 `/sandbox/.openclaw/workspace-${agentName}`。

`agentContent.ignore` 指定不上传的目录/文件模式，在本机过滤，被忽略的内容不会进入 sandbox。语义为简化版 `.gitignore`：不含 `/` 的模式匹配任意层级下的名称（如 `node_modules`、`*.log`）；含 `/` 的模式相对 `hostDir` 根路径匹配（如 `docs/draft.md`、`data/**`）；末尾 `/` 只匹配目录；`*` 不跨目录、`**` 跨目录；不支持 `!` 取反。

`skill.hostDir` 指向 skills 根目录。CLI 会安装该目录下所有包含 `SKILL.md` 的 skill 子目录；如果该目录本身包含 `SKILL.md`，也兼容作为单个 skill 安装。

`plugins.enabled=true` 时，CLI 会对 `items` 中的每个插件依次执行：插件缺失时安装（`openclaw plugins install`）、在 `openclaw.json` 中启用（`plugins.entries.<id>.enabled=true`）。`id` 建议使用 `openclaw plugins list --json` 输出里的真实插件 id；如果真实插件 id 和 channel id 不同，可设置 `channelId`，例如企业微信插件使用 `id: wecom-openclaw-plugin`、`channelId: wecom`。`source` 支持本机路径（`./`、`../`、`/`、`~/` 开头，先上传到 sandbox 临时目录再安装）、npm spec、`clawhub:package` 和 marketplace 名称；留空表示插件已内置或已安装，只做启用和 channel 配置。`force: true` 时对已安装插件强制重装。npm/clawhub 来源在 sandbox 内下载，需要 network policy 放行对应源（npm 通常在默认 policy 中已放行，ClawHub 需要额外放行）。

`items[].channel` 用于 channel plugin（如 wecom）的 `channels.<channelId 或 id>` 配置，会深合并写入 `openclaw.json`：对象字段递归合并（已有的其他 account 保留），数组和标量直接覆盖，顶层 `enabled` 缺省时自动设为 true。配置中的 `secret` 值在日志中会脱敏，但不要把真实 secret 提交到版本库。需要自动获取 gatewayToken/gatewayUrl 的 advbot channel 建议继续使用下方的 `channel` 配置段。

`tools.enabled=true`（默认）时，CLI 会在 `openclaw.json` 中设置 `tools.profile`（默认 `coding`，可通过 `tools.profile` 修改），并把 `tools.config` 中的内容深合并进 `tools` 段；已有的 `toolSearch`、`web` 等配置保持不变。

`options.restartGateway=true` 时，CLI 会在部署最后执行 `nemoclaw <sandboxName> gateway restart` 前台重启 OpenClaw 网关并等待完成，使插件、tools 和 channel 配置生效。插件或 channel 配置更新后如果没有重启网关，CLI 会输出提醒。

`networkPolicy.dir` 指向 network policy 目录。CLI 会应用该目录下所有 `.yaml` / `.yml` 文件；旧配置中的 `networkPolicy.file` 仍兼容单文件路径。

`env.enabled=true` 时，CLI 会把 `variables` 和自动生成的 workspace 变量合并写入 `${workspace}/${targetFile}`。不要把真实 secret 写进 `deploy.yaml`；需要 secret 时请通过运行环境或平台能力注入。

`dependencies.enabled=true` 时，CLI 会在 `dependencies.workingDir` 下执行 `commands`。`workingDir` 为空时默认是当前 agent workspace；相对路径会解析到 workspace 内。

### Workspace Python venv

完整说明见 [Python Workspace 使用说明](docs/PYTHON_WORKSPACE.md)。

如果多个 skill 需要共享 Python 依赖，推荐把虚拟环境放在 agent workspace：

```bash
python3 -m venv "$VIRTUAL_ENV"
"$PYTHON" -m pip install -r requirements.txt
```

启用 `env.enabled=true` 后，CLI 会自动写入这些 workspace 级变量：

```bash
WORKSPACE=/sandbox/.openclaw/workspace-<agent>
VIRTUAL_ENV=$WORKSPACE/.venv
PYTHON=$WORKSPACE/.venv/bin/python
```

启用 `env.enabled=true` 后，OpenClaw 会从 workspace `.env` 加载普通项目变量。Python skill 可以直接使用 `PYTHON` 运行脚本，不需要写 workspace 绝对路径：

```bash
"$PYTHON" path/to/script.py
```

`PYTHON` 指向 workspace 下的 `.venv/bin/python`。`WORKSPACE` 和 `VIRTUAL_ENV` 也会一并写入 `.env`。

如果是在手动 shell 里测试，变量还没有被 OpenClaw 注入，可以先进入 workspace 后加载 `.env`：

```bash
set -a
. ./.env
set +a
"$PYTHON" path/to/script.py
```

这样 skill 目录可以保持只读/可替换，项目依赖留在 workspace。

Network policy 通过 NemoClaw live policy 写入，应用后不需要重启 gateway。需要让 OpenClaw 配置立即生效时，设置 `options.restartGateway=true`，或手动执行 `nemoclaw <sandboxName> gateway restart`。

## 安全策略

- 所有外部命令通过统一 `runCommand` 执行。
- dry-run 模式不执行真实命令。
- gateway token 不会完整打印到日志。
- dashboard URL 中的 `#token=...` 不会拼入 gateway URL。
- agent-content 不会直接上传覆盖 workspace，而是先上传到 sandbox 临时目录，再由合并脚本按冲突策略处理。
- 非交互模式下 agent-content 冲突默认失败。

## 文档

- [Python Workspace 使用说明](docs/PYTHON_WORKSPACE.md)
- [ROADMAP](docs/ROADMAP.md)
- [v0.1.0](docs/releases/v0.1.0.md)
- [v0.2.0](docs/releases/v0.2.0.md)
- [v0.3.0](docs/releases/v0.3.0.md)
- [v1.0.0](docs/releases/v1.0.0.md)
