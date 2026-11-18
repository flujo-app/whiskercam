# Whiskercam

A day on the estate, filmed from under a cat's chin. A browser game.

**Play it:** https://flujo-app.github.io/whiskercam/

![Three frames from the game: a pounce with the paws in view, the cat and its mirror image at a glass door, a parked car with the street in its paint](docs/frame.jpg)

You are a cat with a small camera on your collar. The battery lasts three minutes. Whatever you
do in that time ends up in the clip, and the clip gets views:

- **Chase your brother.** Rocket is faster than you. Stay on his tail, and tag him when he looks back.
- **Win the turf.** Three cats guard the bins, the car port and the square. Walk up to one and it
  becomes a slap fight: slap when they are open, pull back when a paw comes up.
- **Make a mess.** Pots, cans, a gnome, a ball. A paw swipe sends them flying.
- **Go where cats go.** Under cars, through hedges, onto car roofs and low walls, up trees and fences.
- **Look at yourself.** Car paint, windows and glass doors mirror what is really around them. Walk up to
  the glass door of a block of flats and the cat in it is you.

Sprinting, climbing and slapping all use the same breath. In a fight, flailing loses: wait for the
raised paw, pull back, and hit back while the other cat is off balance.

When the battery dies the clip is "posted": you get its title, its views and the comments. The run
is also a real video file, upright like a phone clip, with the views counter, the comments and a closing
card in the picture: save it, or share it straight to a video app from a phone.

## Controls

| | Keyboard and mouse | Touch | Gamepad |
| --- | --- | --- | --- |
| Run | W (S to back up) | left thumb | left stick |
| Sprint | Shift | push the stick far | right trigger |
| Steer | mouse, or A / D | left thumb, or drag on the right | left stick, right stick |
| Pounce (a high jump from a standstill, or at something to land on) | Space | Jump button | A |
| Climb a tree or a fence | push against it, or jump at it | same | same |
| Paw swipe / slap | left and right mouse button, or Q / E | paw buttons | X / B |
| Pull back in a fight | S | Jump button | Y |
| Meow | F | | |
| Pause | Esc | | Start |

The picture is upright, like a phone clip, on every screen. How much the camera shakes can be set on the
title screen and on the pause screen (it is steady by default, and steadier still on phones).

## How it is made

Everything is built by script. There is no hand-made 3D model in this repository.

1. Python scripts build the estate in Blender at real size, from free scanned surfaces and objects
   ([Poly Haven](https://polyhaven.com), public domain) plus shapes made by code: the houses, the
   cars, the cat.
2. Blender's film renderer works out the light once: sun, sky and bounced light for every surface.
   The estate is cut into slices so each job fits an ordinary 8 GB graphics card.
3. The game looks that light up while you play, and adds what a small action camera does to a
   picture: fisheye lens, motion streaks, automatic exposure with a phone camera's tone curve (shade
   keeps its detail), soft focus up close, lens flare, grain.
4. Reflections are real without ray tracing: when the estate has loaded, the game takes an all-round
   picture from the middle of every parked car and in front of every house wall, and shiny surfaces look
   their reflection up there, corrected for where they stand. The car next to the cat is kept up to
   date with everything that moves; a glass door close by gets a true mirror image.

More detail: [docs/PIPELINE.md](docs/PIPELINE.md).

## Run it yourself

```text
npm install
npm run dev
```

The packed world is not in this repository (it is large and can be rebuilt). Either rebuild it
(see [docs/PIPELINE.md](docs/PIPELINE.md)) or copy the `assets` folder from the published site
into `public/`.

```text
npm test          logic tests (fights, scoring, paths)
npm run typecheck
node tools/playtest.mjs estate    a bot plays a whole round in a hidden browser
node tools/roamtest.mjs estate    the cat is sent at every kerb, stair, pipe, car, tree, fence and hedge
node tools/uitest.mjs estate      clicks through every screen at desktop and phone size
node tools/bench.mjs estate       how long a frame takes at several spots
```

## Credits and licence

Code: MIT, see [LICENSE](LICENSE). Scanned surfaces, objects and sound recordings come from the
people listed in [CREDITS.md](CREDITS.md).
