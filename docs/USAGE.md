# 使用说明

## NemoClaw v0.0.139 兼容与迁移

安装模板默认选择 Node.js 24 的可用版本和 NemoClaw v0.0.139；主机 Node.js 不与 sandbox 镜像的补丁版本绑定。最低支持的 NemoClaw CLI 保持 v0.0.134，已有固定版本配置无需强制迁移。两套运行环境分别检查：

| 位置 | 版本要求 | 检查位置 |
| --- | --- | --- |
| 主机：NemoClaw 和部署 CLI | Node.js >=22.19.0 | npm 安装生命周期、安装脚本、CLI 启动和 doctor |
| sandbox：OpenClaw 2026.9.2 | Node.js >=22.22.3 <23，或 >=24.15.0 <25，或 >=25.9.0 | 部署预检查和 doctor --sandbox |

OpenClaw 不接受 Node 23，也不接受 22.22.2、24.14.x 等低于对应分支最低补丁版本的运行时。sandbox 预检查先执行 `node --version`，再执行 `openclaw --version`，不符合要求时在创建 agent、上传内容和修改配置前停止。

现有主机版本符合 NemoClaw 要求时直接复用；PATH 中缺少或版本不足时，安装脚本以 `--no-use` 加载 nvm，先尝试已安装的指定版本、default 和最新本地版本。仍无可用版本时，才通过 nvm 安装并切换到 Node.js 24 的可用版本（可用 `NODE_VERSION` 指定主版本或完整补丁版本）。npm 安装阶段同样执行版本检查，不仅依靠 engines 警告。

### 安装失败后重试

重新运行同一安装入口会复用已安装的合格 Node.js，不会因上次 NemoClaw 安装失败而强制重新下载 Node.js。`nvm install` 的 `Version not found` 不一定表示版本不存在，也可能是当前 `NVM_NODEJS_ORG_MIRROR` 的版本索引访问失败；检查镜像地址、DNS、TLS 和 `HTTPS_PROXY`。必要时显式指定可访问的 Node.js 官方源：

```bash
NVM_NODEJS_ORG_MIRROR=https://nodejs.org/dist NODE_VERSION=24 bash install.sh
```

nvm 和 NVIDIA 安装器使用完整下载后执行，下载启用有限重试，失败时清理临时文件且不执行残缺脚本。下载重试不等于重跑整个官方安装器。若官方安装器内部访问 `release-assets.githubusercontent.com:443` 出现 `SSL_ERROR_SYSCALL`，需要修复目标主机到 GitHub release assets 的网络/代理链路；单独修改 Node.js 版本不会修复该连接。

安装时将 `install.version` 同时注入 `NEMOCLAW_INSTALL_TAG` 和 `NEMOCLAW_INSTALL_REF`。官方安装器优先读取后者，因此主机遗留的旧 ref 不会覆盖配置版本；安装后无法读取版本或仍低于目标时立即停止。

`onboard.gpu.host` 和 `onboard.gpu.sandbox` 不能分别设置为 `enabled` 和 `disabled`：官方 CLI 将对应参数视为互斥。配置检查会在安装或 onboard 前报错；不确定时保持 `auto`。

### 插件安装的来源确认

新版 OpenClaw 可能拒绝直接安装 npm 等来源的插件，输出 `This source is outside ClawHub review and trust metadata` 和 `Install cancelled; rerun with --force after reviewing the source.`。此时尚未执行插件安装，需要确认包的发布者、内容和来源。

交互部署会展示原始提示并询问是否已审查并信任该插件的来源，默认不确认；确认后仅为本次安装增加 `--force` 重试一次。非交互部署保留原始错误并停止，需要在已审查并信任的插件项上显式配置：

```yaml
deploy:
  shared:
    plugins:
      enabled: true
      items:
        - id: advbot
          source: "@advantech-axa/advbot"
          trustSource: true
```

