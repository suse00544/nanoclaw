---
name: tada-restoration-bugs
description: 飞书群聊「地图整体还原」bug 录入技能。负责在用户明确 @Beacon 或明确要求录入时，把 Tada 团队飞书群聊里的地图还原类 bug 录入到飞书 Bitable「🌏地图整体还原-260724」表，并按严格规则做图文配对、严重程度、问题分类。当用户提到「录入bug」「录入问题」「还原问题」「地图整体还原」「录一个」「@Beacon 录入」时触发。没有 @Beacon 的群聊消息只作为上下文，不主动回复、不主动录入。**绝对不要**在不确定的时候瞎匹配图文，宁可问。
version: 1.0.0
---

# tada-restoration-bugs

把 Tada 团队飞书群聊里的「地图整体还原」bug 录入到飞书 Bitable 的标准工作流。

## 目标位置

- **Base token**: `WajIbt3meaqG6TsqL8OcY3XRnQI`
- **Table ID**: `tblCVssUbWnAlY9j` (子表名「🌏地图整体还原-260724」)
- **View**: `vewGfp655v`

## 字段 schema（与「异步生成及消息追加」表同 Base 共享字段 ID）

| 字段 ID | 名称 | 类型 | 说明 |
|---------|------|------|------|
| `fldyzowi2O` | 当前问题描述 | text (primary) | bug 标题（最重要字段） |
| `fldFXrG4k5` | 当前表现详情 | text | 实际看到的情况 |
| `fldwkgcgfe` | 设计预期 | text | 设计想要的效果（如有） |
| `fldD2NiwVI` | 严重程度 | select | P00 / P0 阻塞体验 / P1 明显偏差 / P2 普通偏差 / P3 观察项 |
| `fldoSejd4O` | 跟进人 | user, multiple | 默认 @林智（`ou_089e5f97fb707c903e2616d3074d503c`） |
| `fldiHhh5JV` | 问题状态 | select | 待讨论 / 在做了别催 / 未修复 / 已修复待验收 / 重复 |
| `fldCF9H62a` | 实际截图 | attachment | bug 截图 |
| `fldgnTJ9ac` | 设计截图 | attachment | 设计参考截图（如有） |
| `fldMZMhcDQ` | Figma 节点链接 | url | |
| `fldtvcQ2zZ` | 疑似代码位置 | text | |
| `问题分类` | 问题分类 | select | 前端问题 / Agent 问题（自建字段，7/24 加的） |

select 选项与「异步生成」表完全一致。问题分类是自加字段，可能需要在首次录入前用 `field-create` 建好。

## lark-cli 命令约定

**所有命令必须**：
- 在 v2 群聊/定时任务中使用共享 Beacon 应用身份：显式加 `--as bot`
- 在 `/workspace/agent` 目录下跑；临时 JSON、下载图片等工作文件放 `/workspace/agent/.lark-work/`
- 不使用 `lark-cli-user`，也不使用任何群成员的用户 OAuth
- 如果返回 `91403` / `1254302` / `User has no share permission`，停止重试并说明这是 Base 资源权限问题，不是 CLI 身份问题：
  - 当前 bot 应用身份必须以 `lark-cli whoami --as bot` 的返回为准。Beacon 生产应用是 `cli_a938785ea638dbd7`；不要使用个人 CLI 应用 `cli_a95f6c0ef3385ccf` 访问公司共享资源。
  - 需要在目标多维表格右上角「... / 分享 / 添加文档应用」中添加这个 Beacon 应用，并给可编辑权限。
  - 如果多维表格开启了高级权限，只加文档协作者还不够，还要在高级权限/权限组里把 Beacon 应用加入具备新增记录权限的角色；必要时给可管理权限。
  - 不要把问题归因成 SDK parser bug，除非同一个调用已经确认拿到的是非 JSON 响应或 CLI 自身崩溃。

```bash
# 列表
cd /workspace/agent && lark-cli base +record-list \
  --base-token WajIbt3meaqG6TsqL8OcY3XRnQI \
  --table-id tblCVssUbWnAlY9j \
  --limit 200 --format json \
  --as bot

# 创建
cd /workspace/agent && lark-cli base +record-batch-create \
  --base-token WajIbt3meaqG6TsqL8OcY3XRnQI \
  --table-id tblCVssUbWnAlY9j \
  --json @.lark-work/bugs-batch-N.json \
  --as bot

# 上传图片
cd /workspace/agent && lark-cli base +record-upload-attachment \
  --base-token WajIbt3meaqG6TsqL8OcY3XRnQI \
  --table-id tblCVssUbWnAlY9j \
  --record-id <record_id> \
  --field-id fldCF9H62a \
  --file ./.lark-work/images/<file>.png \
  --as bot
```

## 录入流程（核心规则）

### 1. 识别「地图整体还原」类 bug

只录「地图整体还原」相关话题。忽略其他话题（如性能优化、纯后端、文档等）。

