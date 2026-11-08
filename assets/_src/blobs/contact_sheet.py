"""Builds assets/blobs/preview.png: contact sheet of all thumbs with id captions (needs ffmpeg on PATH).

    python contact_sheet.py [--ids a,b,c] [--out path] [--cols 4]
"""
import os, subprocess, sys

ROOT = r"C:\Users\Asus\Desktop\bot-hq\assets\blobs"
ORDER = ["grok-bot", "jevopus", "x-writer", "banner-visuals", "analytics-analyst", "competitor-watch", "qt-scout",
         "ideas-sparring", "bookmarks-brain", "codila-x-researcher", "trendy-x", "substack", "x-ads-manager",
         "warren-buffett", "finance-team", "_default"]
FONT = "C\\:/Windows/Fonts/segoeuib.ttf"
BG = "0xF6F1EA"
CELL, CAP = 256, 34


def main():
    a = sys.argv[1:]
    ids = ORDER
    out = os.path.join(ROOT, "preview.png")
    cols = 4
    if "--ids" in a:
        ids = a[a.index("--ids") + 1].split(",")
    if "--out" in a:
        out = a[a.index("--out") + 1]
    if "--cols" in a:
        cols = int(a[a.index("--cols") + 1])
    rows = (len(ids) + cols - 1) // cols
    W, H = cols * CELL, rows * (CELL + CAP)
    cmd = ["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", f"color=c={BG}:s={W}x{H}"]
    for i in ids:
        cmd += ["-i", os.path.join(ROOT, "thumbs", i + ".png")]
    fc = []
    prev = "0:v"
    for n, i in enumerate(ids):
        x, y = (n % cols) * CELL, (n // cols) * (CELL + CAP)
        fc.append(f"[{prev}][{n + 1}:v]overlay={x}:{y}[o{n}]")
        prev = f"o{n}"
        fc.append(f"[{prev}]drawtext=fontfile='{FONT}':text='{i}':fontsize=18:fontcolor=0x141414:"
                  f"x={x}+({CELL}-text_w)/2:y={y + CELL}+6[t{n}]")
        prev = f"t{n}"
    cmd += ["-filter_complex", ";".join(fc), "-map", f"[{prev}]", "-frames:v", "1", out]
    subprocess.run(cmd, check=True)
    print("wrote", out)


main()
