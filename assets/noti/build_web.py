import noti
from noti import P, CX, CY, RX, RY, FOOT_Y, EYE_DX, EYE_Y, EYE_R, ANT_BASE, ANT_TIP, W, H
ax, ay = ANT_BASE; tx, ty = ANT_TIP; EL, ER = CX - EYE_DX, CX + EYE_DX; MY = EYE_Y + 22
def ev():
    o = '<g class="v eye-open">' + ''.join(f'<g class="blink" style="transform-origin:{x}px {EYE_Y}px"><circle cx="{x}" cy="{EYE_Y}" r="{EYE_R}" fill="{P["ink"]}"/><circle cx="{x-2.5}" cy="{EYE_Y-3}" r="2.4" fill="#fff"/></g>' for x in (EL, ER)) + '</g>'
    o += '<g class="v eye-happy">' + ''.join(f'<path d="M{x-9} {EYE_Y+3} Q{x} {EYE_Y-10} {x+9} {EYE_Y+3}" fill="none" stroke="{P["ink"]}" stroke-width="5" stroke-linecap="round"/>' for x in (EL, ER)) + '</g>'
    o += '<g class="v eye-focused">' + ''.join(f'<clipPath id="lid{i}"><rect x="{x-11}" y="{EYE_Y-1}" width="22" height="24"/></clipPath><circle cx="{x}" cy="{EYE_Y}" r="{EYE_R}" fill="{P["ink"]}" clip-path="url(#lid{i})"/>' for i, x in enumerate((EL, ER))) + '</g>'
    o += '<g class="v eye-closed">' + ''.join(f'<path d="M{x-8} {EYE_Y+1} Q{x} {EYE_Y+7} {x+8} {EYE_Y+1}" fill="none" stroke="{P["ink"]}" stroke-width="4.5" stroke-linecap="round"/>' for x in (EL, ER)) + '</g>'
    o += '<g class="v eye-worried">' + ''.join(f'<circle cx="{x}" cy="{EYE_Y}" r="{EYE_R}" fill="{P["ink"]}"/><circle cx="{x-2.5}" cy="{EYE_Y-3}" r="2.4" fill="#fff"/><path d="M{x-9*s} {EYE_Y-15} L{x+7*s} {EYE_Y-20}" stroke="{P["ink"]}" stroke-width="4" stroke-linecap="round"/>' for x, s in ((EL, -1), (ER, 1))) + '</g>'
    return o
def mv():
    x, y, k = CX, MY, P["ink"]
    return (f'<path class="v m-smile" d="M{x-11} {y-2} Q{x} {y+11} {x+11} {y-2}" fill="none" stroke="{k}" stroke-width="4.5" stroke-linecap="round"/>'
            f'<g class="v m-grin"><path d="M{x-16} {y-4} Q{x} {y+22} {x+16} {y-4} Z" fill="{k}"/><path d="M{x-8} {y+7} Q{x} {y+13} {x+8} {y+7} Z" fill="{P["blush"]}"/></g>'
            f'<ellipse class="v m-o" cx="{x}" cy="{y+2}" rx="6" ry="7.5" fill="{k}"/>'
            f'<path class="v m-flat" d="M{x-11} {y+1} L{x+10} {y-1}" stroke="{k}" stroke-width="4.5" stroke-linecap="round"/>'
            f'<path class="v m-wavy" d="M{x-16} {y} Q{x-8} {y-7} {x} {y} T{x+16} {y}" fill="none" stroke="{k}" stroke-width="4.5" stroke-linecap="round"/>'
            f'<path class="v m-tiny" d="M{x-6} {y} Q{x} {y+5} {x+6} {y}" fill="none" stroke="{k}" stroke-width="4" stroke-linecap="round"/>')
def extras():
    e = '<g class="x dots">' + ''.join(f'<circle cx="{x}" cy="{y}" r="{r}" fill="{P["joint"]}" stroke="{P["dark"]}" stroke-width="2" style="transform-origin:{x}px {y}px"/>' for x, y, r in [(258,128,5),(278,108,7),(304,90,9)]) + '</g>'
    e += f'<g class="x orbit" style="transform-origin:{CX}px {CY+10}px"><circle cx="{CX+128}" cy="{CY+10}" r="7" fill="{P["joint"]}" stroke="{P["dark"]}" stroke-width="2"/></g>'
    e += '<g class="x sparks">' + ''.join(f'<path d="M{x} {y-5} V{y+5} M{x-5} {y} H{x+5}" stroke="{P["cream"]}" stroke-width="3" stroke-linecap="round" style="transform-origin:{x}px {y}px"/>' for x, y in [(200,110),(228,120),(172,120)]) + '</g>'
    e += '<path class="x sweat" d="M276 164 C 284 176 284 182 276 184 C 268 182 268 176 276 164 Z" fill="#8fd3f4"/>'
    e += f'<g class="x bang" style="transform-origin:306px 104px"><g transform="translate(306 104) rotate(12)"><rect x="-14" y="-18" width="28" height="36" rx="7" fill="{P["coral"]}"/><text x="0" y="9" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-weight="700" font-size="26" fill="#fff">!</text></g></g>'
    e += '<g class="x zzz">' + ''.join(f'<text x="{268+i*8}" y="156" font-family="Helvetica, Arial, sans-serif" font-weight="800" font-size="{14+i*5}" fill="{P["dark"]}" transform="rotate(-12 268 156)">z</text>' for i in range(3)) + '</g>'
    cols = [P["body"], P["lilac"], P["cream"], P["joint"], P["blush"]]
    e += '<g class="x confetti">' + ''.join(f'<rect x="{195+(i%5-2)*12}" y="140" width="10" height="6" rx="1.5" fill="{cols[i%5]}" style="--dx:{(i-4)*42}px;--rot:{(i*77)%360+360}deg"/>' for i in range(9)) + '</g>'
    return e
