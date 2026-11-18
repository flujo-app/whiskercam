# How the world is made

Whiskercam is a browser game seen through a cat's collar camera. Everything you see is
built by Python scripts in Blender and then handed to the game. Nothing is modelled by hand.

## The idea in four steps

1. **Build** (`pipeline/blender/sets`, `pipeline/blender/assets`): scripts build the estate at
   real size from scanned surfaces and scanned objects (Poly Haven, CC0) plus shapes made by code.
2. **Bake** (`pipeline/blender/wc/bake.py`): Blender's film-quality renderer (Cycles) works out
   the light once: where the sun reaches, how much sky each spot sees, how light bounces. The
   world is cut into slices so each job fits an 8 GB graphics card.
3. **Pack** (`tools/pack.mjs`): pictures are shrunk and re-encoded for the web.
4. **Play** (`src/`): the game looks the baked light up and adds everything a small camera
   does to a picture: fisheye lens, motion streaks, automatic exposure, glare, grain.

## Commands

```text
npm run fetch                                             download the free scans (about 1 GB, cached in assets_src/)
blender -b --factory-startup -P pipeline/blender/run.py -- build_estate --name estate --stills
blender -b --factory-startup -P pipeline/blender/run.py -- bake_estate  --name estate
node tools/pack.mjs estate
npm run dev                                               play at http://127.0.0.1:5183/?set=estate
blender -b --factory-startup -P pipeline/blender/run.py -- build_cat      the cat model and its six coats -> build/export/cats/
blender -b --factory-startup -P pipeline/blender/run.py -- stage <module>   look at one asset module

node tools/shots.mjs estate                               test pictures from a hidden browser -> build/shots/
node tools/playtest.mjs estate                            a bot plays a whole round -> build/playtest/
node tools/uitest.mjs estate                              clicks through every screen, desktop and phone size
node tools/bench.mjs estate                               how long a frame really takes, at several spots
node tools/roamtest.mjs estate                            sends the cat at every kerb, stair, pipe, car, tree, fence and hedge
blender -b --factory-startup -P pipeline/blender/run.py -- export_collision   only what the cat bumps into (no bake)
node tools/credits.mjs                                    rewrite CREDITS.md from what is used
node tools/deploy.mjs                                     build and publish the live page
```

The whole estate (build, bake, pack) takes about an hour on an RTX 2070 Super with 8 GB.

To try out a change to collision shapes without waiting for a bake: `build_estate`, then
`export_collision`, then copy `build/export/estate/collision.*` to `public/assets/estate/` and run
`node tools/roamtest.mjs estate`.

The estate lists its own awkward spots for that test (`geo.poi(kind, x, y, nx, ny)` while building: kerbs,
stairs, drainpipes, cars, trees, fences, hedges). Add one for anything new the cat could get stuck on.

One-time setup for the pipeline (not needed to play or to work on the game code):

```text
"<blender>/4.5/python/bin/python.exe" -m pip install --no-deps --target build/pydeps shapely
python -m venv build/pyenv && build/pyenv/Scripts/python -m pip install numpy xatlas
```

## Conventions every builder follows

* 1 unit = 1 metre. +Z is up, +Y is north, +X is east. Model everything at its real size.
* The camera is a cat: 5 to 40 cm above the ground, looking through an ultra-wide lens.
  Things near the ground get the detail: kerbs, wheels, door sills, pipe ends, weeds.
  Roofs and upper floors only need a believable outline.
* Every edge that would be sharp in a drawing is slightly rounded in reality: bevel it
  (`geo.bevel`, 3 to 15 mm). Flat untextured boxes are never acceptable for anything the cat
  can get close to.
* Materials come from `wc.mat` (`mat.get(name)`), or are made with `mat.tile(name, polyhaven_id)`
  and `mat.flat(name, colour, rough, metal)`. Tiling surfaces need UVs in metres: call
  `geo.uv_box(obj)` after the mesh is final (most `geo` helpers already do).
* Tag what you build (`obj["wc_..."] = ...`):

  | tag | values | meaning |
  | --- | --- | --- |
  | `wc_role` | `ground`, `kerb`, `wall`, `building`, `prop`, `vehicle`, `fence`, `foliage`, `scatter`, `decal`, `collider`, `far` | what it is (`far` = scenery beyond the walls: no baked light, lit by plain sun and sky) |
  | `wc_collide` | `mesh`, `none` | whether the cat bumps into it (`collider` objects are invisible helpers that only collide) |
  | `wc_lm` | number, default 1 | light-map detail: 1 near the ground, 0.3 for upper floors, 0.15 for roofs |
  | `wc_surface` | material name, or `wood` / `metal` | footstep sound; `wood` can be climbed |

* Keep triangle counts sensible: a parked car 15 to 25 thousand, a building 20 to 40 thousand,
  a small prop under 3 thousand.
* Test pictures are the judge, not the code. Use the `stage` job, look at the pictures, fix,
  repeat. Keep test renders small (640 x 480, 40 samples) so several jobs can share one GPU.

## Folders

| folder | what | in git |
| --- | --- | --- |
| `pipeline/` | Blender scripts, asset lists | yes |
| `tools/` | packing, light-map layout, test pictures | yes |
| `src/` | the game | yes |
| `assets_src/` | downloaded scans | no (re-fetchable) |
| `build/` | Blender files, bakes, test pictures | no |
| `public/assets/` | packed game data | no (published with the site) |
| `public/audio/` | sound recordings (see CREDITS.md) | yes |
