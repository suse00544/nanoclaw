# Apple 验证码中转

一个零第三方运行时依赖的 Node.js 小服务。iPhone 快捷指令只上传短信中的六位验证码；服务把验证码短暂保存在内存中，并通过飞书通知研发。查询页需要令牌，验证码领取一次或到期后立即删除。

## 工作流

1. 研发在 Apple 登录页请求短信验证码。
2. iPhone“信息”自动化只提取六位数字，经 HTTPS `POST /ingest` 上传。
3. 服务向指定飞书群发送“验证码已更新”的查询链接，消息中不包含验证码。
4. 第一位点击“领取并销毁验证码”的成员看到验证码；之后访问返回 `410`。

默认有效期为 300 秒。服务不使用数据库，重启也会清空尚未领取的验证码。

## 服务器部署

要求 Node.js 20+，并准备一个已启用 HTTPS 的域名。不要把服务的 `8791` 端口直接暴露到公网。

```bash
sudo useradd --system --home /nonexistent --shell /usr/sbin/nologin apple-code-relay
sudo install -d -o root -g root -m 0755 /opt/apple-code-relay
sudo install -o root -g root -m 0644 server.mjs /opt/apple-code-relay/server.mjs
sudo install -o root -g root -m 0600 apple-code-relay.env.example /etc/apple-code-relay.env
openssl rand -hex 32
openssl rand -hex 32
```

把两次生成的不同随机值分别写入 `/etc/apple-code-relay.env` 的 `APPLE_CODE_INGEST_TOKEN` 和 `APPLE_CODE_VIEW_TOKEN`，并将 `APPLE_CODE_PUBLIC_URL` 改为真实 HTTPS 地址。

飞书通知二选一：

- 群自定义机器人：填写 `FEISHU_WEBHOOK_URL`。
- 复用 NanoClaw 自建应用：填写现有 `FEISHU_APP_ID`、`FEISHU_APP_SECRET` 和目标群的 `FEISHU_CHAT_ID`；机器人必须已加入该群并具有发消息权限。

安装并启动 systemd 服务：

```bash
sudo install -o root -g root -m 0644 apple-code-relay.service /etc/systemd/system/apple-code-relay.service
sudo systemctl daemon-reload
sudo systemctl enable --now apple-code-relay
curl http://127.0.0.1:8791/healthz
```

将 `nginx.conf.example` 按实际域名和证书路径合入 Nginx 配置，再从公网验证：

```bash
curl https://apple-code.example.com/healthz
```

## iPhone 快捷指令

在“快捷指令 → 自动化”中新建“信息”自动化：

1. 触发条件选“信息包含”，填写 `验证码`；如果 Apple 短信发送方固定，再同时限制发送人。
2. 运行方式选“立即运行”。
3. 添加“匹配文本”，输入正则 `(?<!\d)\d{6}(?!\d)`，输入选择收到的信息正文。
4. 添加“从列表中获取项目”，选择第一个匹配项。
5. 添加“获取 URL 内容”，URL 为 `https://你的域名/ingest`，方法为 `POST`。
6. 请求头添加 `Authorization`，值为 `Bearer <APPLE_CODE_INGEST_TOKEN>`。
7. 请求正文选择 JSON，字段名为 `code`，值选择第 4 步结果。

快捷指令只应上传匹配出的六位数字，不要上传完整短信。配置完成后先给手机发送一条格式相同的测试短信，确认飞书通知、领取和二次领取失效均符合预期。

## 本地测试

```bash
node --test server.test.mjs
```

也可以手动启动并上传测试码：

```bash
APPLE_CODE_INGEST_TOKEN=ingest-secret \
APPLE_CODE_VIEW_TOKEN=view-secret \
node server.mjs

curl -X POST http://127.0.0.1:8791/ingest \
  -H 'Authorization: Bearer ingest-secret' \
  -H 'Content-Type: application/json' \
  --data '{"code":"123456"}'
```

## 安全边界

- 查询链接中的查看令牌等同于临时保险箱钥匙，只能发送到严格受控的研发群；人员变动或链接泄露后立即轮换。
- 建议在 Nginx 前再加公司 VPN、IP 白名单或 SSO；仅凭链接令牌无法识别实际领取人。
- 不要记录 `/ingest` 请求体、`Authorization` 请求头或带 `token` 的完整 URL。
- 这只是过渡方案。长期应让每位研发使用自己的 Apple Account 和团队角色，减少共享主账号登录。
