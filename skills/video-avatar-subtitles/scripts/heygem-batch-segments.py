import base64
import glob
import json
import os
import subprocess
import time
import urllib.request

PROJECT_ROOT = r"F:\Projects\ai-market-video"
AUDIO_ROOT = os.path.join(PROJECT_ROOT, "presentation", "public", "audio")
AUDIO_SEGMENTS_JSON = os.path.join(PROJECT_ROOT, "presentation", "audio-segments.json")
MASTER_VIDEO = os.path.join(PROJECT_ROOT, "pingpong", "pingpong_master.mp4")
SLICE_DIR = os.path.join(PROJECT_ROOT, "pingpong", "per_segment_continuous")
OUT_DIR = os.path.join(PROJECT_ROOT, "heygem_outputs")
TMP_DIR = r"C:\Users\木木\AppData\Local\Temp\claude\heygem_tmp_amv"
BASE = "http://127.0.0.1:7861"
FFMPEG = "ffmpeg"
FFPROBE = "ffprobe"
BUFFER_SEC = 1.0
# ~10s segments (user: "10s一个乒乓乓乒切换 保证口型"). Grouped at STEP
# granularity — a long chapter can split across two clips — because most
# chapters here run 12-22s and chapter-granular grouping couldn't hit 10s.
# Playback lip-sync is guaranteed frame-accurately by audio-clock slaving in
# useAvatarSync regardless of segment length; short segments just bound any
# residual HeyGem-internal timing error and keep the person near a ping-pong
# loop point, and match the user's stated preference.
TARGET_SEGMENT_SEC = 10.0
SEGMENT_CAP_SEC = 13.0  # start a new segment once adding the next step would exceed this

os.makedirs(OUT_DIR, exist_ok=True)
os.makedirs(TMP_DIR, exist_ok=True)
os.makedirs(SLICE_DIR, exist_ok=True)


def b64(path):
    with open(path, "rb") as f:
        return base64.b64encode(f.read()).decode("ascii")


def ffprobe_duration(path):
    out = subprocess.run(
        [FFPROBE, "-v", "error", "-show_entries", "format=duration",
         "-of", "default=nw=1:nk=1", path],
        check=True, capture_output=True, text=True,
    ).stdout.strip()
    return float(out)


def concat_audio(paths, out_path):
    list_path = out_path + "_list.txt"
    with open(list_path, "w", encoding="utf-8") as f:
        for fp in paths:
            f.write(f"file '{fp}'\n")
    subprocess.run(
        [FFMPEG, "-y", "-f", "concat", "-safe", "0", "-i", list_path,
         "-c:a", "libmp3lame", "-q:a", "2", out_path],
        check=True, capture_output=True,
    )
    return out_path


def slice_continuous(cursor, duration, label):
    out_path = os.path.join(SLICE_DIR, f"{label}.mp4")
    subprocess.run(
        [FFMPEG, "-y", "-ss", str(cursor), "-i", MASTER_VIDEO, "-t", str(duration),
         "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-an", out_path],
        check=True, capture_output=True,
    )
    return out_path


def generate(audio_path, video_path, label):
    payload = json.dumps({
        "audio_b64": b64(audio_path),
        "video_b64": b64(video_path),
        "audio_fmt": "mp3",
        "video_fmt": "mp4",
        "enhancer": False,
    }).encode("utf-8")
    req = urllib.request.Request(
        f"{BASE}/video/generate", data=payload,
        headers={"Content-Type": "application/json"}, method="POST",
    )
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=60) as resp:
        task_id = json.loads(resp.read())["task_id"]
    print(f"[{label}] task_id={task_id}", flush=True)

    while True:
        time.sleep(3)
        with urllib.request.urlopen(f"{BASE}/video/task/{task_id}", timeout=15) as resp:
            status = json.loads(resp.read())
        elapsed = time.time() - t0
        if status.get("status") in ("done", "error", "cancelled"):
            print(f"[{label}] [{elapsed:6.1f}s] FINAL status={status.get('status')}", flush=True)
            break
        if int(elapsed) % 15 < 3:
            print(f"[{label}] [{elapsed:6.1f}s] status={status.get('status')} progress={status.get('progress')}", flush=True)

    if status.get("status") != "done":
        raise RuntimeError(f"[{label}] generation failed: {status}")

    out_path = os.path.join(OUT_DIR, f"{label}.mp4")
    with urllib.request.urlopen(f"{BASE}/video/file/{task_id}", timeout=60) as resp:
        data = resp.read()
    with open(out_path, "wb") as f:
        f.write(data)
    real_dur = ffprobe_duration(out_path)
    print(f"[{label}] saved -> {out_path} ({len(data)} bytes, video_dur={real_dur:.3f}s, total {time.time()-t0:.1f}s)", flush=True)
    return out_path, real_dur


