# nemoclaw-deploy

使用一个 `onboard.yaml` 安装/onboard NemoClaw，并向同一个 sandbox 部署一个或多个 OpenClaw agent。

## 快速开始

主机要求 Node.js >=22.19.0，安装脚本优先复用 PATH 或 nvm 中已安装的合格版本，缺少时默认准备 Node.js 24 的可用版本；默认安装 NemoClaw v0.0.139，仍支持已有的 v0.0.134 及更高版本。sandbox 内 Node.js 会按 OpenClaw 的完整版本范围独立检查，主机升级不会更新 sandbox 内的 Node.js。

skills 放到每个 agent 的内容目录下的 `skills/<name>/SKILL.md`，随 workspace 一起上传；独立 `skill` 配置已移除。私网 policy 使用显式 `trustedPrivateHosts` 配置，并通过新版 `policy add` 命令应用。迁移和 IEMS 部署步骤见 [使用说明](docs/USAGE.md)。

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
  version: v0.0.139

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

如果本机 NemoClaw 低于 `install.version`，交互模式会询问是否更新，默认选择“否”；拒绝后仍须满足最低版本 v0.0.134 才能继续。相同或更高版本直接复用，非交互模式发现旧版本时自动更新，`mode: reinstall` 始终按配置显式重装。

`onboard.inference.model` 是创建或重建 sandbox 时使用的默认模型。`deploy.agents[].model` 留空时保留 OpenClaw 当前值；填写后仅覆盖对应 agent。已有 sandbox 在 `ensure` 模式下会跳过 onboard，因此需要修改已有 agent 模型时应填写 agent 的 `model`。

模型 API key 直接从 `onboard.yaml` 读取：

```yaml
onboard:
  inference:
    provider: custom
    apiKey: "your-api-key"
```

CLI 不会再为模型 API key 弹出输入框。该值只会在执行安装/onboard 时注入 provider 对应的 credential 环境变量，命令计划和日志不会显示明文。请使用仅保存在本机且不提交到版本库的配置文件。

安装时同时设置 `NEMOCLAW_INSTALL_TAG` 和优先级更高的 `NEMOCLAW_INSTALL_REF`，确保 `install.version` 不会被主机中遗留的安装 ref 覆盖。

## Dashboard 远程访问

在 `onboard.yaml` 中开启：

```yaml
onboard:
  services:
    dashboardRemoteAccess: true
```

模板默认 `false`。开启后，官方安装器、显式 onboard 和后续 deploy 命令都会收到 `NEMOCLAW_DASHBOARD_BIND=0.0.0.0`。手动连接仍需传入：

```bash
NEMOCLAW_DASHBOARD_BIND=0.0.0.0 nemoclaw demo connect
```

该变量控制所有网卡上的端口监听；NemoClaw v0.0.139 默认打印的 Dashboard URL 仍是 `127.0.0.1`。远程浏览器使用主机实际 IP/域名和相同端口，不要把 `0.0.0.0` 当作访问地址。此开关不会改写 advbot 的 `gatewayUrl`。

