"""Noti — negotium mascot (v3, 'D'): one round purple body, two feet, dot eyes, line mouth, one antenna node.
frame(state, t) -> svg. States: idle, wave, thinking, working, success, error, sleep
"""
import math, random
W = H = 400
CX, CY, RX, RY = 200, 222, 104, 98
FOOT_Y = 322
EYE_DX, EYE_Y, EYE_R = 27, 214, 8.5
P = dict(body="#8f78e0", dark="#6a5db8", light="#b8aaf0", ink="#201c34", joint="#a89bea",
         blush="#f2a9c0", cream="#fdf6e8", lilac="#ddd3f7", coral="#e4655a", bg="#f8f7ff", shadow="#4a3aa7")
ANT_BASE = (200, CY - RY)   # (200,124)
ANT_TIP = (200, 88)
DUR = dict(idle=4.0, wave=2.0, thinking=2.4, working=1.6, success=1.6, error=1.2, sleep=4.0)

def clamp(x, a=0.0, b=1.0): return max(a, min(b, x))
def ease_io(x): x = clamp(x); return 0.5 - 0.5 * math.cos(math.pi * x)
def ease_out(x): x = clamp(x); return 1 - (1 - x) ** 3
def tri(x): x = clamp(x); return 1 - abs(2 * x - 1)
def pulse(t, period, phase=0.0): return ((t / period) + phase) % 1.0

def base():
    return dict(tx=0, ty=0, rot=0, sx=1, sy=1, ant_rot=0, ant_alpha=1, ant_color=P["joint"], ping=[],
                fdx=0, fdy=0, eye="open", eye_open=1.0, wink=False, mouth="smile", blush=0.5, feet=(0, 0),
                extras=[], behind=[])

def pose_idle(t):
    p = base(); s = math.sin(2 * math.pi * t / DUR["idle"])
    p["sx"], p["sy"] = 1 + 0.012 * s, 1 - 0.02 * s
    p["ant_rot"] = 5 * math.sin(2 * math.pi * t / DUR["idle"] + 1)
    b = (t - 2.85) / 0.25
    if 0 <= b <= 1: p["eye_open"] = 1 - tri(b)
    k = pulse(t, 2.0); p["ping"] = [(12 + 26 * k, 0.5 * (1 - k), P["joint"])]
    return p

def pose_wave(t):
    # no arms: greet with a side-to-side rock + hop + wink; antenna wags
    p = base(); D = DUR["wave"]
    p["rot"] = 7 * math.sin(2 * math.pi * 2 * t / D)
    hop = abs(math.sin(2 * math.pi * 2 * t / D))
    p["ty"] = -14 * hop
    p["sx"], p["sy"] = 1 - 0.03 * hop, 1 + 0.04 * hop
    p["ant_rot"] = -18 * math.sin(2 * math.pi * 4 * t / D)
    p["mouth"] = "grin"; p["blush"] = 0.8
    p["wink"] = 0.3 < t < 1.1
    k = pulse(t, 1.0); p["ping"] = [(12 + 26 * k, 0.5 * (1 - k), P["joint"])]
    return p

def pose_thinking(t):
    p = base(); D = DUR["thinking"]
    p["fdx"], p["fdy"] = 7, -6; p["eye"] = "focused"; p["eye_open"] = 0.75; p["mouth"] = "o"
    p["rot"] = 4; p["ant_rot"] = 10 * math.sin(2 * math.pi * t / 1.2)
    for i in range(2):
        k = pulse(t, 0.9, i * 0.5); p["ping"].append((12 + 28 * k, 0.55 * (1 - k), P["joint"]))
    for i, (x, y, r) in enumerate([(258, 128, 5), (278, 108, 7), (304, 90, 9)]):
        ph = pulse(t, D, -i * 0.18)
        k = ease_io(ph / 0.35) if ph < 0.35 else 1
        fade = 1 - ease_io((pulse(t, D) - 0.8) / 0.2) if pulse(t, D) > 0.8 else 1
        p["extras"].append(f'<circle cx="{x}" cy="{y}" r="{r*k:.2f}" fill="{P["joint"]}" stroke="{P["dark"]}" stroke-width="2" opacity="{fade:.2f}"/>')
    return p