CSS = f"""
.noti *{{transform-box:view-box}} .noti .v,.noti .x{{display:none}}
.noti .ant{{transform-origin:{ax}px {ay}px}} .noti .ping{{transform-origin:{tx}px {ty}px;vector-effect:non-scaling-stroke;opacity:0}}
.noti .squash{{transform-origin:{CX}px {FOOT_Y}px}} .noti .tilt{{transform-origin:{CX}px {FOOT_Y-20}px}} .noti .ground{{transform-origin:{CX}px {FOOT_Y+14}px}}
@keyframes breathe{{0%,100%{{transform:scale(1,1)}}50%{{transform:scale(1.012,.98)}}}}
@keyframes breatheDeep{{0%,100%{{transform:scale(1,1)}}50%{{transform:scale(1.02,.965)}}}}
@keyframes antTilt{{0%,100%{{transform:rotate(-5deg)}}50%{{transform:rotate(5deg)}}}}
@keyframes antWag{{0%,100%{{transform:rotate(-18deg)}}50%{{transform:rotate(18deg)}}}}
@keyframes blink{{0%,70%,76%,100%{{transform:scaleY(1)}}73%{{transform:scaleY(.08)}}}}
@keyframes wink{{0%,14%,56%,100%{{transform:scaleY(1)}}16%,54%{{transform:scaleY(.08)}}}}
@keyframes ping{{0%{{transform:scale(1);opacity:.5}}100%{{transform:scale(3.2);opacity:0}}}}
@keyframes rock{{0%,100%{{transform:rotate(-7deg)}}50%{{transform:rotate(7deg)}}}}
@keyframes hop{{0%,100%{{transform:translateY(0)}}50%{{transform:translateY(-14px)}}}}
@keyframes wobble{{0%,100%{{transform:rotate(-5deg)}}50%{{transform:rotate(5deg)}}}}
@keyframes orbit{{0%{{transform:rotate(0) scale(1,.25) rotate(0)}}100%{{transform:rotate(360deg) scale(1,.25) rotate(-360deg)}}}}
@keyframes dot{{0%{{transform:scale(0);opacity:1}}20%,80%{{transform:scale(1);opacity:1}}100%{{transform:scale(1);opacity:0}}}}
@keyframes spark{{0%,60%{{opacity:0;transform:scale(.4)}}70%{{opacity:1;transform:scale(1)}}100%{{opacity:0;transform:scale(1.4) translateY(-10px)}}}}
@keyframes jump{{0%,9%{{transform:translateY(0)}}34%{{transform:translateY(-50px)}}59%,100%{{transform:translateY(0)}}}}
@keyframes jumpSquash{{0%{{transform:scale(1,1)}}9%{{transform:scale(1.1,.88)}}34%{{transform:scale(.95,1.07)}}59%{{transform:scale(1,1)}}68%{{transform:scale(1.12,.86)}}78%,100%{{transform:scale(1,1)}}}}
@keyframes groundJump{{0%,9%{{transform:scale(1)}}34%{{transform:scale(.6);opacity:.07}}59%,100%{{transform:scale(1)}}}}
@keyframes confetti{{0%,12%{{transform:translate(0,0) rotate(0);opacity:0}}14%{{opacity:1}}100%{{transform:translate(var(--dx),300px) rotate(var(--rot));opacity:0}}}}
@keyframes shake{{0%,100%{{transform:translateX(0)}}8%{{transform:translateX(7px)}}20%{{transform:translateX(-6px)}}32%{{transform:translateX(5px)}}44%{{transform:translateX(-3px)}}55%{{transform:translateX(0)}}}}
@keyframes alert{{0%,100%{{opacity:.45}}50%{{opacity:1}}}}
@keyframes sweat{{0%{{transform:translateY(0);opacity:1}}70%{{opacity:1}}100%{{transform:translateY(60px);opacity:0}}}}
@keyframes pop{{0%{{transform:scale(0)}}60%{{transform:scale(1.15)}}100%{{transform:scale(1)}}}}
@keyframes zzz{{0%{{transform:translate(0,0);opacity:0}}30%{{opacity:.9}}100%{{transform:translate(26px,-70px);opacity:0}}}}
.noti[data-state=idle] .eye-open,.noti[data-state=idle] .m-smile{{display:inline}}
.noti[data-state=idle] .squash{{animation:breathe 4s ease-in-out infinite}} .noti[data-state=idle] .ant{{animation:antTilt 4s ease-in-out infinite .6s}}
.noti[data-state=idle] .blink{{animation:blink 4s linear infinite}} .noti[data-state=idle] .p1{{animation:ping 2s ease-out infinite}}
.noti[data-state=wave] .eye-open,.noti[data-state=wave] .m-grin{{display:inline}}
.noti[data-state=wave] .tilt{{animation:rock 1s ease-in-out infinite}} .noti[data-state=wave] .root{{animation:hop 1s ease-in-out infinite}}
.noti[data-state=wave] .ant{{animation:antWag .5s ease-in-out infinite}} .noti[data-state=wave] .blink:last-child{{animation:wink 2s linear infinite}}
.noti[data-state=wave] .p1{{animation:ping 1s ease-out infinite}}
.noti[data-state=thinking] .eye-focused,.noti[data-state=thinking] .m-o,.noti[data-state=thinking] .dots{{display:inline}}
.noti[data-state=thinking] .face{{transform:translate(7px,-6px)}} .noti[data-state=thinking] .tilt{{transform:rotate(4deg)}}
.noti[data-state=thinking] .ant{{animation:antTilt 1.2s ease-in-out infinite}} .noti[data-state=thinking] .p1{{animation:ping .9s ease-out infinite}} .noti[data-state=thinking] .p2{{animation:ping .9s ease-out infinite .45s}}
.noti[data-state=thinking] .dots circle{{animation:dot 2.4s ease-in-out infinite}} .noti[data-state=thinking] .dots circle:nth-child(2){{animation-delay:.43s}} .noti[data-state=thinking] .dots circle:nth-child(3){{animation-delay:.86s}}
.noti[data-state=working] .eye-focused,.noti[data-state=working] .m-flat,.noti[data-state=working] .orbit,.noti[data-state=working] .sparks{{display:inline}}
.noti[data-state=working] .face{{transform:translateY(4px)}} .noti[data-state=working] .tilt{{animation:wobble .8s ease-in-out infinite}}
.noti[data-state=working] .squash{{animation:breathe .8s ease-in-out infinite}} .noti[data-state=working] .p1{{animation:ping .8s ease-out infinite}}
.noti[data-state=working] .orbit{{animation:orbit 1.6s linear infinite}}
.noti[data-state=working] .sparks path{{animation:spark .8s ease-out infinite}} .noti[data-state=working] .sparks path:nth-child(2){{animation-delay:.07s}} .noti[data-state=working] .sparks path:nth-child(3){{animation-delay:.14s}}
.noti[data-state=success] .eye-happy,.noti[data-state=success] .m-grin,.noti[data-state=success] .confetti{{display:inline}}
.noti[data-state=success] .root{{animation:jump 1.6s ease-in-out infinite}} .noti[data-state=success] .squash{{animation:jumpSquash 1.6s ease-in-out infinite}}
.noti[data-state=success] .ground{{animation:groundJump 1.6s ease-in-out infinite}} .noti[data-state=success] .p1{{animation:ping .8s ease-out infinite}} .noti[data-state=success] .p2{{animation:ping .8s ease-out infinite .4s}}
.noti[data-state=success] .confetti rect{{animation:confetti 1.6s cubic-bezier(.3,.7,.6,1) infinite}}
.noti[data-state=error] .eye-worried,.noti[data-state=error] .m-wavy,.noti[data-state=error] .sweat,.noti[data-state=error] .bang{{display:inline}}
.noti[data-state=error] .root{{animation:shake 1.2s linear infinite}} .noti[data-state=error] .anttip{{fill:{P["coral"]};animation:alert .33s ease-in-out infinite}}
.noti[data-state=error] .p1{{stroke:{P["coral"]};animation:ping .6s ease-out infinite}} .noti[data-state=error] .sweat{{animation:sweat 1.2s ease-in-out infinite}} .noti[data-state=error] .bang{{animation:pop 1.2s cubic-bezier(.3,1.4,.6,1) infinite}}
.noti[data-state=sleep] .eye-closed,.noti[data-state=sleep] .m-tiny,.noti[data-state=sleep] .zzz{{display:inline}}
.noti[data-state=sleep] .squash{{animation:breatheDeep 4s ease-in-out infinite}} .noti[data-state=sleep] .tilt{{transform:rotate(5deg)}} .noti[data-state=sleep] .ant{{transform:rotate(18deg);opacity:.4}}
.noti[data-state=sleep] .zzz text{{animation:zzz 2.4s ease-out infinite}} .noti[data-state=sleep] .zzz text:nth-child(2){{animation-delay:.8s}} .noti[data-state=sleep] .zzz text:nth-child(3){{animation-delay:1.6s}}
@media (prefers-reduced-motion:reduce){{.noti *{{animation:none!important}}}}
"""
def build(state='idle'):
    s = f'<svg xmlns="http://www.w3.org/2000/svg" class="noti" data-state="{state}" viewBox="0 0 {W} {H}" width="{W}" height="{H}" role="img" aria-label="Noti, the negotium mascot ({state})"><style>{CSS}</style>{noti.DEFS}'
    s += f'<g class="confetti x">{extras().split("<g class=\"x confetti\">")[1]}'  # confetti behind
    s += f'<ellipse class="ground" cx="{CX}" cy="{FOOT_Y+14}" rx="72" ry="9" fill="{P["shadow"]}" opacity=".13"/><g class="root">'
    s += f'<ellipse cx="166" cy="{FOOT_Y}" rx="24" ry="11" fill="{P["dark"]}"/><ellipse cx="234" cy="{FOOT_Y}" rx="24" ry="11" fill="{P["dark"]}"/>'
    s += '<g class="squash"><g class="tilt">'
    s += f'<g class="ant"><circle class="ping p1" cx="{tx}" cy="{ty}" r="12" fill="none" stroke="{P["joint"]}" stroke-width="3"/><circle class="ping p2" cx="{tx}" cy="{ty}" r="12" fill="none" stroke="{P["joint"]}" stroke-width="3"/>'
    s += f'<line x1="{ax}" y1="{ay+6}" x2="{tx}" y2="{ty+8}" stroke="{P["dark"]}" stroke-width="5" stroke-linecap="round"/><circle class="anttip" cx="{tx}" cy="{ty}" r="10" fill="{P["joint"]}" stroke="{P["dark"]}" stroke-width="2"/></g>'
    s += f'<ellipse cx="{CX}" cy="{CY}" rx="{RX}" ry="{RY}" fill="url(#g)"/><g class="face">'
    s += ''.join(f'<ellipse cx="{bx}" cy="{EYE_Y+16}" rx="12" ry="7" fill="{P["blush"]}" opacity=".3"/>' for bx in (CX-46, CX+46))
    s += ev() + mv() + '</g></g></g>' + extras().split('<g class="x confetti">')[0] + '</g></svg>'
    return s
