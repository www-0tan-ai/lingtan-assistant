"""Vision-capability probe for gpt-5.3-codex on Azure AI Foundry.

Runs an independent battery of vision tests against the live Foundry endpoint
WITHOUT going through Hermes, so the results purely reflect the model+endpoint
capability and aren't entangled with Hermes' transport quirks.

Usage:
    python _vision_probe.py
    python _vision_probe.py --case basic_jpeg

Reads AZURE_FOUNDRY_API_KEY + AZURE_FOUNDRY_BASE_URL from env or ~/.hermes/.env.
"""
from __future__ import annotations

import argparse
import base64
import io
import json
import os
import sys
import time
import urllib.request
import urllib.error
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError:
    print("Pillow required. Install: pip install Pillow", file=sys.stderr)
    sys.exit(1)


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

MODEL = "gpt-5.3-codex"
TIMEOUT_SECONDS = 60


def load_env() -> tuple[str, str]:
    """Get API key + base URL from env, falling back to ~/.hermes/.env."""
    key = os.environ.get("AZURE_FOUNDRY_API_KEY", "").strip()
    url = os.environ.get("AZURE_FOUNDRY_BASE_URL", "").strip()
    if key and url:
        return key, url
    env_path = Path.home() / ".hermes" / ".env"
    if env_path.exists():
        for raw in env_path.read_text(encoding="utf-8").splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, _, v = line.partition("=")
            k = k.strip()
            v = v.strip().strip('"').strip("'")
            if k == "AZURE_FOUNDRY_API_KEY" and not key:
                key = v
            elif k == "AZURE_FOUNDRY_BASE_URL" and not url:
                url = v
    if not (key and url):
        print("Missing AZURE_FOUNDRY_API_KEY / AZURE_FOUNDRY_BASE_URL", file=sys.stderr)
        sys.exit(2)
    return key, url


# ---------------------------------------------------------------------------
# Image helpers
# ---------------------------------------------------------------------------

def encode_data_url(img: Image.Image, fmt: str = "PNG", quality: int = 90) -> str:
    buf = io.BytesIO()
    save_kwargs: dict[str, Any] = {}
    if fmt.upper() == "JPEG":
        save_kwargs["quality"] = quality
        if img.mode in ("RGBA", "P"):
            img = img.convert("RGB")
    img.save(buf, format=fmt, **save_kwargs)
    raw = buf.getvalue()
    mime = "image/png" if fmt.upper() == "PNG" else "image/jpeg"
    return f"data:{mime};base64,{base64.b64encode(raw).decode('ascii')}", len(raw)


