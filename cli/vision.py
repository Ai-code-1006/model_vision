"""
Image understanding CLI helper.
Usage: python vision.py <image-path> [prompt]
"""
import io
import subprocess
import sys
from pathlib import Path

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8")

SKILL_ROOT = Path(__file__).resolve().parents[1]
ANALYZE_IMAGE_JS = SKILL_ROOT / "router" / "cli.js"


def understand_image(image_path, prompt=None):
    if not ANALYZE_IMAGE_JS.exists():
        raise FileNotFoundError(f"Shared analyzer not found: {ANALYZE_IMAGE_JS}")

    resolved_image_path = str(Path(image_path).resolve())
    command = ["node", str(ANALYZE_IMAGE_JS), resolved_image_path]
    if prompt:
        command.append(prompt)

    completed = subprocess.run(
        command,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=180,
        check=False,
    )

    if completed.returncode != 0:
        message = completed.stderr.strip() or completed.stdout.strip() or "unknown error"
        raise RuntimeError(message)

    print(completed.stdout.strip())


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python image-understand.py <image-path> [prompt]")
        sys.exit(1)

    image_path = sys.argv[1]
    prompt = sys.argv[2] if len(sys.argv) > 2 else None
    understand_image(image_path, prompt)
