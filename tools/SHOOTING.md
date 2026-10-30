# SHOOTING · 13 张应用截图的拍摄说明

配套脚本：`tools\shoot.mjs`（Node ≥ 22，全局 WebSocket；本机 Node v24 可用）。
产出：`assets\` 下 13 张 PNG，宽高固定 **780×1688**（390×844 视口 @ deviceScaleFactor 2）。

```powershell
node 网页\companion-intro\tools\shoot.mjs   # 从工作区根目录跑；退出码 0 = 13 张全部生成且尺寸自检通过
```

## 0. 运行环境与已有产出

headless Chrome 需要正常的 Windows 命名管道 / 进程访问权限，**必须用有完整权限的终端跑**。
在 DSH 的 workspace-write 沙箱里 Chrome 起不来（不是脚本问题，实测报错）：

```
[ERROR:third_party\crashpad\crashpad\client\crashpad_client_win.cc:430] OpenProcess: 拒绝访问。 (0x5)
[FATAL:mojo\public\cpp\platform\platform_channel.cc:112] Check failed: . : 拒绝访问。 (0x5)
crash server failed to launch, self-terminating
```

**运行记录**：2026-10-28 在用户授权的完整权限下由 Lead 跑过一次，退出码 0，
13 张全部生成、尺寸自检 13/13（780×1688）。当前 `assets\` 里就是这一版；重跑会覆盖同名 13 张。

常量：静态服务 **8901**（root = `应用\companion-app`），CDP **9341**；
`SPRINT_START = "2026-10-13"`（计划第 1 天）、`EXAM_DAY = "2026-10-24"`（首场考试日）。
端口被占用时改脚本顶部 `PORT` / `CDP_PORT`。

## 1. 通用拍摄流程（脚本里已实现）

1. Node `http` 静态服务，root = 应用目录，`http://127.0.0.1:8901/index.html`。
2. `spawn` Chrome：`--headless=new --disable-gpu --no-first-run --no-default-browser-check
   --disable-extensions --disable-background-networking --window-size=390,844
   --user-data-dir=<临时目录> --remote-debugging-port=9341 URL`，`stdio:"ignore"`。
3. 轮询 `http://127.0.0.1:9341/json/list` 取 page target，连全局 WebSocket（极简 CDP 客户端）。
4. `Emulation.setDeviceMetricsOverride {width:390,height:844,deviceScaleFactor:2,mobile:true}`，
   再 `Page.enable` / `Runtime.enable` / `Log.enable`。
5. 等 `typeof importTasks === "function"`（页面加载完）。
6. `localStorage.clear()` → **先 `window.alert = () => {}`**（演示数据脚本结尾有 alert，不堵住会卡住）
   → `Runtime.evaluate` 整段求值 `应用\companion-app\tests\演示数据-一键填充.js`（IIFE，只读引用、不改它）。
   期望：今日计划 4 条、已完成 2 条、事项池 7 条、笔记 2 条（脚本会打印并在不符时报错）。
7. 每张图前：`#toast.classList.remove("show")`、`#errBar.classList.remove("on")`，等 450ms 再截。
8. 截图统一 `Page.captureScreenshot {format:"png"}`，**不带 captureBeyondViewport**；
   用 PNG 头（字节 16~23）读宽高自检 = 780×1688。
9. 全部拍完：`Browser.close` → `chrome.kill()` → `server.close()` → 删临时 profile，退出码 0/1。

**脚本内数据会重载 3 轮**（每轮都 `localStorage.clear()` 后重跑演示数据）：
初始一轮拍 hero / today-tasks → 重载并造「可支配 42 分钟」场景拍 suggest →
再重载一份干净演示数据，拍后面的页签 / 冲刺 / 设置 / 主题。

## 2. 13 张图各自怎么切

滚动统一用「元素 `scrollIntoView` 后 `window.scrollBy(0,-60~-70)`」：
顶部 `.top` 是 sticky（约 48px 高），偏移 60~70 让标题露在 header 下、不被盖住。