def make_text_image(
    text: str,
    *,
    size: tuple[int, int] = (800, 200),
    bg: tuple[int, int, int] = (255, 255, 255),
    fg: tuple[int, int, int] = (10, 10, 10),
    font_size: int = 36,
) -> Image.Image:
    """White-background image with `text` rendered on it. OCR-friendly."""
    img = Image.new("RGB", size, bg)
    draw = ImageDraw.Draw(img)
    has_cjk = any(0x4E00 <= ord(ch) <= 0x9FFF for ch in text)
    if has_cjk:
        font_paths = (
            r"C:\Windows\Fonts\msyh.ttc",
            r"C:\Windows\Fonts\msyh.ttf",
            r"C:\Windows\Fonts\simsun.ttc",
            r"C:\Windows\Fonts\simhei.ttf",
        )
    else:
        font_paths = (
            r"C:\Windows\Fonts\arial.ttf",
            r"C:\Windows\Fonts\segoeui.ttf",
            r"C:\Windows\Fonts\msyh.ttc",
        )
    font = None
    for path in font_paths:
        try:
            font = ImageFont.truetype(path, font_size)
            break
        except Exception:
            continue
    if font is None:
        font = ImageFont.load_default()
    bbox = draw.textbbox((0, 0), text, font=font)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    draw.text(((size[0] - tw) // 2, (size[1] - th) // 2), text, fill=fg, font=font)
    return img


def make_color_grid(
    rows: int = 2,
    cols: int = 2,
    cell: int = 200,
    colors: list[str] | None = None,
) -> Image.Image:
    """rows*cols colored cells — for color/spatial reasoning tests."""
    palette = colors or ["red", "green", "blue", "yellow"]
    img = Image.new("RGB", (cols * cell, rows * cell), "white")
    draw = ImageDraw.Draw(img)
    for r in range(rows):
        for c in range(cols):
            color = palette[(r * cols + c) % len(palette)]
            draw.rectangle(
                [c * cell, r * cell, (c + 1) * cell, (r + 1) * cell],
                fill=color,
            )
    return img


def make_count_image(num_circles: int, size: int = 600) -> Image.Image:
    """Render N evenly-spaced black circles for counting tests."""
    img = Image.new("RGB", (size, size), "white")
    draw = ImageDraw.Draw(img)
    cols = max(1, int(num_circles ** 0.5 + 0.5))
    rows = (num_circles + cols - 1) // cols
    cell_w = size // (cols + 1)
    cell_h = size // (rows + 1)
    radius = min(cell_w, cell_h) // 4
    drawn = 0
    for r in range(rows):
        for c in range(cols):
            if drawn >= num_circles:
                break
            cx = (c + 1) * cell_w
            cy = (r + 1) * cell_h
            draw.ellipse([cx - radius, cy - radius, cx + radius, cy + radius], fill="black")
            drawn += 1
    return img


# ---------------------------------------------------------------------------
# HTTP probe
# ---------------------------------------------------------------------------

@dataclass
class Result:
    name: str
    ok: bool
    status: int
    elapsed_ms: int
    bytes_in: int
    answer: str = ""
    error: str = ""
    details: dict[str, Any] = field(default_factory=dict)


def call_responses(
    base_url: str,
    api_key: str,
    *,
    text: str,
    images: list[str] | None = None,
    instructions: str = "You are a precise visual question-answering assistant. Be concise.",
    max_retries: int = 2,
) -> tuple[int, dict, int]:
    """POST a single-turn multimodal request to /responses. Returns (status, body, elapsed_ms).

    Retries once on transient TLS errors (Azure occasionally drops the
    connection during large multipart base64 uploads).
    """
    content: list[dict] = [{"type": "input_text", "text": text}]
    for url in images or []:
        content.append({"type": "input_image", "image_url": url, "detail": "auto"})

    payload = {
        "model": MODEL,
        "instructions": instructions,
        "store": False,
        "input": [{"role": "user", "content": content}],
    }
    body = json.dumps(payload).encode("utf-8")
    last_exc: Exception | None = None
    for attempt in range(max_retries + 1):
        req = urllib.request.Request(
            f"{base_url.rstrip('/')}/responses",
            data=body,
            method="POST",
            headers={
                "api-key": api_key,
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
        )
        t0 = time.monotonic()
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT_SECONDS) as resp:
                raw = resp.read()
                elapsed = int((time.monotonic() - t0) * 1000)
                return resp.status, json.loads(raw.decode("utf-8", errors="replace")), elapsed
        except urllib.error.HTTPError as exc:
            elapsed = int((time.monotonic() - t0) * 1000)
            try:
                return exc.code, json.loads(exc.read().decode("utf-8", errors="replace")), elapsed
            except Exception:
                return exc.code, {"error": str(exc)}, elapsed
        except (urllib.error.URLError, ConnectionError, TimeoutError, OSError) as exc:
            last_exc = exc
            if attempt < max_retries:
                time.sleep(1.5 * (attempt + 1))
                continue
            elapsed = int((time.monotonic() - t0) * 1000)
            return -1, {"error": f"{type(exc).__name__}: {exc}"}, elapsed
    return -1, {"error": f"all retries exhausted: {last_exc}"}, 0


def extract_text(body: dict) -> str:
    out = body.get("output") or []
    chunks: list[str] = []
    for item in out:
        if not isinstance(item, dict) or item.get("type") != "message":
            continue
        for part in item.get("content") or []:
            if isinstance(part, dict) and part.get("type") == "output_text":
                chunks.append(part.get("text") or "")
    return " ".join(chunks).strip()


# ---------------------------------------------------------------------------
# Test cases
# ---------------------------------------------------------------------------

def case_text_only(base_url: str, api_key: str) -> Result:
    """Sanity check — pure text request, no image."""
    status, body, ms = call_responses(
        base_url, api_key,
        text="Reply with the single word 'PONG' and nothing else.",
        images=[],
    )
    answer = extract_text(body)
    return Result(
        name="text_only_baseline",
        ok=(status == 200 and "PONG" in answer.upper()),
        status=status, elapsed_ms=ms, bytes_in=0,
        answer=answer,
        error="" if status == 200 else json.dumps(body)[:300],
    )


def case_basic_png(base_url: str, api_key: str) -> Result:
    """Single PNG image with embedded text — checks OCR + multimodal routing."""
    img = make_text_image("BANANA-7842")
    url, n = encode_data_url(img, "PNG")
    status, body, ms = call_responses(
        base_url, api_key,
        text="What text is shown in this image? Reply with only the text.",
        images=[url],
    )
    answer = extract_text(body)
    return Result(
        name="basic_png_ocr",
        ok=(status == 200 and "BANANA-7842" in answer.upper()),
        status=status, elapsed_ms=ms, bytes_in=n,
        answer=answer,
        error="" if status == 200 else json.dumps(body)[:300],
    )


def case_basic_jpeg(base_url: str, api_key: str) -> Result:
    """Same OCR but as JPEG — checks JPEG mime is accepted."""
    img = make_text_image("ZEBRA-1234")
    url, n = encode_data_url(img, "JPEG")
    status, body, ms = call_responses(
        base_url, api_key,
        text="What text is shown in this image? Reply with only the text.",
        images=[url],
    )
    answer = extract_text(body)
    return Result(
        name="basic_jpeg_ocr",
        ok=(status == 200 and "ZEBRA-1234" in answer.upper()),
        status=status, elapsed_ms=ms, bytes_in=n,
        answer=answer,
        error="" if status == 200 else json.dumps(body)[:300],
    )


def case_chinese_text(base_url: str, api_key: str) -> Result:
    """Chinese OCR — many vision models lose CJK on small models."""
    target = "零谈助手"
    img = make_text_image(target, size=(800, 250), font_size=80)
    # Save the rendered image so we can verify the input was correct
    debug_path = Path(__file__).with_name("_vision_probe_chinese.png")
    img.save(debug_path)
    url, n = encode_data_url(img, "PNG")
    status, body, ms = call_responses(
        base_url, api_key,
        text="图片里写了什么字？只回复字本身，不要任何其他内容。",
        images=[url],
    )
    answer = extract_text(body)
    ok = status == 200 and target in answer
    return Result(
        name="chinese_ocr",
        ok=ok, status=status, elapsed_ms=ms, bytes_in=n,
        answer=answer,
        error="" if status == 200 else json.dumps(body)[:300],
        details={"target": target, "rendered_image": str(debug_path)},
    )


def case_color_grid(base_url: str, api_key: str) -> Result:
    """2x2 colored squares — spatial reasoning."""
    img = make_color_grid(2, 2, cell=200, colors=["red", "green", "blue", "yellow"])
    url, n = encode_data_url(img, "PNG")
    status, body, ms = call_responses(
        base_url, api_key,
        text=(
            "This is a 2x2 grid of colored squares. List the colors in reading order "
            "(top-left, top-right, bottom-left, bottom-right) separated by commas."
        ),
        images=[url],
    )
    answer = extract_text(body).lower()
    expected = ["red", "green", "blue", "yellow"]
    matched = sum(1 for c in expected if c in answer)
    return Result(
        name="color_grid_spatial",
        ok=(status == 200 and matched == 4),
        status=status, elapsed_ms=ms, bytes_in=n,
        answer=extract_text(body),
        error="" if status == 200 else json.dumps(body)[:300],
        details={"colors_matched": matched, "expected": expected},
    )


def case_counting(base_url: str, api_key: str) -> Result:
    """Count black circles — fine-grained visual perception."""
    target = 7
    img = make_count_image(target, size=600)
    url, n = encode_data_url(img, "PNG")
    status, body, ms = call_responses(
        base_url, api_key,
        text="Count the black circles in this image. Reply with only the number.",
        images=[url],
    )
    answer = extract_text(body)
    digits = "".join(ch for ch in answer if ch.isdigit())
    return Result(
        name="counting",
        ok=(status == 200 and digits == str(target)),
        status=status, elapsed_ms=ms, bytes_in=n,
        answer=answer,
        error="" if status == 200 else json.dumps(body)[:300],
        details={"target": target, "model_says": digits or answer},
    )


def case_multi_image(base_url: str, api_key: str) -> Result:
    """Two images in one turn — checks multi-image input."""
    img_a = make_text_image("FIRST")
    img_b = make_text_image("SECOND")
    url_a, na = encode_data_url(img_a, "PNG")
    url_b, nb = encode_data_url(img_b, "PNG")
    status, body, ms = call_responses(
        base_url, api_key,
        text=(
            "I am sending two images. The first contains one word, the second contains "
            "another word. Reply with: 'image1=<word>; image2=<word>'."
        ),
        images=[url_a, url_b],
    )
    answer = extract_text(body).upper()
    return Result(
        name="multi_image",
        ok=(status == 200 and "FIRST" in answer and "SECOND" in answer),
        status=status, elapsed_ms=ms, bytes_in=na + nb,
        answer=extract_text(body),
        error="" if status == 200 else json.dumps(body)[:300],
    )


def case_large_image_2k(base_url: str, api_key: str) -> Result:
    """Larger 2048x2048 image — checks resolution handling."""
    img = make_text_image("HIGHRES-9988", size=(2048, 2048), font_size=160)
    url, n = encode_data_url(img, "PNG")
    status, body, ms = call_responses(
        base_url, api_key,
        text="Read the text in this image. Reply with just the text.",
        images=[url],
    )
    answer = extract_text(body).upper()
    return Result(
        name="large_image_2k",
        ok=(status == 200 and "HIGHRES-9988" in answer),
        status=status, elapsed_ms=ms, bytes_in=n,
        answer=extract_text(body),
        error="" if status == 200 else json.dumps(body)[:300],
    )


def case_real_screenshot(base_url: str, api_key: str) -> Result:
    """Real screenshot from the workspace, if present."""
    candidates = [
        Path.home() / "workspace" / "screenshot-1778248495994.png",
        Path.home() / "workspace" / "567b7099-a940-4d2f-9f8c-25ac9e72f94a.png",
    ]
    pic = next((p for p in candidates if p.exists()), None)
    if pic is None:
        return Result(
            name="real_screenshot",
            ok=True, status=0, elapsed_ms=0, bytes_in=0,
            answer="(skipped — no real screenshot in ~/workspace/)",
        )
    img = Image.open(pic)
    if img.mode == "RGBA":
        img = img.convert("RGB")
    url, n = encode_data_url(img, "PNG")
    status, body, ms = call_responses(
        base_url, api_key,
        text=(
            "Describe this screenshot in 2-3 sentences: what application/page is it, "
            "and what is the user looking at?"
        ),
        images=[url],
    )
    answer = extract_text(body)
    return Result(
        name="real_screenshot",
        ok=(status == 200 and len(answer) > 20),
        status=status, elapsed_ms=ms, bytes_in=n,
        answer=answer[:600],
        error="" if status == 200 else json.dumps(body)[:300],
        details={"file": str(pic), "size_bytes": pic.stat().st_size},
    )


CASES = {
    "text_only": case_text_only,
    "basic_png": case_basic_png,
    "basic_jpeg": case_basic_jpeg,
    "chinese": case_chinese_text,
    "color_grid": case_color_grid,
    "counting": case_counting,
    "multi_image": case_multi_image,
    "large_2k": case_large_image_2k,
    "real_screenshot": case_real_screenshot,
}


# ---------------------------------------------------------------------------
# Driver
# ---------------------------------------------------------------------------

def fmt_kb(n: int) -> str:
    return f"{n/1024:6.1f} KB"


def run(args: argparse.Namespace) -> int:
    # Force stdout to UTF-8 so CJK results don't render as mojibake on
    # cp936/gbk Windows consoles.
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

    api_key, base_url = load_env()
    print(f"endpoint : {base_url}")
    print(f"model    : {MODEL}")
    print(f"timeout  : {TIMEOUT_SECONDS}s")
    print()

    cases = list(CASES.items()) if not args.case else [(args.case, CASES[args.case])]
    results: list[Result] = []
    print(f"{'#':<2} {'case':<22} {'status':<6} {'ms':>6} {'bytes':>10}  result")
    print("-" * 90)
    for i, (name, fn) in enumerate(cases, 1):
        try:
            r = fn(base_url, api_key)
        except Exception as exc:
            r = Result(name=name, ok=False, status=-1, elapsed_ms=0, bytes_in=0, error=str(exc))
        results.append(r)
        flag = "PASS" if r.ok else "FAIL"
        print(
            f"{i:<2} {r.name:<22} {r.status:<6} {r.elapsed_ms:>5}  {fmt_kb(r.bytes_in)}  [{flag}]  "
            f"{(r.answer or r.error)[:70]}"
        )

    print()
    passed = sum(1 for r in results if r.ok)
    print(f"summary: {passed}/{len(results)} passed")

    print()
    print("=" * 90)
    print("DETAIL")
    print("=" * 90)
    for r in results:
        print(f"\n[{r.name}] {'PASS' if r.ok else 'FAIL'}  http={r.status} {r.elapsed_ms}ms  {fmt_kb(r.bytes_in)}")
        if r.answer:
            print(f"  answer : {r.answer[:500]}")
        if r.error:
            print(f"  error  : {r.error[:500]}")
        if r.details:
            print(f"  details: {r.details}")
    return 0 if passed == len(results) else 1


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--case", choices=list(CASES.keys()), help="run a single case")
    sys.exit(run(p.parse_args()))
