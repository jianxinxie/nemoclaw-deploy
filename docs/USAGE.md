# 使用说明

## 单一配置文件

项目只接受 `schemaVersion: 3` 的统一 `onboard.yaml`，不再读取独立 `deploy.yaml`。

```bash
nemoclaw-deploy init-config --output onboard.yaml
```

该命令生成日常使用的精简配置。CLI 对未填写字段应用默认值；需要 GPU、policy、端口、timeout、上传、sandbox commands 或 env 等高级配置时，参考 `templates/onboard.full.yaml`。

配置结构：

```yaml
schemaVersion: 3

install:
  version: v0.0.75

onboard:
  sandbox:
    name: demo
    runtime: openclaw
    dockerfileDir: ""
  inference:
    provider: ""
    model: ""

deploy:
  shared: {}
  agents: []
```

所有相对路径都按 `onboard.yaml` 所在目录解析。

## 自定义 sandbox Dockerfile

默认配置：

```yaml
onboard:
  sandbox:
    name: demo
    runtime: openclaw
    dockerfileDir: ""
```

`dockerfileDir` 省略或留空时不传自定义镜像参数，NemoClaw 使用官方 sandbox 镜像。需要自定义镜像时，把它设置为包含 `Dockerfile` 的主机目录：

```yaml
onboard:
  sandbox:
    name: demo
    runtime: openclaw
    dockerfileDir: ./sandbox-image
```

规则：

- 目录可以是绝对路径；相对路径按 `onboard.yaml` 所在目录解析。
- 目录必须存在，且其中必须包含名为 `Dockerfile` 的普通文件。
- CLI 执行显式 onboard 时传入 `--from <dockerfileDir>/Dockerfile`。
- 首次安装 NemoClaw 并由官方安装器承接 onboard 时，CLI 注入 `NEMOCLAW_FROM_DOCKERFILE`，两条路径行为一致。
- Dockerfile 的父目录是完整 Docker build context，`COPY` 引用的文件应位于该目录中，并建议使用 `.dockerignore` 排除无关内容。
- 自定义 Dockerfile 表示完整 sandbox 镜像，不会自动继承或叠加 NemoClaw 官方 runtime；如果仍需 OpenClaw/NemoClaw 管理能力，应以对应版本的官方完整 Dockerfile 为基础进行修改。

## 执行方式

```bash
# 完整安装、onboard 和 deploy
nemoclaw-deploy up --config onboard.yaml

# 仅安装/onboard
nemoclaw-deploy bootstrap --config onboard.yaml

# 仅部署 agents
nemoclaw-deploy deploy --config onboard.yaml

# 非交互或预览
nemoclaw-deploy up --config onboard.yaml --non-interactive
nemoclaw-deploy up --config onboard.yaml --dry-run
```

不传 `--config` 时使用当前目录下的 `onboard.yaml`。

`templates/install-and-up.sh` 默认优先复用本机 `PATH` 或其专用 npm prefix 中已经安装的 `nemoclaw-deploy`，仅在找不到本地 CLI 时安装 npm 包。设置 `FORCE_CLI_INSTALL=1` 可以显式强制重新安装。

## NemoClaw 版本和模型

```yaml
install:
  enabled: true
  mode: if-missing
  version: v0.0.75

onboard:
  mode: ensure
  inference:
    provider: custom
    model: openai/gpt-oss-120b
    endpointUrl: https://api.openai-compatible.example/v1
    preferredApi: openai-completions
```

本机没有 NemoClaw 时会按 `install.version` 安装。本机版本低于配置版本时，交互模式会在输出 Bootstrap 计划之前立即询问是否更新，默认选择“否”；选择不更新会继续 onboard/deploy。相同或更高版本不会重装或降级。非交互模式检测到旧版本时自动更新；`mode: reinstall` 则始终按配置显式重装。`lkg` 等非语义版本 tag 无法进行大小比较，因此已安装时不会触发版本更新判断。

`onboard.inference.model` 只影响实际执行的 onboard；当 `mode: ensure` 发现 sandbox 已存在时不会重配模型。

已有 agent 需要单独切换模型时使用：

```yaml
deploy:
  agents:
    - name: my-agent
      model: provider/model-id
```

`model: ""` 表示保留 OpenClaw 当前设置。

### 安全修改模型 API key

对于 `custom` 等需要模型凭据的 provider，建议启用交互覆盖：

```yaml
onboard:
  inference:
    provider: custom
    model: qwen3.6-35B
    endpointUrl: https://ai.example.com/v1
    apiKey:
      promptInInteractive: true
      value: ""
```

当本次操作确实需要安装或 onboard 时，CLI 会在启动 NemoClaw 前隐藏输入 API key，并注入到 provider 对应的 credential 环境变量。输入值只保存在当前进程内存中，不会打印或写回 `onboard.yaml`。如果 NemoClaw 验证失败，可退出官方向导后重新执行命令，再输入新的 key。

`--non-interactive` 会忽略 `promptInInteractive`，此时必须使用 `apiKey.value`、`apiKey.fromEnv` 或 provider 对应的当前进程环境变量。自动化环境推荐：

```yaml
apiKey:
  promptInInteractive: false
  fromEnv: MODEL_API_KEY
```

然后在运行前设置 `MODEL_API_KEY`。对于 `provider: custom`，CLI 会把它安全映射到 NemoClaw 使用的 `COMPATIBLE_API_KEY`。

## Onboard policy presets

完整模板使用显式的常用 preset 集合：

```yaml
onboard:
  policy:
    tier: balanced
    mode: custom
    presets:
      - npm
      - pypi
      - github
      - huggingface
      - brew
      - openclaw-pricing
      - public-reference
      - weather
```

