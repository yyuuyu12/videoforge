# 讲师头像小窗口（对口型）

目标：一段贯穿全片的真人讲师窗口，嘴型跟每一句口播音频**精确对上**。

前提：用户提供一段本人出镜的视频素材（哪怕只有几十秒），以及一个"视频+音频 → 对口型视频"的模型/API。本文档以本地 HeyGem（FastAPI 服务）为参考实现，换别的模型/API 时接口细节不同，但方法论不变。

> ⚠️ 这份文档是**踩了很多轮坑之后重写的**。早期版本教的两个做法——(a) offset 用"按真实视频时长比例分配"估算、(b) 运行时"每步都 seek 一次"——**都被验证有问题**，本文档已改成正确做法。如果你看到别的项目还在用旧做法，那是历史遗留，按本文档修。

---

## 0. 布局：右侧竖屏大窗口（用户既定偏好，作为默认）

**不再用"右下角圆形小窗"**。当前既定的布局要求：

- **右侧一个竖屏（portrait）大窗口**，四角圆角，垂直居中贴右边。参考尺寸：`360×640`（在 1920×1080 stage 坐标系里）、`border-radius: 28px`、`right: 40px`、`top: 50%; transform: translateY(-50%)`。
- **正文区要给右侧窗口预留出空间**，不能让章节内容铺到窗口底下。做法：scaffold 的 `base.css` 里有 `--stage-pad-x-end`（正文右边距 token），把它设大（本项目 `420px`）就能让所有 `.scene-pad` 章节天然避开右窗口。注释里写清楚"这块右边距是给讲师视频留的"。
- 组件本身：一个 `<video muted playsInline>` 放在 stage 坐标系内（是 `.scene` 的兄弟节点，不是固定视口 chrome），这样它会跟画面一起缩放、一起被录进去。**必须 `muted`**——声音只来自独立的口播音频轨，否则两路声音叠一起。
- 具体尺寸/位置用户可能每个项目微调（窗口大小、留白宽度都是"新的要求"会变），开工前值得确认一次，但默认就按上面这套竖屏大窗口来，别退回小圆窗。

---

## 1. 用"乒乓循环"把素材拉够长

多数对口型模型是"一段视频 + 一段音频 → 生成对口型视频"。音频比视频长时，模型自己延长画面的实现通常是"跳回第 0 帧硬切"，会在循环点产生肉眼可见跳动。

解决：自己预构造"正放 + 倒放"首尾相接的循环母版，让母版总长 > 全片口播总时长，永远用不到模型自己的循环逻辑。

```bash
ffmpeg -i source.mp4 -vf reverse -an reversed.mp4
# 用 concat filter（不是 concat demuxer）拼接足够多个 正放+倒放 来回：
ffmpeg -i forward.mp4 -i reversed.mp4 -i forward.mp4 -i reversed.mp4 \
  -filter_complex "[0:v][1:v][2:v][3:v]concat=n=4:v=1:a=0[outv]" \
  -map "[outv]" -c:v libx264 -preset veryfast -crf 18 -r 30 pingpong_master.mp4
```

> ⚠️ **不要用 concat demuxer + `-c copy` 拼接乒乓母版**。在部分 ffmpeg 版本上，把经过 `-vf reverse` 的片段用 concat demuxer 流拷贝拼接，会产出时间戳/时长错乱的文件。用 `concat` filter 重新编码，稳。

倍数按"全片口播总时长 / 素材本身时长"估，多留余量（再多接 1-2 个来回）。

## 2. 切片必须首尾相接，且不能跨越乒乓翻转点

按段（见第 3 节，一段 ≈ 10s）分别调用模型时，每段截取母版的起点必须紧接上一段终点，游标只前进不回退——否则拼接成片会在每段切换点动作突变。

**更隐蔽的一个坑：一段切片不能横跨乒乓母版的"正放↔倒放翻转点"。** 翻转点在母版里每隔"一个源片长度"出现一次。横跨翻转点的那一段，播放时人物动作会在翻转点瞬间**反向**——这是真实的速度突变（不是帧不连续），**逐帧对比 seam 检查完全看不出来**（翻转点两侧的帧是同一帧，帧差为 0），但播出来动作会"弹"一下。

