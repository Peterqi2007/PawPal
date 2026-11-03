"""重新生成开发自测宠物包 dev-pet（用法：python examples/dev-pet/make.py）

生成开发自测宠物包 examples/dev-pet/（8 动作 × 8 帧 × 256px，单只狗、全程透明底）。

来源素材：examples/dingdang-demo/ 两张真实精灵表（idle 25 帧「叼鳄鱼打盹」、tangzuoyi 25 帧「躺下作揖」）。
只有这两个动作是真实素材；sleep/stretch/sniff/wiggle/run/poop 由 idle 帧做几何变换派生，
仅用于功能自测与 CI（不是正式美术素材，正式素材按 docs/05 管线自生成）。
选叮当而不是红苕：红苕的 knead 精灵表是不透明 RGB（0% 透明），会破坏「透明区不响应点击」的自测前提。
"""
import json
import os

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))  # examples/dev-pet/ -> 仓库根
SRC = os.path.join(ROOT, "examples", "dingdang-demo")
OUT = HERE
CELL = 256
N = 8
MARGIN = 8

IDLE_IDX = [0, 3, 6, 9, 12, 15, 18, 21]      # 前段：清醒躺着玩鳄鱼
SLEEP_IDX = [17, 18, 19, 20, 21, 22, 23, 24]  # 后段：闭眼打盹（天然适合当 sleep）
LYING_IDX = [0, 3, 6, 9, 12, 15, 18, 21]      # tangzuoyi：仰躺作揖