识别特征：
- 涉及地图组件、POI、marker、路线、tab 切换、海外地图、本地化等
- 通常是「文字描述 + 截图」组合

### 2. 图文配对 —— 「上图下文」规则（最关键！）

**每张图配它下面紧接的那段文字，不是上面那段。**

正确解读：
- 7/24 Sphere 原话："我基本都是按照上图下文的方式给你的" 和 "后续我提供的消息都是上图下文的方式"
- 当一条消息只包含一张图（无配文），其配文是下一条消息中的文字
- 当一条消息同时包含图和文字，文字是该图的描述
- 跨多条消息的图片，按时间顺序依次对应

**做配对前**必须用 conversation transcript 时间戳重建完整的 [时间, 发送方, imgs[], text] 序列，再按上图下文规则配对。**不要凭印象**乱配。

### 3. 严重程度 —— 不预判，默认 P0

**7/24 Sphere 明确要求：严重程度我不预判，默认全部 P0 阻塞体验，后续她定级。**

不要按 bug 类型给建议值（不要 UI bug 给 P2、崩溃给 P00 之类），一律 P0。

### 4. 问题分类 —— 前端 vs Agent

默认 `前端问题`。以下情况标 `Agent 问题`：
- Bug 标题或描述里 Sphere 明确说了「agent 体验」「agent 该出...」「agent 说是...」

判断示例：
- "Agent 体验：POI 不出图，猛猛出字" → Agent 问题
- "Agent 该出路线/地图组件时却出代码块+追问" → Agent 问题
- "Agent 描述路线时只口喷文字，不出路线图组件" → Agent 问题
- "Agent 说是两张地图，实际只渲染一个伊斯坦布尔地图组件" → Agent 问题
- "POI 数量在 agent 对话和路线模式不一致（聊 6 / 路线 4）" → Agent 问题（以"agent"开头）
- "Thinking 73.3 秒巨久" → Agent 问题（thinking 是 agent 概念）
- "Agent 都已经回复完了，输入框还在等待态" → 标题含 Agent 但本质是 UI 状态同步，**前端问题**

不确定时，先标「前端问题」，进群问一句「这条是 agent 问题还是前端问题？」不要瞎猜。

### 5. 默认值

- 跟进人：`@林智` (`ou_089e5f97fb707c903e2616d3074d503c`) —— 大哥大（前端开发）
- 状态：`未修复`

### 6. 去重规则

- 「当前问题描述」>= 80% 相似视为重复
- 不自动合并/删除 —— 列疑似的，让 Sphere 自己 review

### 7. 视频附件陷阱（重要！）

**不要在没准备好下一步时就 `record-remove-attachment` 视频！**

- sandbox 里没有原始 .mp4/.mov 文件，只能 attach 已经下载到本地的视频
- `record-remove-attachment` 会让 file_token 失效，之后 `record-download-attachment` 会报 "not found in record"
- 流程：如果你不确定要不要换位置，**先下载视频到本地（记录路径）**，再 remove，最后 upload 到正确位置

## 响应风格 —— 静默周期

在 10/15 分钟定时巡查时：

- **无新 bug**：只输出 `<internal>` 块，**绝对不调 send_progress_update，不调任何 tool**
- **有 bug**：单次 `send_progress_update` + 列本轮录入清单，**不要再写普通文字回复**（会变两条消息）

**Critical**：tim 多次反馈"每条消息只发一次"。**send_progress_update 工具调用本身 = 一条消息，再写普通文字 = 第二条**。一次交互只选其一。

## 称呼

- Sphere/Bob（g2gdd638）=「大哥」
- Tim（7e59beaa）=「大哥」
- 林智/CC（c45955ge）=「大哥大」

## 录入后必做

每轮录入完成后，**只发一次** `send_progress_update`：

```
@Sphere 大哥 本轮录入 N 条：
- Bug #X <标题>（<图/无图>）
- Bug #Y <标题>...
当前 baseline = N 条，巡查 10 分钟一次继续跑着。
```

如果发现上一轮有图文配对错的情况，主动发起一次系统性重排（按 transcript 时间戳 + 上图下文规则），并在消息里说明。

## Badcase 清单（来自 7/24 实操）

避免重复犯以下错误：
1. **瞎配图文**（不看时序）—— 必须严格按 transcript 时间戳 + 上图下文规则
2. **同一标题跑多次 batch-create**（产生重复 record）—— 先 record-list 查一下，避免重复
3. **预判严重程度**（UI bug 给 P2 之类）—— 默认全部 P0 阻塞体验
4. **静默周期调 send_progress_update** —— 严格只输出 internal 块
5. **先 remove-attachment 视频再考虑** —— 先下载本地再说
6. **图文配对按"上一段文字"配** —— 是下一段，配反了就是系统性错位
7. **不确定的分类瞎猜** —— 宁可问一句，不要瞎标