| 插件项属性 | 安装行为 |
| --- | --- |
| `trustSource: true` | 确认来源，安装时传入 `--force`；重复部署仍跳过已安装插件。 |
| `force: true` | 确认来源并要求重装已安装插件，传入 `--force`。 |
| `acceptCapabilities: true` | 明确接受插件声明的能力，安装时传入 `--accept-capabilities`。 |
| `acknowledgeInstallPolicyWarning: true` | 明确确认安装策略的 `warn`，传入 `--acknowledge-install-policy-warning`；`block` 和策略执行失败仍终止。 |

以上属性只接受布尔值且默认 `false`。例如，已经审查来源和能力的插件可同时设置 `trustSource: true`、`acceptCapabilities: true`；安装策略没有报 `warn` 时不需要开启 `acknowledgeInstallPolicyWarning`。这些确认只作用于安装调用；需要重装已存在插件时还应设置 `force: true`。CLI 不会自动确认能力或安装策略警告；上游错误保留，并提示对应配置项。

启用插件时会把真实插件 ID 合并到已有的非空 `plugins.allow`，保留其他 ID；不会新建一个限制所有其他插件的 allowlist。`plugins.enabled: false` 和 `plugins.deny` 的显式禁止会报错，需先调整用户配置。安装来源提醒和 `plugins.allow is empty` 是不同问题；后者可按实际信任范围在 partial JSON 中显式配置 `plugins.allow`。重启后再次验证插件是否启用。