做法：维护累计游标；如果某段 `[cursor, cursor+时长)` 会跨过一个翻转点，就把 `cursor` 直接**跳到那个翻转点**再开始这一段（宁可在这一段开头对上一段留个硬切——切在段边界不明显——也不要段中间动作反弹）。

```python
SOURCE_CLIP_DUR = ffprobe(forward.mp4)          # 一个源片长度
BOUNDARIES = [SOURCE_CLIP_DUR * k for k in 1,2,3...]  # 所有翻转点
def snap_past_crossed_boundary(start, dur):
    for b in BOUNDARIES:
        if start < b < start + dur: return b   # 跨了就跳到翻转点
    return start
```

## 3. 分段粒度：一段 ≈ 10s（步骤粒度切分）

**不要"一句话一段"**（切片太碎、切换太频繁），也**不要"整章一段"**（章节可能 20s+，太长）。当前既定要求是**一段 ≈ 10s 的乒乓切换**。

做法：把全片所有 step（口播句子）按顺序**贪心打包**，累计音频时长超过上限（≈13s）就开一段新的。这样一段里可能含多个 step、甚至跨越章节边界——没关系（见第 5 节，运行时同步是按 step 精确对齐的，跟段怎么分无关）。一段一次模型调用。

为什么是 10s 而不是更长：段越短，(a) 每段模型输出内部的时间误差越小、(b) 人物离乒乓循环点越近、(c) 交叉相关对齐（第 4 节）越容易命中。段长**不影响口型同步精度**（同步由第 5 节的音频时钟从动保证，跟段长无关），所以 10s 纯粹是"更保险 + 用户偏好"，不是同步的必要条件。

每段生成完，用 `ffprobe` 实测这一段**真实输出视频时长**（模型输出通常比输入音频短零点几秒），记进 `segments.json`，第 4 节要用。

## 4. 求每个 step 的 offset：跟模型输出里的音频做交叉相关（关键）

**这是最容易做错、也是最影响口型的一步。**

❌ 早期做法（已废弃）：按"每步音频时长 / 本段音频总时长 × 本段真实视频时长"比例分配 offset。这是**估算**，假设模型在一段内均匀保持时序——实际不够准，播起来口型会逐渐对不上。

✅ 正确做法：**HeyGem 的每段输出视频里，自带一条它实际用来驱动口型的音频轨**（`ffprobe` 能看到 `aac` 音频流）。这条音频（除了重编码）就是驱动这段唇形的原始音频。所以：把每个 step 自己的音频，跟这一段输出视频里的音频做**归一化交叉相关**，峰值位置就是这个 step 在这段里的**真实起点**——不是估算，是测量。

- 用 `scipy.signal.fftconvolve` 做归一化互相关（needle=step 音频，haystack=段输出音频）。因为两者是同一段语音内容，正常会出现一个**非常尖锐、无歧义**的峰（0.98~1.0 分），不是模糊指纹匹配。
- 设一个置信度阈值（0.7）。低于阈值就退回第 3 节的比例估算**只对这一步**。实测：每段**最后一个 step** 经常匹配失败（≈0.1 分），因为它的音频尾巴超出了输出视频长度、`mode="valid"` 放不下——这时比例估算对"最后一步的起点"本来就够准，退化无害。
- 现成实现：本 skill `scripts/align-avatar-offsets.py`（需要 numpy+scipy，用能跑起来的 Python 而不是 node）。它读 `heygem_outputs/segments.json`，直接写出 `src/registry/avatarOffsets.ts`。

## 5. 运行时同步：把视频"从动"到音频时钟（关键）

**这是第二个最容易做错的地方。** 先说两个错误做法各自的症状：

- ❌ **每步都 `video.currentTime = offset` 重新 seek**：会在**每一句**都闪一下。因为 offset 只要不是 100% 准，每步 seek 都会跳到一个跟当前画面不同的帧 → 可见跳变。（旧文档教的就是这个，别用。）
- ❌ **只在段开头 seek、段内自由播放（free-run）**：口型会**逐渐对不上**。因为 app 是一句一句播放音频的，句子之间有间隙（自动模式的 trail、用户停顿、加载延迟）——视频在这些间隙里继续往前跑、音频时钟却停着，视频就领先了，而且**误差在一段内累积，段越长越糟**（这就是"越到后面越对不上"和"根据时长导致不精准"）。