def load_frames(rel, cell=655):
    im = Image.open(os.path.join(SRC, rel)).convert("RGBA")
    return [im.crop((i * cell, 0, (i + 1) * cell, cell)) for i in range(im.size[0] // cell)]


def fit(im, box=CELL, margin=MARGIN):
    inner = box - 2 * margin
    w, h = im.size
    s = min(inner / w, inner / h)
    nw, nh = max(1, round(w * s)), max(1, round(h * s))
    canvas = Image.new("RGBA", (box, box), (0, 0, 0, 0))
    canvas.alpha_composite(im.resize((nw, nh), Image.LANCZOS), ((box - nw) // 2, (box - nh) // 2))
    return canvas


def place(im, dx=0, dy=0, scale=1.0, sy=1.0, rot=0.0, anchor="center"):
    """在 CELL 画布内做变换（保持画布尺寸、透明底）"""
    img = im
    if scale != 1.0:
        img = img.resize((max(1, round(img.size[0] * scale)), max(1, round(img.size[1] * scale))), Image.LANCZOS)
    if sy != 1.0:
        img = img.resize((img.size[0], max(1, round(img.size[1] * sy))), Image.LANCZOS)
    if rot:
        img = img.rotate(rot, resample=Image.BICUBIC, expand=False)
    canvas = Image.new("RGBA", (CELL, CELL), (0, 0, 0, 0))
    x = (CELL - img.size[0]) // 2 + dx
    y = (CELL - MARGIN - img.size[1] + dy) if anchor == "bottom" else ((CELL - img.size[1]) // 2 + dy)
    canvas.alpha_composite(img, (x, y))
    return canvas


def save_sheet(action, frames):
    d = os.path.join(OUT, action)
    os.makedirs(d, exist_ok=True)
    sheet = Image.new("RGBA", (CELL * len(frames), CELL), (0, 0, 0, 0))
    for i, f in enumerate(frames):
        sheet.alpha_composite(f, (i * CELL, 0))
    path = os.path.join(d, f"{action}_sheet.webp")
    sheet.save(path, "WEBP", quality=88, method=6)
    return path


def main():
    idle_all = load_frames("idle_sheet.webp")
    lying_all = load_frames("tangzuoyi_sheet.webp")

    idle = [fit(idle_all[i]) for i in IDLE_IDX]
    doze = [fit(idle_all[i]) for i in SLEEP_IDX]
    lying = [fit(lying_all[i]) for i in LYING_IDX]

    rot_w = [0, 4, -4, 3, -3, 2, -2, 0]
    dx_w = [0, 2, -2, 2, -2, 1, -1, 0]
    dx_run = [0, 10, 20, 24, 24, 20, 10, 0]
    dy_run = [0, -3, -5, -3, 0, 3, 3, 0]
    dx_sniff = [0, 3, 6, 8, 6, 3, 0, 0]
    dy_sniff = [-2, -5, -8, -10, -8, -5, -2, 0]
    sy_poop = [0.92, 0.88, 0.84, 0.82, 0.82, 0.85, 0.89, 0.92]
    sy_stretch = [1.00, 1.05, 1.10, 1.15, 1.15, 1.10, 1.04, 1.00]
    dy_sleep = [0, 1, 2, 3, 3, 2, 1, 0]

    actions = {
        "idle": [place(f) for f in idle],
        "sleep": [place(doze[i], dy=dy_sleep[i], sy=0.99) for i in range(N)],
        "stretch": [place(idle[i], sy=sy_stretch[i], anchor="bottom") for i in range(N)],
        "belly": [place(lying[i]) for i in range(N)],
        "wiggle": [place(idle[i], rot=rot_w[i], dx=dx_w[i]) for i in range(N)],
        "run": [place(idle[i], dx=dx_run[i], dy=dy_run[i], scale=0.8) for i in range(N)],
        "sniff": [place(idle[i], dx=dx_sniff[i], dy=dy_sniff[i]) for i in range(N)],
        "poop": [place(idle[i], sy=sy_poop[i], anchor="bottom") for i in range(N)],
    }

    for name, frames in actions.items():
        p = save_sheet(name, frames)
        print(f"  {name:8s} -> {os.path.relpath(p, ROOT):40s} {os.path.getsize(p)/1024:6.1f} KB")

    pet = {
        "version": 3,
        "id": "dev-pet",
        "name": "自测狗",
        "style": "illustration",
        "theme": "orange",
        "persona": "温柔",
        "bubbles": ["汪！", "摸摸我～", "今天也要开心哦！"],
        "cellWidth": CELL,
        "cellHeight": CELL,
        "temperament": {"activity": 0.5, "clinginess": 0.5, "curiosity": 0.5, "independence": 0.5},
        "actions": {
            "idle": {
                "sprite": "idle/idle_sheet.webp",
                "frames": N, "fps": 5, "loop": True, "weight": 100,
                "frameWidth": CELL, "frameHeight": CELL, "scale": 1,
                "label": "待机",
                "diary": {"mood": "安逸", "text": "{name}叼着鳄鱼玩具打盹，安静等主人回来。"},
            },
            "sleep": {
                "sprite": "sleep/sleep_sheet.webp",
                "frames": N, "fps": 5, "loop": True, "weight": 10,
                "frameWidth": CELL, "frameHeight": CELL, "scale": 1,
                "label": "睡觉",
                "diary": {"mood": "安逸", "text": "{name}蜷成一团睡着了，呼噜声轻轻的。"},
                "transitions": {"stretch": 80, "idle": 20},
            },
            "stretch": {
                "sprite": "stretch/stretch_sheet.webp",
                "frames": N, "fps": 5, "loop": True, "weight": 10,
                "frameWidth": CELL, "frameHeight": CELL, "scale": 1,
                "label": "伸懒腰",
                "diary": {"mood": "舒坦", "text": "{name}伸了个大大的懒腰，爪子张得开花。"},
                "transitions": {"idle": 100},
            },
            "sniff": {
                "sprite": "sniff/sniff_sheet.webp",
                "frames": N, "fps": 5, "loop": True, "weight": 20,
                "frameWidth": CELL, "frameHeight": CELL, "scale": 1,
                "label": "嗅闻",
                "diary": {"mood": "好奇", "text": "{name}凑近嗅了嗅，鼻头湿漉漉的。"},
            },
            "wiggle": {
                "sprite": "wiggle/wiggle_sheet.webp",
                "frames": N, "fps": 5, "loop": True, "weight": 20,
                "frameWidth": CELL, "frameHeight": CELL, "scale": 1,
                "label": "撒娇",
                "diary": {"mood": "开心", "text": "{name}扭着屁股撒欢，尾巴摇成小风扇。"},
            },
            "run": {
                "sprite": "run/run_sheet.webp",
                "frames": N, "fps": 5, "loop": True, "weight": 10,
                "frameWidth": CELL, "frameHeight": CELL, "scale": 1,
                "label": "奔跑",
                "diary": {"mood": "兴奋", "text": "{name}嗖地窜了出去，一溜烟就没影了。"},
            },
            "belly": {
                "sprite": "belly/belly_sheet.webp",
                "frames": N, "fps": 5, "loop": True, "weight": 10,
                "frameWidth": CELL, "frameHeight": CELL, "scale": 1,
                "label": "露肚躺",
                "diary": {"mood": "惬意", "text": "{name}翻出肚皮晒太阳，毫无防备。"},
            },
            "poop": {
                "sprite": "poop/poop_sheet.webp",
                "frames": N, "fps": 5, "loop": True, "weight": 5,
                "frameWidth": CELL, "frameHeight": CELL, "scale": 1,
                "label": "拉粑粑",
                "diary": {"mood": "心虚", "text": "{name}先转着圈圈踩好位置，解决完就撒欢跑开了。"},
            },
        },
    }
    with open(os.path.join(OUT, "pet.json"), "w", encoding="utf-8") as f:
        json.dump(pet, f, ensure_ascii=False, indent=2)
        f.write("\n")
    print("  pet.json 已写入")


if __name__ == "__main__":
    main()
