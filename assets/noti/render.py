import noti, cairosvg, io, subprocess, os
from PIL import Image, ImageDraw, ImageFont
os.makedirs('out', exist_ok=True); FPS = 24
states = list(noti.DUR)
def png(svg, size=400): return Image.open(io.BytesIO(cairosvg.svg2png(bytestring=svg.encode(), output_width=size, output_height=size))).convert('RGB')
frames = {}
for st in states:
    n = int(noti.DUR[st] * FPS); frames[st] = [png(noti.frame(st, i / FPS)) for i in range(n)]
    gif = [f.quantize(colors=96, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE) for f in frames[st]]
    gif[0].save(f'out/noti-{st}.gif', save_all=True, append_images=gif[1:], duration=int(1000/FPS), loop=0, optimize=True)
# readme strip gif: 7 states side by side, 320px tall, 4.8s
T = 4.8; N = int(T * FPS); strip = []
for i in range(N):
    c = Image.new('RGB', (7*200, 200), '#f8f7ff')
    for k, st in enumerate(states): c.paste(frames[st][i % len(frames[st])].resize((200, 200), Image.LANCZOS), (k*200, 0))
    strip.append(c.quantize(colors=96, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE))
strip[0].save('out/noti-states.gif', save_all=True, append_images=strip[1:], duration=int(1000/FPS), loop=0, optimize=True)
# grid mp4 preview
font = ImageFont.truetype('/System/Library/Fonts/Helvetica.ttc', 22)
proc = subprocess.Popen(['ffmpeg','-y','-loglevel','error','-f','rawvideo','-pix_fmt','rgb24','-s','1600x880','-r',str(FPS),'-i','-','-c:v','libx264','-pix_fmt','yuv420p','-crf','20','-movflags','+faststart','out/noti-animation-set.mp4'], stdin=subprocess.PIPE)
for i in range(N):
    c = Image.new('RGB', (1600, 880), '#f8f7ff'); d = ImageDraw.Draw(c)
    for k, st in enumerate(states):
        x, y = (k % 4) * 400, (k // 4) * 440; c.paste(frames[st][i % len(frames[st])], (x, y + 40)); d.text((x + 200, y + 22), st, fill='#5f48a0', font=font, anchor='mm')
    proc.stdin.write(c.tobytes())
proc.stdin.close(); proc.wait()
open('out/noti.svg','w').write(noti.frame('idle', 0.0, bg=None))
open('out/noti-icon.svg','w').write(noti.render(noti.base(), bg=None, flat=True))
cairosvg.svg2png(url='out/noti.svg', write_to='out/noti.png', output_width=1024, output_height=1024)
cairosvg.svg2png(url='out/noti-icon.svg', write_to='out/noti-icon-512.png', output_width=512, output_height=512)
print('ok')