def pose_working(t):
    # busy: quick wobble + focused eyes + orbiting node (processing) + sparks
    p = base(); D = DUR["working"]
    w = math.sin(2 * math.pi * 2 * t / D)
    p["rot"] = 5 * w; p["sy"] = 1 - 0.02 * abs(w); p["sx"] = 1 + 0.012 * abs(w)
    p["eye"] = "focused"; p["eye_open"] = 0.55; p["mouth"] = "flat"; p["fdy"] = 4
    k = pulse(t, 0.8); p["ping"] = [(12 + 24 * k, 0.5 * (1 - k), P["joint"])]
    a = 2 * math.pi * pulse(t, D)
    ox, oy = CX + 128 * math.cos(a), CY + 32 * math.sin(a) + 10
    front = math.sin(a) > 0
    dot = f'<circle cx="{ox:.1f}" cy="{oy:.1f}" r="{7 + 2*math.sin(a):.1f}" fill="{P["joint"]}" stroke="{P["dark"]}" stroke-width="2"/>'
    (p["extras"] if front else p["behind"]).append(dot)
    ph = pulse(t, D / 2)
    if ph < 0.3:
        al = 1 - ph / 0.3
        for (dx, dy) in [(0, -40), (22, -30), (-22, -30)]:
            x, y = 200 + dx * (1 + ph * 1.5), 150 + dy * (0.4 + ph)
            p["extras"].append(f'<path d="M{x:.1f} {y-5:.1f} V{y+5:.1f} M{x-5:.1f} {y:.1f} H{x+5:.1f}" stroke="{P["cream"]}" stroke-width="3" stroke-linecap="round" opacity="{al:.2f}"/>')
    return p

def pose_success(t):
    p = base(); p["eye"] = "happy"; p["mouth"] = "grin"; p["blush"] = 0.9
    if t < 0.15:
        q = ease_io(t / 0.15); p["sx"], p["sy"] = 1 + 0.1 * q, 1 - 0.12 * q
    elif t < 0.95:
        u = (t - 0.15) / 0.8; st = math.sin(math.pi * u)
        p["ty"] = -50 * st; p["sx"], p["sy"] = 1 - 0.05 * st, 1 + 0.07 * st
        p["feet"] = (6 * st, 6 * st)
    elif t < 1.25:
        q = tri((t - 0.95) / 0.3); p["sx"], p["sy"] = 1 + 0.12 * q, 1 - 0.14 * q
    k = pulse(t, 0.8)
    p["ping"] = [(12 + 30 * k, 0.6 * (1 - k), P["cream"]), (12 + 30 * ((k + .5) % 1), 0.6 * (1 - (k + .5) % 1), P["joint"])]
    rng = random.Random(7); cols = [P["body"], P["lilac"], P["cream"], P["joint"], P["blush"]]
    for i in range(14):
        ang = rng.uniform(-2.6, -0.5); sp = rng.uniform(220, 360); x0 = 200 + rng.uniform(-30, 30)
        tt = t - 0.2
        if tt < 0: continue
        x = x0 + sp * math.cos(ang) * tt; y = 150 + sp * math.sin(ang) * tt + 420 * tt * tt
        a = clamp(1.3 - tt); c = cols[i % 5]; rot = tt * rng.uniform(200, 600)
        p["behind"].append(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="5" fill="{c}" opacity="{a:.2f}"/>' if i % 3 == 0 else
                           f'<rect x="{x-5:.1f}" y="{y-3:.1f}" width="10" height="6" rx="1.5" fill="{c}" opacity="{a:.2f}" transform="rotate({rot:.0f} {x:.1f} {y:.1f})"/>')
    return p