| # | 文件 | 视图 / 状态 | 操作与滚动 | 画面应包含 |
|---|---|---|---|---|
| 1 | `hero-today.png` | 今日（紫藤） | 点 `#tabToday` → `scrollTo(0,0)` | 品牌行、今日概览（4h25m / 2/4）、6 个页签、「今日空闲时间段」开头与任务 |
| 2 | `today-tasks.png` | 今日 | 把「今日计划」卡片滚到 header 下（`#taskList` 的 `.closest(".card")`，offset -60） | 「今日计划」+ 4 条任务，其中 2 条打勾、显示「实际 30m」「实际 50m（预计 1h）」 |
| 3 | `suggest.png` | 今日（42 分钟场景，见第 3 节） | 重载演示数据 → 造 42m 场景 → 段控 **精力=高 / 环境=室内** → 点 `#btnSuggest` → 把建议卡片滚上来（offset -60） | 当前可支配 **42m**；3 张建议卡（英语单词 / 读《被讨厌的勇气》/ 低冲击健身），每条带理由，含「**空窗 3 天了 / 歇了 3 天**」；底部露出「今天的都做完了」恢复类建议开头（真实行为） |
| 4 | `backlog.png` | 事项池 | 点 `#tabBacklog` → `scrollTo(0,0)` | 页签高亮、事项池 7 条（优先级/时长/精力/场景/截止或习惯标签） |
| 5 | `week.png` | 周视图 | 点 `#tabWeek` → `scrollTo(0,0)` | 本周统计（连续打卡/完成/完成率）+ 未来 7 天列表 |
| 6 | `schedule.png` | 作息 | 点 `#tabSchedule` → `scrollTo(0,0)` | 每周休息日选择 + 固定占用（工作日/休息日/每天分组） |
| 7 | `notes.png` | 记事 | 点 `#tabNotes` → `scrollTo(0,0)` | 类型段控、输入框、2 条演示笔记；内容短，下方留空属正常 |
| 8 | `sprint.png` | 冲刺·第 1 天 | `todayStr` 临时指到 `2026-10-13`、`state.date` 同 → 点 `#tabSprint` → **连续点前两个未勾考点**（进度 2/23）→ 把 `.sprint-head` 滚到 header 下（offset -70） | 日期 2026/10/13；冲刺头「2026年10月考期 · 冲刺11天 / 第 1 天 · 只背高频 · 距首场考试 11 天」；今日配额「已完成 **2/23**」；马原分组 2/7，前两条已勾 ✓；无「顺延」横幅 |
| 9 | `sprint-exam.png` | 冲刺·考试日 | `todayStr` 指到 `2026-10-24`、`state.date` 同 → 点 `#tabSprint` → 把 `#spExamCard` 滚到 header 下（offset -60） | 考试安排卡片（「今天 · 就是今天」马原/公司法 + 2026-10-25 近代史/英语二）+「今天的考试科目 · 考前扫一遍高频」清单 |
| 10 | `settings.png` | 今日 + 设置弹窗 | `todayStr` 还原、`state.date=today`、点 `#tabToday`、`scrollTo(0,0)` → `openSettings()` → 截弹窗 | 弹窗完整不裁切；「通用 → 界面颜色」四套皮肤（紫藤/青竹/暖阳/墨蓝），以及导入方式、鼓励频率、反馈入口。脚本会打印弹窗 `top/bottom/height/themes` |
| 11 | `theme-teal.png` | 今日顶部·青竹 | 关弹窗 → `applyTheme("teal"); render(); scrollTo(0,0)` | 同第 1 张，整体变青绿 |
| 12 | `theme-amber.png` | 今日顶部·暖阳 | `applyTheme("amber")` 同上 | 同第 1 张，整体变暖橙 |
| 13 | `theme-ink.png` | 今日顶部·墨蓝 | `applyTheme("ink")` 同上 | 同第 1 张，整体变墨蓝 |

拍完主题**必须还原** `applyTheme("violet")`（脚本已做），否则演示环境留在墨蓝。

## 3. 两个刻意的处理（都在脚本注释里）

- **冲刺页的 `todayStr`**：真实系统日期（2026-10-28）在考期之后，直接渲染会出「考试已结束」。
  脚本把页面内的 `todayStr` 临时指到 10-13 / 10-24（等价于在考试那天打开应用），拍完还原；
  只改页面运行时变量，不改应用文件。
