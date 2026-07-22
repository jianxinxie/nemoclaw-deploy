# nemoclaw-deploy

使用一个 `onboard.yaml` 安装/onboard NemoClaw，并向同一个 sandbox 部署一个或多个 OpenClaw agent。

## 快速开始

要求 Node.js >= 20。

```bash
npm install -g @advantech-axa/nemoclaw-deploy
nemoclaw-deploy init-config --output onboard.yaml
nemoclaw-deploy up --config onboard.yaml --dry-run
nemoclaw-deploy up --config onboard.yaml
```

默认不传 `--config` 时读取当前目录的 `onboard.yaml`。
`init-config` 默认生成精简配置，只包含日常需要修改的字段；所有高级字段可参考 `templates/onboard.full.yaml`。

统一配置使用 `schemaVersion: 3`，分为三个区域：

- `install`：NemoClaw 安装版本和安装策略。
- `onboard`：sandbox、推理模型、GPU、policy 和服务端口。
- `deploy`：OpenClaw 共享配置以及 agents。

`deploy` 自动使用 `onboard.sandbox.name`，不需要重复填写 sandbox 名称。

## 常用命令

```bash
# 完整流程
nemoclaw-deploy up --config onboard.yaml

# 只执行安装/onboard 分区
nemoclaw-deploy bootstrap --config onboard.yaml

# sandbox 已存在时，只执行 deploy 分区
nemoclaw-deploy deploy --config onboard.yaml

# 检查环境
nemoclaw-deploy doctor
nemoclaw-deploy doctor --sandbox demo
```

根命令 `nemoclaw-deploy` 等价于 `nemoclaw-deploy up`。

## 模型与版本

```yaml
schemaVersion: 3

install:
  enabled: true
  mode: if-missing
  version: v0.0.75

onboard:
  mode: ensure
  sandbox:
    name: demo
    runtime: openclaw
    # 留空使用 NemoClaw 官方镜像。
    # 填写时目录内必须包含 Dockerfile。
    dockerfileDir: ""
  inference:
    provider: custom
    model: Qwen3.6-35B
    endpointUrl: https://ai.example.com/v1
    preferredApi: openai-completions
```

如果本机 NemoClaw 低于 `install.version`，交互模式会询问是否更新，默认选择“否”；拒绝后继续后续流程。相同或更高版本直接复用，非交互模式发现旧版本时自动更新，`mode: reinstall` 始终按配置显式重装。

`onboard.inference.model` 是创建或重建 sandbox 时使用的默认模型。`deploy.agents[].model` 留空时保留 OpenClaw 当前值；填写后仅覆盖对应 agent。已有 sandbox 在 `ensure` 模式下会跳过 onboard，因此需要修改已有 agent 模型时应填写 agent 的 `model`。

模型 API key 建议使用交互覆盖，避免把真实凭据长期保存在 YAML 中：

```yaml
onboard:
  inference:
    provider: custom
    apiKey:
      promptInInteractive: true
      value: ""
```

只有实际需要安装/onboard 时才会隐藏提示输入；输入值仅用于本次进程，不会显示或写回配置。非交互部署应将其设为 `false`，并使用 `fromEnv` 或 `value`。

## 自定义 sandbox Dockerfile

默认不设置 `onboard.sandbox.dockerfileDir`，由 NemoClaw 使用官方 sandbox 镜像。需要自定义镜像时填写 Dockerfile 所在目录：

```yaml
onboard:
  sandbox:
    name: demo
    runtime: openclaw
    dockerfileDir: ./sandbox-image
```

目录内必须存在名为 `Dockerfile` 的普通文件。相对目录按 `onboard.yaml` 所在目录解析；CLI 会将其转换为 `nemoclaw onboard --from <绝对目录>/Dockerfile`。Dockerfile 的父目录会作为完整 Docker build context，因此 `COPY` 使用的文件也应放在该目录内。使用自定义 Dockerfile 时，它定义的是完整 sandbox 镜像，不会自动叠加在 NemoClaw 官方镜像上。

## Agent sandbox 上传和命令

每个 agent 都能上传主机文件或目录到任意 sandbox 绝对路径，并在指定目录执行 shell 命令：

```yaml
deploy:
  agents:
    - name: python-agent
      workspace: ""

      sandbox:
        uploads:
          enabled: true
          items:
            - source: ./config
              destination: /sandbox/opt/python-agent/config
              overwrite: true
            - source: /opt/company/settings.json
              destination: /sandbox/opt/python-agent/settings.json
              overwrite: false

        commands:
          enabled: true
          workingDir: ""
          items:
            - python3 -m venv "$VIRTUAL_ENV"
            - '"$PYTHON" -m pip install -r requirements.txt'
          continueOnError: false
```

上传规则：

- `source` 可以是文件或目录；相对路径按 `onboard.yaml` 所在目录解析。
- `destination` 必须是 sandbox 绝对路径。
- 目录会递归合并。`overwrite: true` 覆盖冲突项并保留目标中的额外文件；`false` 会在写入前检查冲突并失败。

命令规则：

- `workingDir: ""` 默认使用当前 agent workspace。
- 相对 `workingDir` 位于 workspace 内，也可以填写 sandbox 绝对路径。
- 命令按 `items` 顺序执行，并注入 `WORKSPACE`、`VIRTUAL_ENV`、`PYTHON`。
- 每条命令会先上传成临时 shell 脚本再执行，因此支持多行命令。

## OpenClaw 配置

`deploy.shared.openclawConfig.file` 指向不完整的 `openclaw.json` overlay，也是 `models`、`tools`、`channels`、`mcp` 等 OpenClaw 业务配置的用户配置源。

```yaml
deploy:
  shared:
    openclawConfig:
      enabled: true
      file: ./openclaw.json
```

普通对象递归合并，标量和数组覆盖，`null` 删除字段。partial 不允许包含 `agents` 或本地 token、secret、password、API key。agent 由 OpenClaw 管理，只有显式填写的 `deploy.agents[].model` 会按 agent ID 定向更新。

插件的 `id/source/force` 留在 `onboard.yaml`，插件 channel 业务配置放在 partial。`deploy.shared.channelServer` 只负责 ChannelServer URL、agent 注册以及 advbot 的动态 gateway 字段。

## 部署脚本

将 `install-and-up.sh` 和 `onboard.yaml` 放在同一目录：

```bash
chmod +x install-and-up.sh
./install-and-up.sh --dry-run
./install-and-up.sh
```

脚本会准备 Node.js、安装 CLI，然后执行：

```bash
nemoclaw-deploy up --config onboard.yaml
```

如果当前 `PATH` 或脚本专用 npm prefix 中已经存在 `nemoclaw-deploy`，脚本会直接复用，不访问 npm 获取新版本。需要显式重新安装时使用：

```bash
FORCE_CLI_INSTALL=1 ./install-and-up.sh
```

## 安全提示

- 不要把真实 API key、token 或 password 提交到仓库。
- secret 优先通过环境变量、NemoClaw 官方安全提示或运行平台注入。
- `agentContent.conflictStrategy: ask` 在非交互模式下按 `fail` 处理。
- `--dry-run` 不执行安装、onboard、上传或 sandbox 命令。

精简配置见 [onboard.yaml](templates/onboard.yaml)，完整字段示例见 [onboard.full.yaml](templates/onboard.full.yaml)，详细说明见 [docs/USAGE.md](docs/USAGE.md)。