如果 sandbox 创建时没有开启，必须先备份，再显式设置 `onboard.mode: recreate` 重建；`ensure` 会跳过可用的已有 sandbox，不会补开远程访问。配置优先级和关闭行为见 [使用说明](docs/USAGE.md#dashboard-远程访问)，上游行为见 [NVIDIA 官方说明](https://docs.nvidia.com/nemoclaw/user-guide/openclaw/reference/commands#environment-variables)。

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

普通对象递归合并，标量和数组覆盖，`null` 删除字段。partial 不允许包含 `agents`；channel 的 `secret` 等 OpenClaw 业务字段会直接合并，CLI 不额外拦截。agent 由 OpenClaw 管理，只有显式填写的 `deploy.agents[].model` 会按 agent ID 定向更新。

写入后会重新读取配置核对合并结果，并通过 `openclaw channels list --all --json` 确认 advbot 账号被识别；检查失败则回滚本次配置事务。全部操作和网关重启结束后还会再次核对配置，确认保存成功后才显示“部署完成”。

插件的来源和安装确认选项留在 `onboard.yaml`，插件 channel 业务配置放在 partial。`deploy.shared.channelServer` 只负责 ChannelServer URL、agent 注册以及 advbot 的动态 gateway 字段。

启用 ChannelServer 时，每次部署都会获取当前 gateway token 和 URL，写入 `channels.advbot.accounts.<advbotAccountId>`，并覆盖 partial 中过时的连接字段；已有账号的其他业务配置及其他账号会保留。token 只用于 sandbox 配置，日志脱敏，主机上的 partial 文件保持原样。

新版 OpenClaw 的安装确认分开配置：`trustSource: true` 确认来源，`acceptCapabilities: true` 接受插件声明的能力，`acknowledgeInstallPolicyWarning: true` 确认安装策略的警告。三项均默认关闭，按实际提示和审查结果开启；只有 `force: true` 会要求重复部署时重装插件。详见[插件安装的来源确认](docs/USAGE.md#插件安装的来源确认)。

## 部署脚本

将 `install-and-up.sh` 和 `onboard.yaml` 放在同一目录：

```bash
chmod +x install-and-up.sh
./install-and-up.sh --dry-run
./install-and-up.sh
```

脚本检查参数、配置与随包 CLI 校验值，准备 Node.js，以独立目录安装并验证 CLI，成功后才切换入口，然后执行：

```bash
nemoclaw-deploy up --config onboard.yaml
```

存在随包 CLI 时，脚本按 SHA256 复用本地安装，同版本修复也能自动更新；没有随包 CLI 时，优先复用脚本专用 prefix，然后检查 PATH 中版本 >=0.0.10 的 CLI。安装失败保留旧 CLI。需要显式重新安装时使用：

```bash
FORCE_CLI_INSTALL=1 ./install-and-up.sh
```

使用 `--prepare-only` 可以安装 Node.js/CLI 并检查完整计划，不安装 NemoClaw 或创建 sandbox；之后 `--dry-run` 可复用准备好的 CLI。`--config <file>` 在准备环境前选择并检查配置，`--help` 无需配置或 Node.js，未知参数立即失败。同一 npm prefix 使用 `flock` 防止并发安装（Linux 安装 util-linux）；失败会显示阶段及退出码，并清理临时文件。

安装失败后可以重新运行同一入口。脚本会复用已安装的合格 Node.js，加载 nvm 时不自动激活可能失效的默认别名。可用 `NODE_VERSION=24` 选择主版本，或指定完整补丁版本。nvm 的 `Version not found` 也可能是版本索引不可达，请检查 `NVM_NODEJS_ORG_MIRROR` 和代理。

nvm 和 NVIDIA 安装器均先完整下载，再执行；下载启用有限重试。官方安装器内部若报 `release-assets.githubusercontent.com` 的 SSL 错误，需要修复目标主机的 GitHub 网络或 HTTPS 代理后重试。CLI 不自动重跑整个官方安装流程。

`NPM_OFFLINE=1` 禁止 npm 联网；IEMS 随包 CLI 携带锁定的生产依赖，支持空 npm 缓存安装，其他自定义包可能仍需要缓存。这不是完整离线部署。可用 `NEMOCLAW_INSTALLER_FILE` 指向预先获取的 NVIDIA 官方入口脚本，并用 `NEMOCLAW_INSTALLER_SHA256` 校验。入口脚本会先检查非空和 Bash 语法，内部依赖下载仍需网络。`up` 在安装前检查本地部署资源；已有但无法报告版本的 NemoClaw 会按安装策略修复，并避免 PATH 中旧入口遮蔽新版。

在源码仓库执行 `npm run bundle:iems`，可重建含 CLI、安装入口及两级 SHA256 清单的 IEMS 包，并自动进行解压校验。IEMS 业务配置仅进入内部 ZIP，不进入公开 npm 包。

`NPM_OFFLINE=1 npm run test:bundle` 从 ZIP 进行空缓存的真实 CLI 安装与重复运行检查，不创建 sandbox。

## 安全提示

- `onboard.inference.apiKey` 可以保存模型凭据，但包含真实值的配置文件不要提交到仓库。
- partial 中可以保存 channel secret，但包含真实凭据的文件不要提交到版本库，并应限制本地文件权限。
- `agentContent.conflictStrategy: ask` 在非交互模式下按 `fail` 处理。
- `--dry-run` 不执行安装、onboard、上传或 sandbox 命令。

精简配置见 [onboard.yaml](templates/onboard.yaml)，完整字段示例见 [onboard.full.yaml](templates/onboard.full.yaml)，详细说明见 [docs/USAGE.md](docs/USAGE.md)。