这些 preset 分别用于 Node/Python 包、GitHub、Hugging Face、Homebrew、OpenClaw 价格数据以及常见只读公共查询。`custom` 表示列表由配置显式控制；请删除实际不需要的 preset，减少 sandbox 的网络访问范围。

搜索服务的 `brave`/`tavily`、主机本地推理的 `local-inference`，以及消息和办公平台的 `slack`、`discord`、`telegram`、`wechat`、`whatsapp`、`teams`、`jira`、`outlook` 需要按实际集成添加，不在默认列表中。

这里的 `presets` 是 NemoClaw 内置 preset 名称。自定义 YAML policy 文件继续通过 `deploy.shared.networkPolicy.dir` 应用。

## Agent 基础配置

```yaml
deploy:
  agents:
    - name: my-agent
      workspace: ""
      model: ""

      agentContent:
        enabled: true
        hostDir: ./agent-content
        conflictStrategy: ask
        ignore: [.git, node_modules, .venv, __pycache__]

      skill:
        enabled: true
        hostDir: ./skills

      channelRegistration:
        enabled: false
        continueOnError: true

      env:
        enabled: true
        directory: ""
        targetFile: .env
        variables:
          APP_ENV: production
```

`workspace: ""` 默认使用 `/sandbox/.openclaw/workspace-${agentName}`。如果 agent 已存在，CLI 会读取 OpenClaw 中的实际 workspace，并将后续上传、env 和命令操作切换到该路径。

`env.directory` 规则：

- 省略或留空：agent workspace。
- 相对路径：agent workspace 内的对应目录。
- 绝对路径：sandbox 中的指定目录。

`env.targetFile` 是相对于 `env.directory` 的文件路径，默认为 `.env`。自定义目录中的 env 文件不会自动变成 OpenClaw 的 workspace `.env`，是否加载由该目录中的应用负责。

## 上传文件或目录到 sandbox

```yaml
deploy:
  agents:
    - name: my-agent
      sandbox:
        uploads:
          enabled: true
          items:
            - source: /opt/company/config.json
              destination: /sandbox/config/config.json
              overwrite: true
            - source: ./scripts
              destination: /sandbox/opt/my-agent/scripts
              overwrite: false
```

- `source` 支持主机文件和目录。
- 文件的 `destination` 是完整目标文件路径。
- 目录的 `destination` 是目标目录，源目录内容会递归合并。
- `overwrite: true` 覆盖同名文件或类型冲突项，但保留目标额外内容。
- `overwrite: false` 会先完成全量冲突检查；存在同名项时不写入并失败。
- 为避免误操作，`destination` 不能是 sandbox 根目录 `/`。

## 在 sandbox 指定目录执行命令

```yaml
deploy:
  agents:
    - name: my-agent
      sandbox:
        commands:
          enabled: true
          workingDir: app
          items:
            - npm ci
            - npm run build
            - |
              test -f dist/index.js
              echo "build completed"
          continueOnError: false
```

`workingDir` 规则：

- 留空：agent workspace。
- 相对路径：workspace 内的对应目录。
- 绝对路径：sandbox 中的指定目录。

命令按顺序执行。CLI 会注入：

- `WORKSPACE`
- `VIRTUAL_ENV=$WORKSPACE/.venv`
- `PYTHON=$VIRTUAL_ENV/bin/python`
- `$VIRTUAL_ENV/bin` 位于 `PATH` 最前面

`continueOnError: false` 时任一命令失败都会停止部署；设为 `true` 时继续后续命令，并在摘要中标记 `partial`。

## OpenClaw partial 配置

```yaml
deploy:
  shared:
    openclawConfig:
      enabled: true
      file: ./openclaw.json
```

合并顺序：

```text
现有 openclaw.json
  → openclaw.json overlay
  → 已安装插件的启用状态
  → ChannelServer/advbot 动态字段
  → deploy.agents[].model
```

partial 中适合配置 `models`、`channels`、`mcp`、`session`、`tools`、`cron` 和 `env`。不允许包含 `agents`、token、secret、password、API key、Authorization、Bearer 或 JWT。省略的现有字段会保留，配置验证失败时会自动回滚。

## ChannelServer 和 agent 注册

```yaml
deploy:
  shared:
    channelServer:
      enabled: true
      url: http://127.0.0.1:8086
      advbotAccountId: default

  agents:
    - name: my-agent
      channelRegistration:
        enabled: true
        continueOnError: true
```

注册请求为：

```http
POST <channelServer.url>/v1/openclaw/agents
Content-Type: application/json

{"agent_id":"my-agent"}
```

`continueOnError` 默认为 `true`：注册请求失败时记录 `failed-continued` 并完成部署。设为 `false` 时，curl 预检查或注册请求失败会立即终止部署。

ChannelServer 集成还会自动获取 gateway token 和 gateway URL，只补充 `channels.advbot.accounts.<advbotAccountId>` 的动态连接字段。

## 常用开关

- `deploy.shared.channelServer.enabled: false`
- `deploy.shared.networkPolicy.enabled: false`
- `deploy.shared.openclawConfig.enabled: false`
- `deploy.shared.options.restartGateway: true`
- `deploy.agents[].skill.enabled: false`
- `deploy.agents[].sandbox.uploads.enabled: false`
- `deploy.agents[].sandbox.commands.enabled: false`
- `deploy.agents[].channelRegistration.enabled: false`

## 安全提示

- 不要把真实 API key、token 或 password 提交到 YAML 或 partial JSON。
- `--dry-run` 不执行真实安装、上传、命令或外部请求。
- 所有外部命令均经过统一执行器并进行敏感参数脱敏。
