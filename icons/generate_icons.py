"""Generate KnowledgeBase extension icons (purple gradient rounded square + K)."""
from PIL import Image, ImageDraw

# Brand gradient: #6366f1 -> #8b5cf6 (matches popup .brand .dot)
C1 = (99, 102, 241)
C2 = (139, 92, 246)
SIZES = [16, 32, 48, 128]


def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


def make_icon(size):
    scale = 4  # supersample for smooth edges
    s = size * scale
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))

    # Diagonal gradient (top-left -> bottom-right).
    grad = Image.new("RGB", (s, s))
    gpx = grad.load()
    for y in range(s):
        for x in range(s):
            t = (x + y) / (2 * (s - 1))
            gpx[x, y] = lerp(C1, C2, t)

    # Rounded-square mask.
    mask = Image.new("L", (s, s), 0)
    md = ImageDraw.Draw(mask)
    radius = int(s * 0.22)
    md.rounded_rectangle([0, 0, s - 1, s - 1], radius=radius, fill=255)
    img.paste(grad, (0, 0), mask)

    # Draw a white "K" using strokes so it stays crisp at every size.
    d = ImageDraw.Draw(img)
    w = max(2, int(s * 0.11))
    top = int(s * 0.26)
    bot = int(s * 0.74)
    x_bar = int(s * 0.34)
    x_arm = int(s * 0.70)
    mid = (top + bot) // 2
    white = (255, 255, 255, 255)
    d.line([(x_bar, top), (x_bar, bot)], fill=white, width=w)
    d.line([(x_bar, mid), (x_arm, top)], fill=white, width=w)
    d.line([(x_bar, mid), (x_arm, bot)], fill=white, width=w)
    # Round the stroke ends/joints.
    for (cx, cy) in [(x_bar, top), (x_bar, bot), (x_bar, mid), (x_arm, top), (x_arm, bot)]:
        r = w // 2
        d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=white)

    return img.resize((size, size), Image.LANCZOS)


for size in SIZES:
    make_icon(size).save(f"icon{size}.png")
    print(f"wrote icon{size}.png")
