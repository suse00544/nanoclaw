# 飞书集成设置指南

本指南帮助你将 NanoClaw 接入飞书（Feishu/Lark）。

## 前置要求

- 已完成 NanoClaw 基础设置（Docker、Claude 认证等）
- 有飞书企业管理员权限（或个人开发者账号）

## 步骤 1：创建飞书自建应用

1. 访问 [飞书开放平台](https://open.feishu.cn/app)
2. 点击"创建企业自建应用"
3. 填写应用信息：
   - 应用名称：如 "NanoClaw 助手"
   - 应用描述：个人 AI 助手
   - 上传应用图标（可选）
4. 创建完成后，记录以下信息：
   - **App ID** (形如 `cli_xxx`)
   - **App Secret** (点击"查看"获取)

## 步骤 2：配置应用权限

在应用管理页面，完成以下配置：

### 2.1 添加机器人能力

1. 进入"添加应用能力" → 选择"机器人"
2. 配置机器人信息：
   - 机器人名称：如 "Andy"
   - 描述：AI 助手
   - 头像（可选）

### 2.2 配置权限范围

进入"权限管理"，添加以下权限：

**消息与群组权限：**
- `im:message` - 获取与发送单聊、群组消息
- `im:message:send_as_bot` - 以应用的身份发消息
- `im:chat` - 获取群组信息

点击右上角"申请权限"按钮提交审批（企业管理员需要审批）。

### 2.3 开启事件订阅

1. 进入"事件订阅" → "添加事件"
2. 订阅以下事件：
   - **接收消息 v2.0** (`im.message.receive_v1`)
   - 消息类型选择：文本、图片、文件、语音等

## 步骤 3：配置 Webhook 地址

### 3.1 确定回调地址

NanoClaw 的 webhook 服务默认监听端口 **3737**，回调路径为：

```
http://你的服务器IP:3737/feishu/webhook
```

**注意：**
- 如果 NanoClaw 运行在本地，你需要使用内网穿透工具（如 ngrok、cpolar）
- 飞书要求 webhook 地址必须是公网可访问的 HTTPS 地址

### 3.2 使用 ngrok 创建公网地址（开发测试）

```bash
# 安装 ngrok (macOS)
brew install ngrok

# 创建隧道
ngrok http 3737
```

复制 ngrok 提供的公网地址（形如 `https://xxx.ngrok.io`）。

### 3.3 配置飞书 Webhook

1. 在飞书开放平台，进入"事件订阅"
2. 配置请求地址：
   ```
   https://xxx.ngrok.io/feishu/webhook
   ```
3. 复制页面显示的：
   - **Verification Token**
   - **Encrypt Key**（如果启用了加密）

## 步骤 4：配置 NanoClaw

### 4.1 编辑 .env 文件

在 NanoClaw 目录下，编辑 `.env` 文件，添加：

```bash
# 飞书机器人配置
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=你的App Secret
FEISHU_VERIFICATION_TOKEN=你的Verification Token
FEISHU_ENCRYPT_KEY=你的Encrypt Key（可选）
FEISHU_WEBHOOK_PORT=3737
```

### 4.2 同步到容器环境

```bash
mkdir -p data/env
cp .env data/env/env
```

### 4.3 重新构建并启动

```bash
npm run build

# macOS
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist

# Linux
systemctl --user restart nanoclaw
```

## 步骤 5：注册飞书聊天

### 5.1 获取 Chat ID

1. 在飞书中，进入要使用的群组或个人聊天
2. 添加你的机器人到群聊（如果是群组）
3. 发送任意消息给机器人
4. 查看 NanoClaw 日志：
   ```bash
   tail -f logs/nanoclaw.log
   ```
   日志中会显示 "Message from unregistered Feishu chat"，记录其中的 `chatJid`（格式：`fs:oc_xxx`）

或者，你可以通过飞书 API 获取：
```bash
# 获取当前用户的所有聊天
curl -X GET "https://open.feishu.cn/open-apis/im/v1/chats" \
  -H "Authorization: Bearer YOUR_USER_ACCESS_TOKEN"
```

### 5.2 注册聊天

使用 setup 脚本注册飞书聊天：

**注册为主聊天（响应所有消息）：**
```bash
npx tsx setup/index.ts --step register \
  --jid "fs:oc_xxx" \
  --name "飞书助手" \
  --folder "feishu_main" \
  --trigger "@Andy" \
  --channel feishu \
  --no-trigger-required \
  --is-main
```

**注册为普通聊天（需要触发词）：**
```bash
npx tsx setup/index.ts --step register \
  --jid "fs:oc_xxx" \
  --name "工作群" \
  --folder "feishu_work" \
  --trigger "@Andy" \
  --channel feishu
```

## 步骤 6：测试

1. 在飞书中向机器人发送消息
2. 机器人应该会响应（如果配置为主聊天）
3. 或者发送带触发词的消息：`@Andy 你好`

查看日志排查问题：
```bash
tail -f logs/nanoclaw.log
```

## 常见问题

### Webhook 验证失败

**问题：** 飞书显示 "URL 验证失败"

**解决：**
1. 确保 NanoClaw 服务正在运行
2. 确保 webhook 地址可以从公网访问
3. 检查 `FEISHU_VERIFICATION_TOKEN` 配置是否正确
4. 查看 NanoClaw 日志中的错误信息

### 机器人不响应

**问题：** 发送消息后机器人没有反应

**解决：**
1. 检查聊天是否已注册：
   ```bash
   sqlite3 store/messages.db "SELECT * FROM registered_groups WHERE jid LIKE 'fs:%'"
   ```
2. 检查机器人是否收到事件（查看日志）：
   ```bash
   grep "Feishu message" logs/nanoclaw.log
   ```
3. 如果是群聊，确保机器人已被添加到群中
4. 检查应用权限是否已审批通过

### 只能在群聊中使用 @提及

**问题：** 机器人只响应 @提及的消息

**原因：** 这是你的配置选择。如果你注册时没有使用 `--no-trigger-required`，机器人就只会响应带触发词的消息。

**解决：** 如果希望响应所有消息，重新注册该聊天并添加 `--no-trigger-required --is-main` 参数。

### 图片/文件无法查看

**当前限制：** 飞书通道目前只处理文本消息。收到图片、文件等会显示为占位符（如 `[图片]`）。

如需完整的多媒体支持，可以：
1. 参考 WhatsApp 集成的图片处理代码
2. 使用飞书 API 下载附件并传递给 Claude

## 生产环境部署

### 使用反向代理（推荐）

而不是直接暴露 webhook 端口，建议使用 Nginx/Caddy 作为反向代理：

**Nginx 配置示例：**
```nginx
server {
    listen 443 ssl;
    server_name your-domain.com;

    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location /feishu/webhook {
        proxy_pass http://127.0.0.1:3737;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

然后在飞书配置中使用 `https://your-domain.com/feishu/webhook`。

### 修改 Webhook 端口

如果 3737 端口被占用，修改 `.env` 中的 `FEISHU_WEBHOOK_PORT`：

```bash
FEISHU_WEBHOOK_PORT=8080
```

重启服务后，webhook 地址变为 `http://your-ip:8080/feishu/webhook`。

## 进一步定制

- 修改 `src/channels/feishu.ts` 可以添加更多飞书特性
- 参考 `src/channels/telegram.ts` 了解如何处理图片、文件等
- 查看 [飞书开放平台文档](https://open.feishu.cn/document/) 了解更多 API

## 移除飞书集成

```bash
# 1. 删除代码文件
rm src/channels/feishu.ts src/feishu-webhook.ts

# 2. 从 channels/index.ts 移除导入
# 删除 import './feishu.js'; 这一行

# 3. 移除依赖
npm uninstall @larksuiteoapi/node-sdk

# 4. 清理数据库
sqlite3 store/messages.db "DELETE FROM registered_groups WHERE jid LIKE 'fs:%'"

# 5. 重新构建
npm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
# systemctl --user restart nanoclaw  # Linux
```
