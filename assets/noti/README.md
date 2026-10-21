# Noti — the Negotium mascot

One round purple node, two feet, dot eyes, a line mouth, and a single antenna node that pings while it is reachable.

| File | Use |
|---|---|
| `noti.svg` / `noti.png` | static hero (idle pose) |
| `noti-icon.svg` / `noti-icon-512.png` | flat icon / favicon / bot avatar |
| `noti-animated.svg` | one CSS-animated SVG; switch state with `data-state="idle\|wave\|thinking\|working\|success\|error\|sleep"` |
| `noti-<state>.gif` | per-state loops (chat / docs) |
| `noti-states.gif` | all seven states side by side |
| `demo.html` | preview + state toggle |

Regenerate: `python3 render.py && python3 build_web.py` (needs `cairosvg`, `Pillow`, `ffmpeg`). Geometry and poses live in `noti.py`.
