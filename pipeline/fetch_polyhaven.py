"""Download the Poly Haven assets listed in pipeline/asset_list.json and pipeline/asset_lists/*.json.

Poly Haven (https://polyhaven.com) publishes everything under CC0. Files land in
assets_src/polyhaven/<kind>/<id>/ and are skipped when already present with the
right size, so the script is safe to re-run.

Usage:  python -I pipeline/fetch_polyhaven.py [--only textures|models|hdris] [--id ID]
"""
from __future__ import annotations

import argparse
import concurrent.futures as cf
import hashlib
import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEST = ROOT / "assets_src" / "polyhaven"
API = "https://api.polyhaven.com"
HEADERS = {"User-Agent": "asset-fetch/1.0"}

# texture maps we use, in the order they are written to disk
TEXTURE_MAPS = ("Diffuse", "nor_gl", "arm", "Displacement")


def http_json(path: str) -> dict:
    req = urllib.request.Request(API + path, headers=HEADERS)
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                return json.load(resp)
        except (urllib.error.URLError, TimeoutError) as exc:  # transient network trouble
            if attempt == 3:
                raise
            time.sleep(2 + attempt * 3)
            print(f"  retry {path}: {exc}")
    raise RuntimeError("unreachable")


def download(url: str, dest: Path, size: int | None, md5: str | None = None) -> bool:
    """Fetch url to dest. Returns True when a download happened."""
    if dest.exists() and (size is None or dest.stat().st_size == size):
        return False
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    req = urllib.request.Request(url, headers=HEADERS)
    for attempt in range(4):
        try:
            digest = hashlib.md5()
            with urllib.request.urlopen(req, timeout=120) as resp, open(tmp, "wb") as fh:
                while True:
                    block = resp.read(1 << 20)
                    if not block:
                        break
                    fh.write(block)
                    digest.update(block)
            if md5 and digest.hexdigest() != md5:
                raise IOError(f"md5 mismatch for {url}")
            tmp.replace(dest)
            return True
        except (urllib.error.URLError, TimeoutError, IOError) as exc:
            if attempt == 3:
                raise
            time.sleep(2 + attempt * 3)
            print(f"  retry {dest.name}: {exc}")
    return False


def plan_texture(asset: str, res: str) -> list[tuple[str, Path, int, str | None]]:
    files = http_json(f"/files/{asset}")
    out_dir = DEST / "textures" / asset
    jobs = []
    for m in TEXTURE_MAPS:
        if m not in files or res not in files[m]:
            continue
        fmt = "jpg" if "jpg" in files[m][res] else next(iter(files[m][res]))
        entry = files[m][res][fmt]
        jobs.append((entry["url"], out_dir / f"{asset}_{m}_{res}.{fmt}", entry["size"], entry.get("md5")))
    return jobs


def plan_model(asset: str, res: str) -> list[tuple[str, Path, int, str | None]]:
    files = http_json(f"/files/{asset}")
    out_dir = DEST / "models" / asset / res
    entry = files["gltf"][res]["gltf"]
    jobs = [(entry["url"], out_dir / f"{asset}.gltf", entry["size"], entry.get("md5"))]
    for rel, inc in entry.get("include", {}).items():
        jobs.append((inc["url"], out_dir / rel, inc["size"], inc.get("md5")))
    return jobs


def plan_hdri(asset: str, res: str) -> list[tuple[str, Path, int, str | None]]:
    files = http_json(f"/files/{asset}")
    out_dir = DEST / "hdris" / asset
    entry = files["hdri"][res]["hdr"]
    jobs = [(entry["url"], out_dir / f"{asset}_{res}.hdr", entry["size"], entry.get("md5"))]
    tm = files.get("tonemapped", {})
    if "url" in tm:
        jobs.append((tm["url"], out_dir / f"{asset}_tonemapped.jpg", tm.get("size"), tm.get("md5")))
    return jobs


PLANNERS = {"textures": plan_texture, "models": plan_model, "hdris": plan_hdri}


def save_info(kind: str, asset: str) -> None:
    info_path = DEST / kind / asset / "info.json"
    if info_path.exists():
        return
    info = http_json(f"/info/{asset}")
    keep = {k: info[k] for k in ("name", "dimensions", "polycount", "authors", "categories", "tags") if k in info}
    info_path.parent.mkdir(parents=True, exist_ok=True)
    info_path.write_text(json.dumps(keep, indent=1), encoding="utf-8")


def load_wanted() -> dict:
    """asset_list.json plus every pipeline/asset_lists/*.json (one per asset module), merged."""
    wanted: dict = {}
    files = [ROOT / "pipeline" / "asset_list.json"] + sorted((ROOT / "pipeline" / "asset_lists").glob("*.json"))
    for f in files:
        for kind, items in json.loads(f.read_text(encoding="utf-8")).items():
            wanted.setdefault(kind, {}).update(items)
    return wanted


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", choices=sorted(PLANNERS))
    ap.add_argument("--id")
    args = ap.parse_args()

    wanted = load_wanted()
    jobs: list[tuple[str, Path, int, str | None]] = []
    for kind, planner in PLANNERS.items():
        if args.only and kind != args.only:
            continue
        for asset, res in wanted.get(kind, {}).items():
            if args.id and asset != args.id:
                continue
            resolutions = res if isinstance(res, list) else [res]
            try:
                for r in resolutions:
                    jobs.extend(planner(asset, r))
                save_info(kind, asset)
            except (KeyError, urllib.error.HTTPError) as exc:
                print(f"!! {kind}/{asset}: not available at {res} ({exc})")

    todo = [j for j in jobs if not (j[1].exists() and (j[2] is None or j[1].stat().st_size == j[2]))]
    total = sum(j[2] or 0 for j in todo)
    print(f"{len(jobs)} files listed, {len(todo)} to download ({total / 1e6:.1f} MB)")
    done = 0
    with cf.ThreadPoolExecutor(max_workers=6) as pool:
        for ok in pool.map(lambda j: download(*j), todo):
            done += 1
            if done % 20 == 0:
                print(f"  {done}/{len(todo)}")
    print("done")
    return 0


if __name__ == "__main__":
    sys.exit(main())