SOURCE_CLIP_DUR = ffprobe_duration(os.path.join(os.path.dirname(MASTER_VIDEO), "forward.mp4"))
MASTER_DUR = ffprobe_duration(MASTER_VIDEO)
# Forward/reverse transition points in the ping-pong master (every source-clip
# length). A slice reaching across one is a real motion-reversal "bounce" — a
# frame-diff seam check does NOT catch it. Snap segment starts past any crossed
# boundary. (See notes in memory / skill AVATAR-PIPELINE.md.)
BOUNDARIES = []
b = SOURCE_CLIP_DUR
while b < MASTER_DUR:
    BOUNDARIES.append(b)
    b += SOURCE_CLIP_DUR


def snap_past_crossed_boundary(start, duration):
    end = start + duration
    for bnd in BOUNDARIES:
        if start < bnd < end:
            return bnd
    return start


# ---- Step 1: flat, ordered list of every step (the app's own step order) ----
audio_segments = json.load(open(AUDIO_SEGMENTS_JSON, encoding="utf-8"))
steps = []  # {chapter, step, audioPath, duration}
for seg in audio_segments:
    audio_path = os.path.join(AUDIO_ROOT, seg["audio"])
    steps.append({
        "chapter": seg["chapter"],
        "step": seg["step"],
        "audioPath": audio_path,
        "duration": ffprobe_duration(audio_path),
    })

# ---- Step 2: greedily group consecutive STEPS into ~10s segments ----
segments = []  # each: {"steps": [idx...], "audioDuration": float}
cur, cur_dur = [], 0.0
for i, s in enumerate(steps):
    if cur and (cur_dur + s["duration"]) > SEGMENT_CAP_SEC:
        segments.append({"steps": cur, "audioDuration": cur_dur})
        cur, cur_dur = [], 0.0
    cur.append(i)
    cur_dur += s["duration"]
if cur:
    segments.append({"steps": cur, "audioDuration": cur_dur})

print(f"Grouped {len(steps)} steps into {len(segments)} segments (~{TARGET_SEGMENT_SEC:.0f}s target):", flush=True)
for i, seg in enumerate(segments):
    members = ", ".join(f"{steps[j]['chapter']}/{steps[j]['step']}" for j in seg["steps"])
    print(f"  segment {i}: {seg['audioDuration']:.1f}s [{members}]", flush=True)

# ---- Step 3: one HeyGem call per segment ----
t_all0 = time.time()
cursor = 0.0
segment_results = []
for i, seg in enumerate(segments):
    label = f"seg{i:02d}"
    member_audios = [steps[j]["audioPath"] for j in seg["steps"]]
    audio_path = concat_audio(member_audios, os.path.join(TMP_DIR, f"{label}.mp3"))
    audio_dur = ffprobe_duration(audio_path)
    slice_dur = audio_dur + BUFFER_SEC

    snapped = snap_past_crossed_boundary(cursor, slice_dur)
    if snapped != cursor:
        print(f"[{label}] skip {snapped - cursor:.2f}s to avoid a ping-pong reversal (cursor {cursor:.2f} -> {snapped:.2f})", flush=True)
        cursor = snapped
    if cursor + slice_dur > MASTER_DUR:
        raise RuntimeError(f"[{label}] ran past ping-pong master end ({cursor + slice_dur:.1f} > {MASTER_DUR:.1f}) — make the master longer")

    print(f"\n=== {label} ({audio_dur:.2f}s audio, master@{cursor:.2f}s) ===", flush=True)
    video_path = slice_continuous(cursor, slice_dur, label)
    _, real_video_dur = generate(audio_path, video_path, label)

    segment_results.append({
        "outputFile": f"{label}.mp4",
        "steps": [
            {"chapter": steps[j]["chapter"], "step": steps[j]["step"], "duration": steps[j]["duration"]}
            for j in seg["steps"]
        ],
        "audioDuration": audio_dur,
        "realVideoDuration": real_video_dur,
    })
    cursor += slice_dur

with open(os.path.join(OUT_DIR, "segments.json"), "w", encoding="utf-8") as f:
    json.dump(segment_results, f, ensure_ascii=False, indent=2)

print(f"\nALL DONE in {time.time()-t_all0:.1f}s total, {len(segments)} HeyGem calls", flush=True)
