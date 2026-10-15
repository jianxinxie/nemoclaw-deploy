# 当前实现说明

本文记录当前代码库已经实现的功能，以及大致实现方式。

## 已实现命令

- `nemoclaw-deploy`：默认进入完整 `up` 流程，先 bootstrap/onboard，再 deploy。
- `nemoclaw-deploy deploy`：把一个或多个 OpenClaw agent 部署到已有 sandbox。
- `nemoclaw-deploy bootstrap`：检查/安装 NemoClaw，并创建、恢复或重建 sandbox。
- `nemoclaw-deploy up`：先执行 `bootstrap`，成功后再执行 `deploy`。
- `nemoclaw-deploy doctor`：检查 Node.js、`nemoclaw` 命令和可选 sandbox 状态。
- `nemoclaw-deploy init-config`：生成统一 `onboard.yaml` 模板。

## 配置文件

- 只接受 `schemaVersion: 3` 的统一 `onboard.yaml`。
- `install` 和 `onboard` 管理主机、推理和 sandbox 生命周期，`deploy` 管理 sandbox 共享配置和 agent 列表。
- deploy 自动继承 `onboard.sandbox.name`，所有相对路径按统一配置所在目录解析。

## Bootstrap / Onboard

`init-config` 默认复制精简的 `templates/onboard.yaml`；`templates/onboard.full.yaml` 保留全部可选字段和功能示例。

`bootstrap` 会先解析 `onboard.yaml`，然后：

1. 查找本机是否已有 `nemoclaw`。
2. 如果缺少且允许安装，执行 NVIDIA 官方安装器：

   ```bash
   curl -fsSL https://www.nvidia.com/nemoclaw.sh | NEMOCLAW_INSTALL_TAG=v0.0.75 bash
   ```

   安装版本由 `onboard.yaml` 中的 `install.version` 固定，CLI 会通过 `NEMOCLAW_INSTALL_TAG` 传给官方安装器。若本机已有 `nemoclaw` 且语义版本低于配置版本，交互模式会询问是否更新，拒绝后继续后续流程；相同或更高版本不会触发安装。非交互模式自动更新旧版本，`reinstall` 模式始终显式重装。
   `onboard.services.openShellGatewayPort` 会映射为 `NEMOCLAW_GATEWAY_PORT`，用于固定 OpenShell gateway 端口；不配置时使用 NemoClaw 默认端口。CLI 会拒绝 dashboard 自动分配范围 `18789-18799`、默认推理/代理端口 `8000`、`11434`、`11435`，也会拒绝和其他已配置服务端口重复。
   `onboard.inference.endpointUrl` 会映射为 `NEMOCLAW_ENDPOINT_URL`。`onboard.inference.apiKey` 只从 YAML 读取，并在运行时注入到 NemoClaw 期望的 credential env，例如 `custom` -> `COMPATIBLE_API_KEY`，`anthropicCompatible` -> `COMPATIBLE_ANTHROPIC_API_KEY`；CLI 不会额外提示输入，日志会脱敏且不会打印真实 key。

3. 按 `onboard.mode` 处理 sandbox：
   - `ensure`：sandbox 可用就跳过。
   - `resume`：继续上次 onboard。
   - `fresh`：重新执行 onboard。
   - `recreate`：重建已有 sandbox。
4. 通过 `nemoclaw <sandbox> status --json` 验证 sandbox 可用。

非交互模式会提前检查必要字段，例如 provider 和第三方软件确认，避免执行到一半才失败。

## Deploy 流程

`deploy` 会先生成部署计划，再按顺序执行：

1. 校验所有 agent 属于同一个 sandbox，并且 agent 名称、workspace 不重复。
2. 执行 sandbox 预检查。
3. 创建或确认每个 agent。
4. 处理每个 agent 的初始化内容。
5. 按 `deploy.agents[].sandbox.uploads` 上传主机文件或目录到 sandbox。
6. 安装每个 agent 自己配置的 skills。
7. 安装 sandbox 共享 plugins。
8. 准备 ChannelServer 和 advbot 动态连接字段。
9. 合并 partial JSON、插件启用状态、ChannelServer 动态字段和显式 agent model，原子写入一次 `openclaw.json`。
10. 应用 sandbox 共享 network policies。
11. 按 `env.directory` 写入每个 agent 的 env 文件；未指定目录时使用 workspace。
12. 在配置的 sandbox 工作目录执行每个 agent 的 `sandbox.commands`。
13. 验证 agent 和 sandbox 状态。
14. 清理 sandbox 临时目录并按配置统一重启 gateway。
15. 为开启 `channelRegistration` 的每个 agent 调用 channel server 注册接口；失败时按 `continueOnError` 决定继续或终止。

