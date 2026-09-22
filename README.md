# dsh-session-mover

把 DSH 会话移动到任意工作区（或移回「未分组」），让它在目标工作区获得读写权限；
并支持原地「接续」已归档的会话。

## 为什么必须重启才生效

DSH 里一条会话属于哪个工作区，由两件事共同决定：

1. 工作区记录 `workspace.json` 的 `sessionIds` 包含它
2. 会话 header 的 `cwd` 规范化后 **等于** 工作区路径

也就是说「移动到工作区」= 改写会话 header 的 `cwd` **加上** 搬运它的物理目录
（目录名由 `projectKey(cwd)` 决定，后端靠 header.cwd 反算路径找文件）。
而 harness 运行期持有会话索引与文件锁，做不了这件事。

所以本插件采用 **排队** 模型：

1. 界面上选择目标 -> 写入 `queue.json`
2. 重启时 `一键启动DSH.bat` 先调用 `apply-queue.mjs` 消费队列
3. 队列执行完才拉起 harness

## 三种操作

| 界面按钮 | 效果 |
|---|---|
| 某个工作区 | 改写 cwd 到该工作区路径 + 搬目录 + 归入其 sessionIds |
| 移出到「未分组」 | 从所有工作区的 sessionIds 移除；cwd 不动 |
| 接续（取消归档） | 只把 id 从 `archivedSessionIds` 移除；不搬目录、不改 cwd、不动归属 |

## 文件

| 文件 | 作用 |
|---|---|
| `lib/core.mjs` | 帧级改写引擎：zstd 多帧扫描、projectKey、备份、校验 |
| `lib/host.js` | `/api/dsh-session-mover` 路由（state / queue / unqueue / clear） |
| `lib/client.js` | 会话头部「移至工作区」按钮与目标选择面板 |
| `../apply-queue.mjs` | DSH 启动前消费队列的执行器 |
| `backup/` | 每次迁移前的完整原件 |

## 安全设计

- 会话文件是多帧拼接的 zstd，header 独占第一帧；**只重压第一帧**，事件帧字节原样搬运
- 先写新文件 -> 重新解帧校验 cwd -> 通过才移除旧目录；任何一步失败都保留原样并报错
- 每次迁移前把整个会话目录复制到 `backup/<sessionId>__<timestamp>/`
- 改 `workspace.json` 前备份 `.bak`
- DSH 运行中执行器直接拒绝工作（靠 3080 端口探测）
- 队列执行失败的项目会保留在 `queue.json` 里，不会静默丢失

## 回滚

> 先 `cd` 到插件目录，或把下面内容保存为插件目录下的 `rollback.ps1` 再执行。

```powershell
# 插件目录：作为脚本运行时取脚本所在目录；直接粘贴运行时取当前目录
$pluginDir = if ($PSScriptRoot) { $PSScriptRoot } else { (Get-Location).Path }
# DSH 数据目录：优先读环境变量，否则取 ~/.dsh
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' }

# 单个会话：把备份拷回原 project 目录即可
$backupRoot = Join-Path $pluginDir 'backup'
$b = Get-ChildItem $backupRoot -Directory | Select-Object -First 1
$target = Join-Path $dshHome 'sessions\<原project目录>\<session目录>'
New-Item -ItemType Directory -Force -Path $target | Out-Null
Copy-Item (Join-Path $b.FullName '*') $target -Recurse -Force

# workspace.json 恢复最新的一份 .<时间戳>.bak
$ws = Join-Path $dshHome 'workspace.json'
$bak = Get-ChildItem (Split-Path $ws) -Filter ((Split-Path $ws -Leaf) + '.*.bak') |
       Sort-Object LastWriteTime -Descending | Select-Object -First 1
if ($bak) { Copy-Item $bak.FullName $ws -Force }
```
## 设计要求（来自使用者）

**对会话的任何操作，都必须先列明「是什么操作」，并且可以撤销。**

这条要求决定了本插件的交互形态：

- 所有操作**只入队、不立即生效**，界面顶部显式列出每一项：
  `[操作类型] 会话标题` + 具体目标 + 会产生什么后果
- 每一项都能**单条撤销**，也能**全部撤销**
- 撤销只改队列文件，**不触碰任何会话数据**
- 真正的落盘动作推迟到 DSH 停止之后（`apply-queue.mjs` 消费队列），
  且删除类动作也只是移入 `backup/deleted/`，可再捞回
## 自包含执行（不依赖外部启动脚本）

早期版本把队列执行挂在宿主的启动脚本上，那对分发是致命的 —— 别人不会去改脚本。
现在插件自己在启动早期消费队列：

- `inject = []`：不等任何服务，`apply` 被加载就立即执行
- 排在 `dsh.profile.bundles` 第 2 位（紧跟 `@deepseek-ai/dsh-base`）：确保早于会话索引建立
- 探测 `ctx.get('workspaceRegistry')`：未就绪 = 时机早，可安全改写；
  已就绪 = 跳过本次，避免「改了文件又被 DSH 内存状态覆盖」
- 路由注册延迟到 webServer 就绪（`ctx.inject(['webServer'], ...)`），不拖累启动早期执行

宿主启动脚本里的那一步**保留**作为兜底：两条路径消费同一个队列，执行完即清空，
重复调用是安全空操作。

### 判断时机是否够早

启动日志里会打印：

```
[dsh-session-mover] 启动时机探测: workspaceRegistry = 未就绪（早，可安全改写）；队列待执行 3 项
```

- **未就绪（早）** → 正常，队列当场执行
- **已就绪（偏晚）** → 需要把本插件在 `dsh.profile.bundles` 里的位置继续前移
  （越靠前越好，紧跟 `@deepseek-ai/dsh-base`）

### 为什么必须抢早期

改写会话 `cwd` 要搬动物理目录；一旦 DSH 建好会话索引，之后改文件会与内存状态
冲突（表现为「改动被写回」—— 早期那 15 个归档被还原就是这么发生的）。
## 独立分发说明

本插件**不需要修改宿主的任何文件**即可工作。队列的消费由插件自己在两个时机完成：

1. **启动早期** —— 若加载得够早，日志会打印 `boot timing: ... absent (early, safe to rewrite)`
2. **harness 退出时** —— 兜底路径，覆盖加载偏晚的情况（退出阶段 registry 已不再写盘）

因此它**不依赖**任何外部启动脚本，也不需要用户手工执行命令。
两条路径消费同一个队列，执行完即清空，重复触发是安全空操作。

### 安装

1. 把本包放到任意目录（例如 `<你的目录>\dsh-session-mover`）
2. 编辑 profile 的 `package.json`：
   - `dependencies` 增加 `"dsh-session-mover": "link:<本包绝对路径>"`
   - `dsh.profile.bundles` 数组里加入 `"dsh-session-mover"`
3. 重启 DSH

> 建议把 `dsh-session-mover` 放在 `dsh.profile.bundles` 的**靠前位置**
> （紧跟 `@deepseek-ai/dsh-base`）。放前面时队列在启动早期就被消费；
> 放末尾时会走退出兜底 —— 两种位置都是**一次重启即生效**，
> 区别只在日志措辞。

### 运行时数据（随插件目录生成，非包内容）

| 路径 | 用途 |
|---|---|
| `queue.json` | 待执行操作队列（由设置页写入） |
| `backup/<会话id>__<时间戳>/` | 迁移前的完整快照，可据此回滚 |
| `backup/deleted/<会话id>__<时间戳>/` | 「删除」的回收站，非物理删除 |

按方案 B，`workspace.json` 的快照与同会话的目录快照都会**自动轮替**，各自只留最新一份。