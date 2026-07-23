# Python Workspace 使用说明

本文说明 `nemoclaw-deploy` 中 Python workspace 的推荐用法，适用于多个 OpenClaw skill 共享同一个 Python 虚拟环境的场景。

## 核心思路

每个 agent 有自己的 workspace。Python 依赖统一安装到该 workspace 下的 `.venv`：

```text
/sandbox/.openclaw/workspace/<agent>/.venv
```

部署时 CLI 会写入 workspace `.env`：

```bash
WORKSPACE=/sandbox/.openclaw/workspace/<agent>
VIRTUAL_ENV=$WORKSPACE/.venv
PYTHON=$WORKSPACE/.venv/bin/python
```

OpenClaw 会加载 workspace `.env` 中的普通项目变量。因此 skill 中推荐直接使用：

```bash
"$PYTHON" path/to/script.py
```

不需要在 skill 中写 workspace 绝对路径，也不需要为每个 agent 安装全局 PATH 命令。

## onboard.yaml 关键配置

Python 示例模板在 [templates/onboard.full.yaml](../templates/onboard.full.yaml) 的 `deploy.agents[]` 中。

关键部分如下：

```yaml
env:
  enabled: true
  # 留空表示 agent workspace。
  directory: ""
  targetFile: .env
  variables:
    APP_ENV: production
    PYTHONUNBUFFERED: "1"
    PYTHONDONTWRITEBYTECODE: "1"
    PIP_DISABLE_PIP_VERSION_CHECK: "1"

sandbox:
  commands:
    enabled: true
    workingDir: ""
    items:
      - python3 -m venv "$VIRTUAL_ENV"
      - '"$PYTHON" -m pip --version'
      - >
        if [ -f requirements.txt ]; then
          "$PYTHON" -m pip install -r requirements.txt;
        else
          echo "requirements.txt not found, skip pip install";
        fi
```

`workingDir: ""` 表示依赖命令在 workspace 根目录执行。

## .venv 创建位置

模板使用：

```bash
python3 -m venv "$VIRTUAL_ENV"
```

由于 `VIRTUAL_ENV` 固定写成：

```text
$WORKSPACE/.venv
```

所以 `.venv` 总是在 workspace 根目录：

```text
/sandbox/.openclaw/workspace/<agent>/.venv
```

即使以后把 `sandbox.commands.workingDir` 改成 `app`，`.venv` 仍然会在 workspace 根目录，而不是 `app/.venv`。

## requirements.txt 查找位置

`requirements.txt` 按 `sandbox.commands.workingDir` 解析。

当前模板：

```yaml
sandbox:
  commands:
    workingDir: ""
```

所以默认查找：

```text
$WORKSPACE/requirements.txt
```

如果改成：

```yaml
sandbox:
  commands:
    workingDir: app
```

则查找：

```text
$WORKSPACE/app/requirements.txt
```

此时 `.venv` 仍然是：

```text
$WORKSPACE/.venv
```

## skill 中如何执行 Python

推荐 skill 中写：

```bash
: "${PYTHON:?PYTHON is not set; deploy with env.enabled=true first}"
"$PYTHON" scripts/demo.py
```

如果脚本放在 workspace 根目录：

```bash
"$PYTHON" demo.py
```

如果脚本放在 workspace 子目录：

```bash
"$PYTHON" tools/demo.py
```

不要在 skill 中写：

```bash
/sandbox/.openclaw/workspace/python-agent/.venv/bin/python demo.py
```

这种写法会和 agent 名、workspace 路径绑定，不适合复用。

## 脚本应该放在哪里

推荐把真正要执行的 Python 脚本放进 `agentContent.hostDir`，随 agent 初始化内容上传到 workspace，例如：

```text
templates/agent-content/
  scripts/
    demo.py
  requirements.txt
```

skill 只写“如何调用”的说明：

```bash
"$PYTHON" scripts/demo.py
```

这样 skill 本身保持轻量，依赖和脚本都属于当前 agent workspace，不会影响其他 agent。

如果你的 Python 代码是一个可复用包，也可以在依赖命令里安装：

```yaml
sandbox:
  commands:
    items:
      - python3 -m venv "$VIRTUAL_ENV"
      - '"$PYTHON" -m pip install -e .'
```

skill 中再调用：

```bash
"$PYTHON" -m your_package.demo
```

不建议让 skill 依赖自己安装目录里的 Python 脚本路径，因为安装后的 skill 目录通常不是一个稳定、易记、可跨 agent 复用的路径。

## 手动调试

如果你通过 `nemoclaw <sandbox> exec -- ...` 手动进 sandbox 测试，当前 shell 不一定已经加载 workspace `.env`。

可以手动执行：

```bash
cd /sandbox/.openclaw/workspace/<agent>
set -a
. ./.env
set +a
"$PYTHON" scripts/demo.py
```

如果经常需要手动调试，也可以在自己的 `agentContent.hostDir` 里放一个加载 `.env` 的 wrapper 脚本；但这不是部署器必须依赖的机制。

## 常见问题

### skill 中 `$PYTHON` 为空

确认：

1. `env.enabled: true`
2. 部署已经成功写入 workspace `.env`
3. 当前运行是 OpenClaw agent/skill 运行，而不是一个没有加载 `.env` 的手动 shell

手动 shell 可以先 `source` `.env`。

### requirements.txt 没有被安装

确认 `requirements.txt` 是否位于 `sandbox.commands.workingDir` 指向的目录。

默认 `workingDir: ""` 时，应放在：

```text
$WORKSPACE/requirements.txt
```

### pip 下载失败

确认当前 network policy 是否放行 PyPI 或你的内部包源。模板只负责执行 pip 命令，不会自动修改你提供的 policy。

### 多个 agent 会互相影响吗

不会。每个 agent 使用自己的 workspace：

```text
/sandbox/.openclaw/workspace/agent-a/.venv
/sandbox/.openclaw/workspace/agent-b/.venv
```

`.env`、`.venv`、`requirements.txt` 都是 workspace 级别的。

## 推荐检查命令

只看计划：

```bash
nemoclaw-deploy deploy --config templates/onboard.full.yaml --dry-run --non-interactive
```

实际部署：

```bash
nemoclaw-deploy deploy --config templates/onboard.full.yaml --non-interactive
```

部署后验证：

```bash
nemoclaw-deploy doctor --sandbox demo
```