def pose_error(t):
    p = base(); D = DUR["error"]; dec = max(0, 1 - t / 0.55)
    p["tx"] = 7 * math.sin(2 * math.pi * 9 * t) * dec
    p["eye"] = "worried"; p["mouth"] = "wavy"; p["blush"] = 0.3
    p["ant_color"] = P["coral"]; p["ant_alpha"] = 0.45 + 0.55 * (0.5 + 0.5 * math.sin(2 * math.pi * 3 * t))
    k = pulse(t, 0.6); p["ping"] = [(12 + 24 * k, 0.6 * (1 - k), P["coral"])]
    sd = pulse(t, D); y = 176 + 60 * ease_io(sd); a = 1 - ease_io((sd - 0.7) / 0.3) if sd > 0.7 else 1
    p["extras"].append(f'<path d="M276 {y-12:.1f} C 284 {y:.1f} 284 {y+6:.1f} 276 {y+8:.1f} C 268 {y+6:.1f} 268 {y:.1f} 276 {y-12:.1f} Z" fill="#8fd3f4" opacity="{a:.2f}"/>')
    pop = ease_out(t / 0.25) * (1 + 0.15 * math.sin(math.pi * clamp(t / 0.3))) if t < 0.3 else 1
    p["extras"].append(f'<g transform="translate(306 104) rotate(12) scale({pop:.2f})"><rect x="-14" y="-18" width="28" height="36" rx="7" fill="{P["coral"]}"/><text x="0" y="9" text-anchor="middle" font-family="Helvetica, Arial" font-weight="700" font-size="26" fill="#fff">!</text></g>')
    return p

def pose_sleep(t):
    p = base(); D = DUR["sleep"]; s = math.sin(2 * math.pi * t / D)
    p["sx"], p["sy"] = 1 + 0.02 * s, 1 - 0.035 * s
    p["eye"] = "closed"; p["mouth"] = "tiny"; p["blush"] = 0.4
    p["ant_rot"] = 18; p["ant_alpha"] = 0.4; p["rot"] = 5
    for i in range(3):
        k = pulse(t, 2.4, -i * 0.33); x = 268 + 26 * k + 8 * math.sin(2 * math.pi * k * 1.5); y = 156 - 70 * k
        a = tri(k) if k < 0.5 else 1 - ease_io((k - 0.5) / 0.5)
        p["extras"].append(f'<text x="{x:.1f}" y="{y:.1f}" font-family="Helvetica, Arial" font-weight="800" font-size="{14+10*k:.0f}" fill="{P["dark"]}" opacity="{a*0.9:.2f}" transform="rotate(-12 {x:.1f} {y:.1f})">z</text>')
    return p

POSES = dict(idle=pose_idle, wave=pose_wave, thinking=pose_thinking, working=pose_working, success=pose_success, error=pose_error, sleep=pose_sleep)

def eyes(kind, open_amt, dx, dy, wink):
    out = ''
    for i, ex in enumerate((CX - EYE_DX, CX + EYE_DX)):
        x, y = ex + dx, EYE_Y + dy
        oa = 0.0 if (wink and i == 1) else open_amt
        if kind == "closed" or oa < 0.08:
            out += f'<path d="M{x-8} {y+1} Q{x} {y+7} {x+8} {y+1}" fill="none" stroke="{P["ink"]}" stroke-width="4.5" stroke-linecap="round"/>'
        elif kind == "happy":
            out += f'<path d="M{x-9} {y+3} Q{x} {y-10} {x+9} {y+3}" fill="none" stroke="{P["ink"]}" stroke-width="5" stroke-linecap="round"/>'
        elif kind == "focused":
            out += (f'<clipPath id="lid{i}"><rect x="{x-11}" y="{y-9+18*(1-oa):.2f}" width="22" height="24"/></clipPath>'
                    f'<circle cx="{x}" cy="{y}" r="{EYE_R}" fill="{P["ink"]}" clip-path="url(#lid{i})"/>')
        else:
            out += f'<g transform="translate({x} {y}) scale(1 {max(oa,0.08):.3f})"><circle r="{EYE_R}" fill="{P["ink"]}"/><circle cx="-2.5" cy="-3" r="2.4" fill="#fff"/></g>'
            if kind == "worried":
                sg = -1 if i == 0 else 1
                out += f'<path d="M{x-9*sg} {y-15} L{x+7*sg} {y-20}" stroke="{P["ink"]}" stroke-width="4" stroke-linecap="round"/>'
    return out