STATES = list(noti.DUR)
open('out/noti-animated.svg','w').write(build('idle'))
html = f"""<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Noti — negotium mascot</title><style>
body{{margin:0;background:#f8f7ff;font:14px/1.4 -apple-system,Helvetica,Arial,sans-serif;color:#3d2f86}} h1{{font-size:20px;margin:24px 28px 4px}} p{{margin:0 28px 16px;color:#6a5db8}}
.grid{{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;padding:0 20px 20px}} .tile{{background:#fff;border-radius:16px;box-shadow:0 2px 10px rgba(74,58,167,.08);text-align:center;padding:8px}}
.tile svg{{width:100%;height:auto}} .tile b{{display:block;padding:4px 0 6px;color:#5f48a0}} .stage{{display:flex;gap:16px;align-items:center;padding:0 28px 32px}} .stage svg{{width:260px;height:260px}}
button{{background:#ddd3f7;color:#3d2f86;border:0;border-radius:999px;padding:8px 14px;margin:4px;cursor:pointer;font-weight:600}} button.on{{background:#6a5db8;color:#fff}} code{{background:#f1eefc;padding:2px 6px;border-radius:6px}}
</style></head><body><h1>Noti — negotium mascot · animation set</h1><p>One SVG, state switched by <code>data-state</code>: {' · '.join(STATES)}</p>
<div class="grid">{''.join(f'<div class="tile">{build(st)}<b>{st}</b></div>' for st in STATES)}</div>
<div class="stage" id="stage">{build('idle')}<div>{''.join(f'<button data-s="{st}">{st}</button>' for st in STATES)}<p style="margin:10px 0 0">JS: <code>svg.dataset.state = "working"</code></p></div></div>
<script>document.querySelectorAll('#stage button').forEach(b=>b.onclick=()=>{{document.querySelector('#stage svg').dataset.state=b.dataset.s;document.querySelectorAll('#stage button').forEach(x=>x.classList.toggle('on',x===b))}});document.querySelector('#stage button').classList.add('on')</script></body></html>"""
open('out/demo.html','w').write(html); print('web ok')