- **建议图的 42 分钟场景**：拍完前两张后重载演示数据，再做四件事：
  1. `window.nowMin = () => 8*60+28`（固定“现在” = 08:28）；
  2. 把「英语单词」「读《被讨厌的勇气》」从今日计划移出、写进 `d.skipped`（防止 `autoGenHabits` 塞回）；
  3. 今日空闲片段改成 `06:25–09:10`（08:28 → 09:10 剩 42 分钟，扣掉已完成的两件事后「可支配 42m」）；
  4. 把「读书」的 `lastDone` 改成 3 天前。
  于是这两条 +「低冲击健身」成为候选（都能排进 42 分钟），理由里自然出现「断了 3 天」。
  脚本会断言：**建议卡 ≥ 3 张** 且理由里含「英语单词」+「3 天」，不满足直接报错。
- 段控这次点的是 **精力=高 / 环境=室内**（不是早期版本的「中/室内 + 高生成再切回中」绕法）。

## 4. 失败排查

| 症状 | 原因 / 处理 |
|---|---|
| Chrome 秒退，退出码 `-36863` 或非 0，日志有 `OpenProcess 拒绝访问` / `platform_channel.cc Check failed` | 被沙箱拦了命名管道/进程访问 → 换有完整权限的终端跑（见第 0 节；Lead 已跑通一次） |
| 连不上 `9341` / `没有页面 target` | 端口被占或 Chrome 没起来；改 `CDP_PORT`，确认 Chrome 路径 |
| 页面空白、`importTasks` 不存在 | 静态服务 root 不对 / 端口被占；确认 `APP_ROOT` 指向 `应用\companion-app` |
| `alert` 卡住不动 | 必须先执行 `window.alert=()=>{}` 再跑演示数据脚本（脚本已按此顺序） |
| 数据重复、越跑越多 | 演示数据写 localStorage；脚本每轮都 `localStorage.clear()` 且用全新临时 profile，正常不残留 |
| 截图上出现黑色 toast 药丸 | 每张截图前清 `#toast.show` 并等 450ms（脚本已做） |
| 标题被顶部栏盖住 | sticky 头约 48px；`scrollIntoView()` 后要 `scrollBy(0,-60~-70)`，再等 420ms |
| PNG 尺寸不是 780×1688 | 检查 `Emulation.setDeviceMetricsOverride` 的 dSF=2；不要用 `captureBeyondViewport` |
| settings 弹窗上下被裁 | 看脚本打印的 `top/bottom/height`；`top<0` 或 `bottom>844` 说明弹窗高于视口，需把弹窗内部改成可滚动再截（本版实测完整） |
| 建议图可支配不是 42m / 建议卡少于 3 / 理由缺「3 天」 | 检查 42 分钟场景那段：`window.nowMin` 覆盖、移出两条任务 + `d.skipped`、片段 `06:25–09:10`、读书 `lastDone=3 天前`；脚本会显式 throw |
| 冲刺进度不是 2/23、或缺「距首场考试 11 天」 | 两次点击考点必须在 `state.date=2026-10-13` 且 `todayStr` 已指向 10-13 之后；按第 8 行顺序重置 |
| 冲刺页出现「前几天顺延进来 N 条」 | `state.date` 不在计划第 1 天，或页面 `todayStr` 与 `state.date` 不一致 |
| 拍完 suggest 后后面页签数据怪 | 忘了在 suggest 之后重载干净演示数据（脚本已重载）；否则会带着 skipped / 42m 场景 |
| `assets` 里混进多余文件 | 脚本结尾会警告；该目录**只放这 13 张图** |

## 5. 拍完的人工复核

脚本自检只能保证「13 张都在、尺寸对」。**必须**再逐张看图：画面干净（无 toast / 无弹窗残留 /
无滚动错位）、主题色对、标题没被裁、内容与本表一致。有不合格的，把「文件名 + 具体问题」报出来，
由能跑 Chrome 的人重拍，不要凑合。

已知无害现象（不是问题）：
- 390px 宽下页签文字会换行成两行（`今日计划` / `事项池` / `周视图`），这是应用在窄屏的真实布局；
- sprint / sprint-exam 顶部 sticky 头下可能露出一线上一卡片/页签栏的边缘，是真实滚动效果，标题没被遮；
- notes 页面内容较短，下方留空是正常的；
- backlog 里刚做过的事项显示「习惯 · 0 天没做」（演示数据把 lastDone 标成今天导致），真实行为。
- suggest 底部露出「今天的都做完了」恢复类建议开头（今日任务都完成后的真实联动），不算裁切错误。
