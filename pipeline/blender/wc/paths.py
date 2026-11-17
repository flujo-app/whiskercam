from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
PH = ROOT / "assets_src" / "polyhaven"
BUILD = ROOT / "build"
PUBLIC_ASSETS = ROOT / "public" / "assets"


def ensure(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    return path