def mouth(kind, dx, dy):
    x, y = CX + dx, EYE_Y + 22 + dy; k = P["ink"]
    return {
        "smile": f'<path d="M{x-11} {y-2} Q{x} {y+11} {x+11} {y-2}" fill="none" stroke="{k}" stroke-width="4.5" stroke-linecap="round"/>',
        "grin": f'<path d="M{x-16} {y-4} Q{x} {y+22} {x+16} {y-4} Z" fill="{k}"/><path d="M{x-8} {y+7} Q{x} {y+13} {x+8} {y+7} Z" fill="{P["blush"]}"/>',
        "o": f'<ellipse cx="{x}" cy="{y+2}" rx="6" ry="7.5" fill="{k}"/>',
        "flat": f'<path d="M{x-11} {y+1} L{x+10} {y-1}" stroke="{k}" stroke-width="4.5" stroke-linecap="round"/>',
        "wavy": f'<path d="M{x-16} {y} Q{x-8} {y-7} {x} {y} T{x+16} {y}" fill="none" stroke="{k}" stroke-width="4.5" stroke-linecap="round"/>',
        "tiny": f'<path d="M{x-6} {y} Q{x} {y+5} {x+6} {y}" fill="none" stroke="{k}" stroke-width="4" stroke-linecap="round"/>',
    }[kind]

DEFS = f'<defs><radialGradient id="g" cx=".4" cy=".35" r=".85"><stop offset="0" stop-color="{P["light"]}"/><stop offset=".45" stop-color="{P["body"]}"/><stop offset="1" stop-color="{P["body"]}"/></radialGradient></defs>'

def render(p, bg=P["bg"], flat=False):
    s = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}">', DEFS]
    if bg: s.append(f'<rect width="{W}" height="{H}" fill="{bg}"/>')
    s += p["behind"]
    gs = clamp(1 + p["ty"] / 120, 0.45, 1)
    s.append(f'<ellipse cx="{CX+p["tx"]:.1f}" cy="{FOOT_Y+14}" rx="{72*gs:.1f}" ry="{9*gs:.1f}" fill="{P["shadow"]}" opacity="{0.13*gs:.3f}"/>')
    s.append(f'<g transform="translate({p["tx"]:.2f} {p["ty"]:.2f})">')
    fl, fr = p["feet"]
    s.append(f'<ellipse cx="166" cy="{FOOT_Y+fl:.1f}" rx="24" ry="11" fill="{P["dark"]}"/><ellipse cx="234" cy="{FOOT_Y+fr:.1f}" rx="24" ry="11" fill="{P["dark"]}"/>')
    s.append(f'<g transform="translate({CX} {FOOT_Y}) scale({p["sx"]:.4f} {p["sy"]:.4f}) translate({-CX} {-FOOT_Y}) rotate({p["rot"]:.2f} {CX} {FOOT_Y-20})">')
    ax, ay = ANT_BASE; tx, ty = ANT_TIP
    s.append(f'<g transform="rotate({p["ant_rot"]:.2f} {ax} {ay})" opacity="{p["ant_alpha"]:.2f}">')
    for (r, a, c) in p["ping"]:
        s.append(f'<circle cx="{tx}" cy="{ty}" r="{r:.2f}" fill="none" stroke="{c}" stroke-width="3" opacity="{a:.2f}"/>')
    s.append(f'<line x1="{ax}" y1="{ay+6}" x2="{tx}" y2="{ty+8}" stroke="{P["dark"]}" stroke-width="5" stroke-linecap="round"/><circle cx="{tx}" cy="{ty}" r="10" fill="{p["ant_color"]}" stroke="{P["dark"]}" stroke-width="2"/></g>')
    s.append(f'<ellipse cx="{CX}" cy="{CY}" rx="{RX}" ry="{RY}" fill="{P["body"] if flat else "url(#g)"}"/>')
    for bx in (CX - 46, CX + 46):
        s.append(f'<ellipse cx="{bx+p["fdx"]*0.6:.1f}" cy="{EYE_Y+16+p["fdy"]*0.6:.1f}" rx="12" ry="7" fill="{P["blush"]}" opacity="{p["blush"]*0.55:.2f}"/>')
    s.append(eyes(p["eye"], p["eye_open"], p["fdx"], p["fdy"], p["wink"]))
    s.append(mouth(p["mouth"], p["fdx"], p["fdy"]))
    s.append('</g>')
    s += p["extras"]
    s.append('</g></svg>')
    return "\n".join(s)

def frame(state, t, bg=P["bg"]): return render(POSES[state](t % DUR[state]), bg)