✅ 正确做法：**每一帧都把视频位置钉到音频时钟上**——正确的视频位置在任意时刻恒等于 `offset[当前step] + audio.currentTime`。用 `requestAnimationFrame` 轮询音频元素（跟字幕同步用的是同一套机制），每帧算出 expected，偏差超过阈值（≈80ms）就纠正 `video.currentTime`：

```ts
const tick = () => {
  const audio = audioRef.current;
  if (audio && !audio.paused && !audio.ended && audio.duration) {
    const expected = offset + audio.currentTime;
    if (Math.abs(video.currentTime - expected) > 0.08) video.currentTime = expected;
  }
  raf = requestAnimationFrame(tick);
};
```

要点：
- **视频永远不自己 `.play()`**——它是被音频时钟"拖着走"的木偶。这样句子间隙音频一停，视频自然就停在原地，不会 free-run 漂移；不需要额外管暂停。
- 段内 offset 连续（`offset[N] + step_N 音频时长 ≈ offset[N+1]`），所以段内切句时 expected 是连续的 → 不闪。段与段之间在拼接时间轴上也是连续的（seg0 播完紧接 seg1），只有那一个真实的人物姿态硬切（≈每 10s 一次，可接受）。
- 口型精度**跟段长彻底解耦**：视频位置恒等于 `offset + 音频已播时间`，间隙不漂移、不累积。这就是为什么第 3 节说 10s 只是保险不是必需。
- manual/预览模式（无音频时钟）：进 step 时 seek 到 offset、pause，静态显示这一步对应的一帧即可。

---

## HeyGem 服务（本机参考实现）

不是 WSL/Docker，是**原生 Windows Python 服务**。位置与启动命令见 `F:\Projects\MACHINE-INDEX.md` 服务表。要点复述：venv python 跑 `heygem_server_v2.py`，端口 **7861**，`GET /health` 等到 `processor_ready:true` 再调；`POST /video/generate`（`audio_b64`/`video_b64`/`audio_fmt`/`video_fmt`/`enhancer`）→ `{task_id}`，轮询 `GET /video/task/{id}`，`GET /video/file/{id}` 下载。批量前先确认服务在跑、没在跑自己拉起来。

---

## 完整重跑顺序（改了音频/语速/情绪/分段任何一项都要按序全跑）

音频一变，下游全失效（字幕 cue、乒乓切片点、avatar offset 全依赖音频时长）：

1. `node scripts/synthesize-audio-node.mjs --force`（重合成音频 + 逐字时间戳）
2. `node scripts/gen-subtitle-cues.mjs`（重算字幕）
3. `python heygem_batch_amv.py`（按 ≈10s 分段、含翻转点跳避，重生成每段 → `segments.json`）
4. `ffmpeg` 按 `segments.json` 顺序把各段拼成 `public/avatar/lipsync.mp4`（concat demuxer + 重编码即可，输入都是正常 mp4）
5. `python scripts/align-avatar-offsets.py`（交叉相关求真实 offset → `avatarOffsets.ts`）
6. 浏览器验证 + `subtitle-overlap-sweep`

## 常见问题排查

- **每句话闪一下**：运行时用了"每步 seek"或 offset 不准。改成第 5 节的音频时钟从动。
- **越到后面口型越对不上 / 跟段时长有关**：运行时用了 free-run（只段头 seek）。同样改成第 5 节从动。offset 也要用第 4 节交叉相关而不是比例估算。
- **段切换点动作"弹"一下**：切片跨了乒乓翻转点（第 2 节），逐帧 seam 检查看不出来，必须用代码检查每段切片区间有没有跨 `SOURCE_CLIP_DUR` 的整数倍。
- **拼接后的母版时长/时间戳错乱**：别用 concat demuxer 流拷贝拼 reverse 过的片段，用 concat filter 重编码（第 1 节）。
- **交叉相关整段都低分**：确认 haystack 取的是**模型输出视频**里的音频（自带 aac 轨），不是原始输入音频；确认采样率一致。每段最后一步低分是正常的，会自动退化。
- **调用超时/批量失败**：本地服务单次调用有硬超时；批量做轮询，跑前预估总耗时告知用户（本项目量级：45 句、10 段、单段 20-30s，全部约 5 分钟）。