## 关键实现

所有外部命令都通过 `runCommand` 执行。它基于 `execa`，默认注入 `NO_COLOR=1` 和 `TERM=xterm-256color`，支持 dry-run、超时、后台执行、交互执行和敏感信息脱敏。

agent content 不会直接上传覆盖 workspace。CLI 会先上传到 `/tmp/nemoclaw-deploy/<agent>/agent-content`，再在 sandbox 内执行合并脚本。支持 `ask`、`skip`、`backup`、`overwrite`、`fail` 冲突策略，并支持 ignore 规则。

每个 agent 的 skills 会从 `agents[].skill.hostDir` 中自动发现所有包含 `SKILL.md` 的目录，然后逐个执行：

```bash
nemoclaw <sandbox> skill install <skillDir>
```

network policy 支持单个 `.yaml/.yml` 文件或目录。目录模式会按文件名排序后逐个执行 `policy-add`。

agent env 会合并写入 `env.directory` 下的目标文件；目录未指定时默认写入每个 agent 的 workspace `.env`。工具会自动写入：

- `WORKSPACE`
- `VIRTUAL_ENV`
- `PYTHON`

同时会写入 `env.variables` 中的普通变量。`env.secrets` 已移除，secret 不应写入 YAML。

`sandbox.commands` 会在每个 agent 指定的 `workingDir` 下执行命令。执行时 CLI 会注入 `WORKSPACE`、`VIRTUAL_ENV`、`PYTHON`，并把 `$VIRTUAL_ENV/bin` 放到 `PATH` 前面。为避免 OpenShell exec argv 拒绝换行，CLI 会把每条命令写成 sandbox 临时脚本，上传到 `/tmp/nemoclaw-deploy/<agent>/sandbox-commands/` 后通过 `sh <script>` 执行。

OpenClaw 配置采用单次事务：先读取 agent 创建和插件安装后的最新 `openclaw.json`，再依次合并用户 partial、插件启用状态、ChannelServer/advbot 动态字段，并按 agent ID 设置显式 model。partial 是 `tools`、`channels` 等 OpenClaw 业务配置的唯一用户配置源，且不允许修改 `agents`，因此 workspace 等字段完全保留。写入使用同目录临时文件和原子 rename，写前保留临时备份；`openclaw config validate` 失败时自动回滚。

plugins 会读取 `openclaw plugins list --json` 并安装缺失插件；统一事务只负责启用已安装插件，不再接收 plugin item 内的 channel 配置。ChannelServer 集成会自动获取 gateway token 和 URL，并只补充 `channels.advbot` 中必须动态生成的连接字段。

`sandbox.uploads` 同时支持主机文件和目录。文件会直接上传并验证目标；目录先上传到 agent 临时目录，再由 sandbox 内脚本递归合并。`overwrite=false` 会先完成全量冲突扫描，避免上传到一半才失败；`overwrite=true` 覆盖冲突项并保留目标目录额外内容。channel registration 通过统一 `runCommand` 调用主机 `curl`，非 2xx 响应会使部署失败。

## 安全边界

- 日志中会脱敏 gateway token、常见 token/secret/password 和 npm token。
- YAML 不允许保存 secret env。
- openclaw partial 不允许包含 agents；其他 OpenClaw 业务字段由 CLI 直接合并，不额外拦截 secret 等字段。
- `onboard.environment` 只允许非敏感 `NEMOCLAW_*` 变量。
- `--dry-run` 只打印计划和命令，不执行真实操作。
- 多 agent 部署是 additive 行为：会创建缺少的 agent，不会删除配置外已有 agent。
