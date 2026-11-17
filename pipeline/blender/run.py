"""Entry point for every Blender job.

  blender -b --factory-startup -P pipeline/blender/run.py -- <module> [args...]

<module> is a file in pipeline/blender/jobs/ with a main(args) function.
"""
import importlib
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
sys.path.insert(0, str(HERE))
sys.path.append(str(ROOT / "build" / "pydeps"))  # shapely (see docs/PIPELINE.md)


def main() -> None:
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    if not argv:
        raise SystemExit("usage: run.py -- <job> [args]")
    job = importlib.import_module(f"jobs.{argv[0]}")
    started = time.time()
    job.main(argv[1:])
    print(f"[wc] job {argv[0]} finished in {time.time() - started:.1f}s")


main()
