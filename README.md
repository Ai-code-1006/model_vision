# model-vision

> 配合 [cc-switch](https://github.com/nicepkg/cc-switch) 使用的 非Claude Code模型 图片处理技能。通过本地代理自动拦截图片请求，分流到视觉模型分析，再将文字结果注入主模型推理。

## 工作原理

```
用户发送图片（聊天粘贴 / 拖拽 / 本地文件）
    │
    ▼
router（本地代理 :15722）
    │ 检测到图片
    ▼
视觉模型（如 mimo-v2.5）── 分析图片，返回文字描述
    │
    ▼
注入 system prompt + 移除图片
    │
    ▼
cc-switch（:15721）── 转发
    │
    ▼
主模型（如 mimo-v2.5-pro）── 基于文字描述回答
```

## 前置依赖

| 依赖 | 说明 |
|------|------|
| [cc-switch](https://github.com/nicepkg/cc-switch) | Claude Code 多 provider 切换工具，提供 API 路由和认证 |
| Node.js ≥ 18 | 运行代理服务器 |
| PowerShell 5.1+ | 启动脚本和计划任务（Windows） |

## 目录结构

```
model-vision/
├── README.md
├── SKILL.md
├── router/
│   ├── config.json          # 配置文件（模型、端口、提示词）
│   ├── proxy.js             # 代理服务器核心
│   ├── analyze.js           # 图片分析 CLI 入口
│   ├── launcher.js          # 后台启动器
│   ├── start.ps1            # 启动脚本
│   ├── stop.ps1             # 停止脚本
│   ├── register.ps1         # 计划任务注册 + VBS 生成
│   ├── core/
│   │   └── analyzer.js      # 图片分析核心库
│   └── logs/                # 运行日志（自动生成）
└── cli/
    └── vision.py            # 手动模式 CLI
```

## 安装

将本技能放到 Claude Code 的 skills 目录下：

```
~/.claude/skills/model-vision/
```

## 配置

编辑 `router/config.json`：

```json
{
  "listen_port": 15722,
  "cc_switch_port": 15721,
  "model_text": "mimo-v2.5-pro",
  "model_image": "mimo-v2.5",
  "image_max_tokens": 2048,
  "image_analysis_prompt": "请详细描述这张图片的全部可见内容，优先提取文字、界面结构、关键对象、颜色、布局、状态、异常提示以及和用户问题相关的信息。"
}
```

| 字段 | 说明 |
|------|------|
| `listen_port` | 代理服务器监听端口 |
| `cc_switch_port` | cc-switch 上游端口 |
| `model_text` | 主模型名称（处理文字推理） |
| `model_image` | 视觉模型名称（处理图片分析） |
| `image_max_tokens` | 视觉模型最大输出 token 数 |
| `image_analysis_prompt` | 默认图片分析提示词（无用户上下文时使用） |

### 替换视觉模型

`model_image` 支持任意兼容 Anthropic Messages API 的视觉模型。只需修改 config.json 中的模型名称：

```json
{
  "model_image": "claude-sonnet-4-6"
}
```

API 地址和认证信息从 cc-switch 的 provider 配置中自动读取，无需额外配置。

## 使用方式

### 方式一：自动模式（推荐）

启动代理后，Claude Code 中直接粘贴、拖拽或附带图片发送即可。代理会自动拦截图片请求，分流到视觉模型分析。

```bash
# 启动代理
powershell -NoProfile -ExecutionPolicy Bypass -File ~/.claude/skills/model-vision/router/start.ps1

# 停止代理
powershell -NoProfile -ExecutionPolicy Bypass -File ~/.claude/skills/model-vision/router/stop.ps1
```

代理启动后会自动将 `~/.claude/settings.json` 中的 `ANTHROPIC_BASE_URL` 指向自身，并持续监控确保不被覆盖。

### 方式二：手动模式

直接调用脚本分析本地图片文件：

```bash
python ~/.claude/skills/model-vision/cli/vision.py "<图片路径>" "[问题]"
```

示例：

```bash
python ~/.claude/skills/model-vision/cli/vision.py "C:\screenshots\error.png" "这个报错怎么修"
```

## 开机自启

运行一次注册脚本，即可设置开机自动启动 + 每 5 分钟保活：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File ~/.claude/skills/model-vision/router/register.ps1
```

注册后会创建：

1. **Windows 计划任务** `ClaudeModelRouter`：登录后 30 秒启动，之后每 5 分钟检查保活
2. **VBS 隐藏启动器** `start-hidden.vbs`：双击即可无窗口启动代理

取消自启：

```powershell
Unregister-ScheduledTask -TaskName "ClaudeModelRouter" -Confirm:$false
```

## 日志

日志文件位于 `router/logs/` 目录：

```
router/logs/
├── router-20260610.log      # 运行日志
└── router-20260610.err.log  # 错误日志
```

文件名按日期滚动，每天一个。查看实时日志：

```powershell
Get-Content ~/.claude/skills/model-vision/router/logs/router-$(Get-Date -Format 'yyyyMMdd').log -Wait
```

## 上下文感知

代理会自动从对话中提取用户最近的发言，生成上下文感知的提示词发送给视觉模型：

- **有用户文本** → 视觉模型收到用户的原话，重点分析与用户意图相关的图片内容
- **无用户文本** → 使用默认提示词，全面描述图片

## 常见问题

### 代理启动后 Claude Code 无法连接

检查 cc-switch 是否在运行：

```powershell
Get-NetTCPConnection -LocalPort 15721 -State Listen
```

### 图片分析超时

默认超时 180 秒。如果网络较慢，可在 `cli/vision.py` 中调整 `timeout` 参数。

### 如何确认代理正在运行

```powershell
Get-NetTCPConnection -LocalPort 15722 -State Listen
```

### 计划任务未生效

```powershell
Get-ScheduledTask -TaskName "ClaudeModelRouter"
```

如需手动触发：

```powershell
Start-ScheduledTask -TaskName "ClaudeModelRouter"
```

## License

MIT