参数已按 [OpenClaw v2026.9.2 CLI 实现](https://github.com/openclaw/openclaw/blob/v2026.9.2/src/cli/plugins-cli.ts) 核对。

已确认信任来源时，也可以单独安装后重新运行部署（将 `ec` 替换为实际 sandbox 名称）：

```bash
nemoclaw ec exec -- openclaw plugins install @advantech-axa/advbot --force
```

如果同一错误末尾还出现 `telemetry.openclaw.ai:443` 被策略拦截，这只是近期网络拒绝的附带提示；上述明确取消安装的原因是来源确认。若确认后出现 npm 下载域名的真实网络错误，再按具体域名检查策略；npm 安装所需的官方 preset 可通过 `nemoclaw ec policy add npm_registry --yes` 应用。CLI 不会为网络错误自动添加 `--force`，也不会自动放开遥测域名。

### 本地兼容测试

`npm test` 覆盖安装器调用、升级和失败处理、多 agent 部署、文件冲突、skills、policy、运行时版本以及 dry-run。sandbox 传输使用本地 fixture，不需要模型凭据。

需要验证官方 v0.0.139 CLI 时，在独立目录获取并构建该 tag，再指定源码目录：

```bash
git clone --depth 1 --branch v0.0.139 https://github.com/NVIDIA/NemoClaw.git /tmp/nemoclaw-v0.0.139
npm ci --ignore-scripts --prefix /tmp/nemoclaw-v0.0.139
npm --prefix /tmp/nemoclaw-v0.0.139 run build:cli
NEMOCLAW_COMPAT_SOURCE=/tmp/nemoclaw-v0.0.139 npm run test:compat
```

该测试核对官方构建的 commit、版本、安装器，以及 onboard/policy/gateway/status/upload/exec 的真实参数解析和 sandbox-first 别名，并让本项目 `doctor` 调用真实 CLI。测试使用独立临时 HOME，不升级主机已安装的 CLI，也不创建 sandbox；真实 sandbox、模型推理和 advbot 连通性仍需在目标环境验收。

主机 CLI、sandbox Node.js 与 OpenClaw 分别检查；已有 sandbox 需要备份并通过官方 rebuild 流程更新镜像。自定义 Dockerfile 应选择符合 OpenClaw 范围的 Node.js；单独更新主机 Node.js 或 CLI 不会更新 sandbox。

独立 `deploy.agents[].skill` 配置已移除。将技能放到 `agentContent.hostDir/skills/<name>/SKILL.md`，每份说明包含合法 YAML frontmatter（`name`、`description`）。上传沿用 agent 内容的 ignore 和冲突策略。部署后使用 `openclaw skills list --agent <agent> --json` 检查技能来自该 agent 的 workspace，且依赖已满足。普通文件技能默认由 watcher 刷新；既有会话仍应确认技能已刷新，或使用新会话验证。

配置变更后推荐设置 `deploy.shared.options.restartGateway: true`，所有 agent 处理完成后统一重启一次，再验证和注册。

私网 endpoint 需要显式信任，并且必须与策略中的 endpoint 精确匹配：

```yaml
deploy:
  shared:
    networkPolicy:
      enabled: true
      dir: ./policies
      trustedPrivateHosts:
        - api.corp.example
        - 192.168.0.165
```

策略目录整体通过 `nemoclaw <sandbox> policy add --from-dir ... --trusted-private-host ... --yes` 应用，单文件使用 `--from-file`。不会自动信任私网地址或重写用户 policy。自定义 policy 中不能使用 loopback；主机服务示例使用 `host.openshell.internal`，实际 URL、服务监听和网络策略必须相互匹配。

自定义策略在 sandbox 预检查通过后立即应用，早于 agent 创建、内容上传、插件安装和 channel 配置。这样后续步骤失败时不会漏掉策略应用。日志列出策略文件和 NemoClaw 的处理结果；策略应用失败则立即停止，后续 agent 和插件步骤不会执行。`--dry-run` 和安装入口的 `--prepare-only` 仍只展示计划，不应用策略。

IEMS 安装包包含 4 份业务策略，由 `deploy.shared.networkPolicy.dir: ./policies` 加载。旧包部署中断后，可先在解压后的 IEMS 目录补应用，再查看实际生效状态：

```bash
nemoclaw ec policy add --from-dir ./policies \
  --trusted-private-host 172.21.92.121 \
  --trusted-private-host 192.168.0.165 --yes
nemoclaw ec policy list
```

`ec` 和两项私网地址来自随包配置，使用其他配置时应替换为对应值。此处只应用现有业务策略；npm 下载权限仍由 onboard 的内置 preset 或另行显式添加的 `npm_registry` 管理。

## IEMS 部署包

IEMS 业务部署目录单独提供，不随 CLI 源码仓库提交。将其放到本地 `iems/` 后，`iems/install.sh` 使用 `iems/onboard.yaml`，检查 Node/CLI 版本后直接运行完整部署。agent 内容直接使用 `iems/ienergy-genai-archive/templates/copilot`，12 个 skills 已放在该目录的 `skills/` 下，随 agent 内容一起上传。

独立部署时，使用现有 IEMS 部署目录中的 `iems/onboard.yaml`，按目标环境调整模型 API key、业务服务地址和资源路径，并带上 `ienergy-query` 可执行文件。真实配置、二进制和原始压缩包均已加入 Git 忽略规则。

两个已启用 agent 内容上传的业务 agent 使用各自 workspace；第三个 agent 保持原来的内容上传禁用设置。`ienergy-query` 只上传一次到 `/sandbox/.local/bin/ienergy-query`，随后检查 Linux x86-64 架构、执行权限和 PATH。业务 env 已为启用的 agent 打开。网络策略保留原 endpoint，只添加必要的私网信任配置。

在发布新版 npm 包前，可以使用本地安装包：

```bash
npm ci
npm test
npm pack
PACKAGE_SPEC="$(pwd)/advantech-axa-nemoclaw-deploy-0.0.9.tgz" bash iems/install.sh
```

已安装 CLI >=0.0.9 后预览：

```bash
bash iems/install.sh --non-interactive --dry-run
```

也可以直接运行 `nemoclaw-deploy up --config iems/onboard.yaml`。实际非交互 onboard 需要按原规则显式设置 `onboard.options.acceptThirdPartySoftware: true`。真实 API key 继续保存在用户自己的配置中，不要提交到 Git 或打包发布。

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
  version: v0.0.139

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

## Dashboard 远程访问

```yaml
onboard:
  mode: ensure
  sandbox:
    name: demo
  services:
    dashboardRemoteAccess: true
    dashboardPort: null
```

`dashboardRemoteAccess` 只接受 YAML 布尔值 `true` / `false`，不要写成字符串。`true` 会向主机上的 NVIDIA 安装器、`nemoclaw onboard`、状态检查及整个 `deploy` 流程（包括 dashboard-url、gateway restart 和清理）传入 `NEMOCLAW_DASHBOARD_BIND=0.0.0.0`。单独执行 `nemoclaw-deploy deploy --config onboard.yaml` 也会读取这个开关，不依赖之前是否执行过 `up`。

模板默认 `false`，会清空子进程继承的同名变量，使用 NemoClaw 官方默认监听行为：非 WSL 为 loopback，WSL 仍遵循官方的 Windows 主机可达性行为。显式布尔开关的优先级高于 `onboard.environment.NEMOCLAW_DASHBOARD_BIND` 和当前 shell 的同名变量。省略开关时兼容旧配置，依次读取上述 YAML 环境变量、shell 环境变量；都未设置时不开启远程监听。原始变量只允许空值或 `0.0.0.0`；不要使用 `127.0.0.1` 表示关闭，官方 onboard 会拒绝该值。

变量仅在本次命令作用域内传递，不写入 shell 配置。之后手动连接时仍需：

```bash
NEMOCLAW_DASHBOARD_BIND=0.0.0.0 nemoclaw demo connect
```

NemoClaw v0.0.139 会把转发监听地址设为 `0.0.0.0:<端口>`，但未设置外部浏览器 URL 时，`dashboard-url` 仍默认返回 `http://127.0.0.1:<端口>/...`。远程浏览器需使用主机实际 IP/域名，并保留相同端口和认证信息；不要公开带 token 的 URL。此开关不会把 advbot 的 `gatewayUrl` 改成 `ws://0.0.0.0`，监听地址不能代替客户端连接地址。

已有 sandbox 若创建时没有开启，需先备份再显式使用 `onboard.mode: recreate`；官方需要在创建时准备远程访问配置。`mode: ensure` 会跳过已可用 sandbox，CLI 会提示该限制，不自动重建。将开关改为 `false` 也不会主动停止已有监听进程或撤销 sandbox 创建时生成的认证配置；它只影响接下来启动的命令。

依据：[NVIDIA 环境变量说明](https://docs.nvidia.com/nemoclaw/user-guide/openclaw/reference/commands#environment-variables)、[v0.0.139 Dashboard 地址实现](https://github.com/NVIDIA/NemoClaw/blob/v0.0.139/src/lib/dashboard/contract.ts)。

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

`templates/install-and-up.sh` 没有随包 CLI 时优先复用脚本 prefix，其次复用 PATH 中版本 >=0.0.9 的 CLI；有随包 CLI 时验证 `packages/SHA256SUMS` 并按包内容 hash 复用，自动识别同版本修复。安装使用独立目录和原子入口切换，失败保留旧版本；同一 prefix 通过 `flock` 防止并发安装。设置 `FORCE_CLI_INSTALL=1` 可强制重装，`PACKAGE_SPEC=/path/package.tgz` 和可选 `PACKAGE_SHA256` 可指定本地包。`NPM_OFFLINE=1` 禁止 npm 联网：IEMS CLI 已携带按锁文件安装的生产依赖，可无缓存安装；其他自定义包仍可能需要缓存。

`--prepare-only` 安装 Node.js/CLI 并校验完整计划，不安装 NemoClaw 或创建 sandbox；`--dry-run` 不安装任何依赖，需要已准备的 CLI。`--config` 在环境准备前解析，未知参数直接失败。`up` 会提前检查本地内容、skills、上传文件、OpenClaw partial 和 policy，避免在创建 sandbox 后才发现本地文件问题。

NVIDIA 入口脚本支持 `NEMOCLAW_INSTALLER_FILE` 和可选 `NEMOCLAW_INSTALLER_SHA256`，先检查非空、Bash 语法和校验值，再执行；这不会取消官方脚本内部的联网下载。已有但无法报告版本的 NemoClaw 会按安装策略修复，安装后优先选择达到目标版本的入口，避免旧 PATH 遮蔽。

IEMS 包可用 `npm run bundle:iems` 从源码重新生成：同步模板、打包 CLI、生成两级 SHA256、排除运行缓存，解压后逐文件校验，成功后再替换 ZIP。安装只自动验证 CLI checksum，现场修改业务配置不影响此检查。

## NemoClaw 版本和模型

```yaml
install:
  enabled: true
  mode: if-missing
  version: v0.0.139

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

### 配置模型 API key

对于 `custom` 等需要模型凭据的 provider，直接在 YAML 中配置：

```yaml
onboard:
  inference:
    provider: custom
    model: qwen3.6-35B
    endpointUrl: https://ai.example.com/v1
    apiKey: "your-api-key"
```

CLI 只读取 `onboard.inference.apiKey`，不会额外弹出 API key 输入框，也不会把该值输出到计划或日志。对于 `provider: custom`，CLI 会将其映射到 NemoClaw 使用的 `COMPATIBLE_API_KEY`；`anthropicCompatible` 会映射到 `COMPATIBLE_ANTHROPIC_API_KEY`。包含真实 key 的 YAML 应仅保存在本机，不要提交到版本库。

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

      # skills 放入 agentContent.hostDir 下的 skills/，与内容一起上传。

      channelRegistration:
        enabled: false
        agentLabel: ""
        continueOnError: true

      env:
        enabled: true
        directory: ""
        targetFile: .env
        variables:
          APP_ENV: production
```

`workspace: ""` 默认使用 `/sandbox/.openclaw/workspace/${agentName}`。如果 agent 已存在，CLI 会读取 OpenClaw 中的实际 workspace，并将后续上传、env 和命令操作切换到该路径。

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

partial 中适合配置 `models`、`channels`、`mcp`、`session`、`tools`、`cron` 和 `env`。不允许包含 `agents`；其他 OpenClaw 业务字段（包括 channel 的 `secret`）会直接合并，CLI 不额外拦截。省略的现有字段会保留，配置验证失败时会自动回滚。包含真实凭据的 partial 不要提交到版本库，并应限制本地文件权限。

配置写入后会重新读取 sandbox 中的文件，核对 partial、插件、agent model 和 channel 是否完整保存；验证或 advbot 账号识别失败时回滚配置。全部操作和网关重启结束后还会再核对一次配置，若配置被其他命令修改或丢失，部署会明确报错，不会显示成功。临时核验文件仅保留在 sandbox，完成后清理。

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
        # 留空时默认使用 onboard.sandbox.name
        agentLabel: ""
        continueOnError: true
```

注册请求为：

```http
POST <channelServer.url>/v1/openclaw/agents
Content-Type: application/json

{"agent_id":"my-agent","agent_label":"demo"}
```

`agentLabel` 留空时默认使用 `onboard.sandbox.name`。`continueOnError` 默认为 `true`：注册请求失败时记录 `failed-continued` 并完成部署。设为 `false` 时，curl 预检查或注册请求失败会立即终止部署。

ChannelServer 集成还会自动获取 gateway token 和 gateway URL，只补充 `channels.advbot.accounts.<advbotAccountId>` 的动态连接字段。

重复部署也会重新获取当前 gateway 信息，再检查已有账号是否匹配。动态字段优先于 partial 中的同名字段，避免旧 token 或旧 URL 被重新合并回来。核验使用 `openclaw channels list --all --json` 返回的实际账号列表，不会把插件日志中出现 `advbot` 当作配置成功。主机上的 partial 不会被修改或写入自动获取的 token。

## 常用开关

- `deploy.shared.channelServer.enabled: false`
- `deploy.shared.networkPolicy.enabled: false`
- `deploy.shared.openclawConfig.enabled: false`
- `deploy.shared.options.restartGateway: true`
- 不上传 skills 时，从 agent 内容中移除 skills/，或在 agentContent.ignore 中排除它。
- `deploy.agents[].sandbox.uploads.enabled: false`
- `deploy.agents[].sandbox.commands.enabled: false`
- `deploy.agents[].channelRegistration.enabled: false`

## 安全提示

- `onboard.inference.apiKey` 和 partial JSON 可以保存业务所需凭据，但包含真实值的配置文件不要提交到版本库。
- `--dry-run` 不执行真实安装、上传、命令或外部请求。
- 所有外部命令均经过统一执行器并进行敏感参数脱敏。
