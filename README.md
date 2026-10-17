# dsh-skills

给 **DeepSeek Harness (DSH)** 用的技能（skills）集合。每个技能是一个自包含目录包：一份 `SKILL.md`（说明何时用、怎么做）＋ 可选的零依赖脚本。放进 DSH 会扫描的技能根目录即生效，AI 会在匹配到对应任务时自动加载。

## 安装

DSH 按固定优先级扫描技能根目录，**目录监听会自动刷新**，复制即可生效、不需要重启：

| 作用范围 | 路径 | 说明 |
|---|---|---|
| 项目级（优先级最高） | `<项目根>/.dsh/skills/<技能名>/` | 只对该项目生效，可随仓库一起提交 |
| 用户级 | `~/.dsh/skills/<技能名>/`（Windows：`C:\Users\<你>\.dsh\skills\`） | 对所有工作区生效 |

```bash
git clone https://github.com/daoge96/dsh-skills
cp -r dsh-skills/video-production ~/.dsh/skills/          # 用户级
# 或： cp -r dsh-skills/video-production <项目>/.dsh/skills/
```

`SKILL.md` 的 frontmatter 需要 `name` 与 `description`（可选 `whenToUse` 等）；同名的项目级技能优先级高于用户级。

## 技能

| 技能 | 作用 | 何时触发 |
|---|---|---|
| [video-production](video-production/) | 用代码生成视频的**完整方法论＋可直接运行的验收脚本**：把「时间 → 帧」做成纯函数、把渲染/编码/混流拆成可断点重跑的阶段，并让每个易错点（alpha、帧率、冻结帧、循环接缝、响度、真峰）变成一条断言 | 交付物是 mp4/webm/gif、做动效片/数据动画/解释片/循环动画、要把帧序列与音频混流、要验证时长/帧率/容器规格/循环无缝/响度真峰时 |

## 技能长什么样

```
<技能名>/
├── SKILL.md          # frontmatter(name/description/whenToUse) + 操作正文
└── scripts/          # 可选：零依赖脚本，正文里按相对路径引用
```

本仓库的技能遵循三条约定：

1. **可验证优先**：正文里出现的每个数字都要落到一条可执行的断言上，脚本逐条打印 `PASS/FAIL` 并以退出码收尾。
2. **失败要响**：不静默兜底，非零退出；机器可读的部分输出 JSON。
3. **零依赖**：只用系统/捆绑工具（如 ffmpeg/ffprobe），可用环境变量（`$FFMPEG`/`$FFPROBE`）覆盖路径。

## 许可

MIT。技能正文由真实项目复盘沉淀，脚本在真实成品上跑通过（见各技能 README 的实测数据）。
