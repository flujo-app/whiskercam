// Movement tests: send the cat at the things that used to trip it up and check that it gets past.
//
//   node tools/roamtest.mjs [set] [--only kerb|steps|pipe|car|tree|fence|hedge|jump|skin] [--verbose] [--extra '[[kind,x,z,nx,nz]]']
//
// The estate lists its own awkward spots (world.json "poi": every few metres of kerb, every entrance
// stair, every drainpipe, every parked car). For each one the cat is put down nearby and walked at it
// from several angles, without drawing anything, so thousands of approaches take a few seconds.
// A probe fails when the cat does not make the progress it should, when the picture would jerk (the
// lens jumps more than a few centimetres in one step) or when the lens comes too close to a surface.
// Exits with code 1 when anything fails.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const set = args.find((a, i) => !a.startsWith('--') && !['--only', '--extra'].includes(args[i - 1])) ?? 'estate';
const only = opt('only', null);
const verbose = args.includes('--verbose');
const extra = JSON.parse(opt('extra', '[]')); // more test spots: [[kind, x, z, nx, nz], ...]

const server = await createServer({ root: ROOT, logLevel: 'error', server: { port: 5193, strictPort: false } });
await server.listen();
const browser = await chromium.launch({
  channel: 'msedge',
  headless: true,
  args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--mute-audio'],
});
const page = await browser.newPage({ viewport: { width: 270, height: 480 }, deviceScaleFactor: 1 });
const problems = [];
page.on('pageerror', (e) => problems.push(e.message));
await page.goto(`${server.resolvedUrls.local[0]}?set=${set}&manual=1&size=270x480`);
await page.waitForFunction(() => window.__wc !== undefined, null, { timeout: 180000 });

const report = await page.evaluate(({ only, extra }) => {
  const wc = window.__wc;
  const g = wc.game;
  const p = g.player;
  const ph = g.physics;
  const DEG = Math.PI / 180;
  const base = { move: 0, turn: 0, yaw: 0, pitch: 0, sprint: false, jump: false, jumpHeld: false, pawLeft: false, pawRight: false, dodge: false, pause: false, any: false };
  const dirs = [];
  for (let e = -1; e <= 1; e++) for (let a = 0; a < 8; a++) dirs.push([Math.cos(a * Math.PI / 4) * Math.cos(e * 0.7), Math.sin(e * 0.7), Math.sin(a * Math.PI / 4) * Math.cos(e * 0.7)]);
  const clearance = () => {
    let m = 1;
    for (const [dx, dy, dz] of dirs) m = Math.min(m, ph.rayDistance(p.camX, p.camY, p.camZ, dx, dy, dz, 0.3));
    return m;
  };
  /** Put the cat down and let it settle. Returns false when the spot is not open ground. */
  const put = (x, z, heading) => {
    const ground = ph.groundBelow(x, 3, z, 6);
    // open, level ground only (not the roof of a parked car or the top of a wall)
    if (!ground || ground.ny < 0.9 || ground.y > 0.45 || !ph.freeAt(x, ground.y + 0.1, z, 0.085)) return false;
    wc.pose(null);
    p.place(x, ground.y + 0.02, z, heading);
    for (let i = 0; i < 12; i++) g.update(base);
    return true;
  };
  /** Play `seconds` with the given buttons held; returns what happened. */
  const run = (c, seconds, onStep) => {
    const held = { ...base, ...c };
    const steps = Math.round(seconds * 60);
    const out = { x0: p.x, z0: p.z, y0: p.y, top: p.y, jerk: 0, near: 1, nearAt: '', air: 0, mantled: false };
    let lastCam = p.camY;
    let settled = 5;
    for (let i = 0; i < steps; i++) {
      if (onStep) onStep(i, held);
      g.update(held);
      held.jump = false;
      out.top = Math.max(out.top, p.y);
      // the lens may move fast in a jump, a landing, a scramble or a climb; but while the cat is simply
      // walking or running on the ground, a sudden hop of the whole picture is a fault
      if (p.airborne || p.mantling || p.climbing) {
        out.air++;
        settled = 0;
      } else if (++settled > 4) {
        out.jerk = Math.max(out.jerk, Math.abs(p.camY - lastCam));
      }
      if (p.mantling) out.mantled = true;
      lastCam = p.camY;
      const c = clearance();
      if (c < out.near) {
        out.near = c;
        out.nearAt = `${p.camX.toFixed(2)}, ${p.camY.toFixed(2)}, ${p.camZ.toFixed(2)} (paws at ${p.y.toFixed(2)}, ${p.airborne ? 'in the air' : 'on the ground'}${p.mantling ? ', scrambling' : ''}, crouch ${p.crouch.toFixed(1)})`;
      }
    }
    out.x1 = p.x;
    out.z1 = p.z;
    out.y1 = p.y;
    out.dist = Math.hypot(p.x - out.x0, p.z - out.z0);
    return out;
  };
  const heading = (dx, dz) => ((Math.atan2(dx, -dz) / DEG) + 360) % 360;
  const rot = (x, z, deg) => {
    const a = deg * DEG;
    return [x * Math.cos(a) - z * Math.sin(a), x * Math.sin(a) + z * Math.cos(a)];
  };
  /** nothing tall in the way along this line? (so a failure really is about the thing under test) */
  const openLine = (x, z, dx, dz, len, y = 0.45) => {
    const gr = ph.groundBelow(x, 3, z, 6);
    return ph.rayDistance(x, (gr ? gr.y : 0) + y, z, dx, 0, dz, len) >= len;
  };

  const kinds = {};
  const note = (kind, ok, text) => {
    const k = (kinds[kind] ??= { tried: 0, failed: 0, worst: [] });
    k.tried++;
    if (!ok) {
      k.failed++;
      if (k.worst.length < 8) k.worst.push(text);
    }
  };
  const pois = (g.world.info.poi ?? []).concat(extra);
  const want = (kind) => !only || only === kind;
  let nearest = 1;
  let nearestWhere = '';
  let jerkiest = 0;
  const closest = (r, what) => {
    if (r.near < nearest) {
      nearest = r.near;
      nearestWhere = `${what}: lens at ${r.nearAt}`;
    }
  };

  // ---- jumps on open ground
  if (want('jump')) {
    const spot = g.world.info.spawn.pos;
    const open = [[6, 18], [-6, 18.5], [spot[0], spot[2]]].find(([x, z]) => put(x, z, 90) && openLine(x, z, 1, 0, 4));
    if (open) {
      put(open[0], open[1], 90);
      const tap = run({ jump: true }, 1.2);
      put(open[0], open[1], 90);
      const hold = run({ jump: true, jumpHeld: true }, 1.4);
      // a pounce: get up to speed, press, and measure the leap itself (height, length, time in the air)
      const pounce = (c) => {
        put(open[0], open[1], 90);
        run(c, 1.3);
        const m = { y0: p.y, top: 0, from: null, len: 0, air: 0 };
        run({ ...c, jump: true, jumpHeld: true }, 1.0, () => {
          if (p.airborne) {
            m.from ??= [p.x, p.z];
            m.air++;
            m.top = Math.max(m.top, p.y - m.y0);
            m.len = Math.hypot(p.x - m.from[0], p.z - m.from[1]);
          }
        });
        return m;
      };
      const trot = pounce({ move: 1 });
      const sprint = pounce({ move: 1, sprint: true });
      put(open[0], open[1], 90);
      const leap = run({ move: 1, sprint: true }, 1.2);
      const h = (v) => v.toFixed(2);
      note('jump', tap.top - tap.y0 > 0.2 && tap.top - tap.y0 < 0.5, `a tap from a standstill jumps ${h(tap.top - tap.y0)} m (want 0.2 to 0.5)`);
      note('jump', hold.top - hold.y0 > 0.7 && hold.top - hold.y0 < 0.95, `holding from a standstill jumps ${h(hold.top - hold.y0)} m (want 0.7 to 0.95)`);
      note('jump', trot.top > 0.3 && trot.top < 0.55, `a pounce at a trot rises ${h(trot.top)} m (want 0.3 to 0.55)`);
      note('jump', trot.len > 1.5 && trot.len < 2.5, `a pounce at a trot carries ${h(trot.len)} m (want 1.5 to 2.5)`);
      note('jump', trot.air / 60 > 0.28 && trot.air / 60 < 0.5, `a pounce at a trot is ${h(trot.air / 60)} s in the air (want 0.28 to 0.5)`);
      note('jump', sprint.top < 0.55, `a pounce at a sprint rises ${h(sprint.top)} m (want under 0.55)`);
      note('jump', sprint.len > 2.6 && sprint.len < 3.9, `a pounce at a sprint carries ${h(sprint.len)} m (want 2.6 to 3.9)`);
      note('jump', leap.jerk < 0.03, `sprinting on flat ground moves the lens ${(leap.jerk * 100).toFixed(1)} cm in one step`);
      kinds.jump.heights = { tap: +h(tap.top - tap.y0), hold: +h(hold.top - hold.y0), pounce: +h(trot.top), pounceLength: +h(trot.len), sprintPounceLength: +h(sprint.len) };
    }
  }

  // ---- kerbs: from both sides, at shallow and steep angles, walking and sprinting
  if (want('kerb')) {
    const seen = new Set();
    for (const [kind, x, z, nx, nz] of pois) {
      if (kind !== 'kerb') continue;
      const key = `${Math.round(x / 4)},${Math.round(z / 4)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      for (const side of [1, -1]) {
        for (const ang of [0, 35, -35, 62, -62, 76, -76]) {
          for (const sprint of [false, true]) {
            const sx = x + nx * side * 0.9;
            const sz = z + nz * side * 0.9;
            const [dx, dz] = rot(-nx * side, -nz * side, ang);
            const len = 1.8 / Math.cos(ang * DEG);
            if (!put(sx, sz, heading(dx, dz)) || !openLine(sx, sz, dx, dz, Math.min(len, 4))) continue;
            const y0 = p.y;
            if (y0 > 0.4) continue; // put down on top of something (a parked car): not a kerb test
            const r = run({ move: 1, sprint }, (sprint ? 0.9 : 1.7) / Math.cos(ang * DEG) * 0.75);
            const across = (r.x1 - r.x0) * -nx * side + (r.z1 - r.z0) * -nz * side;
            closest(r, `kerb at ${x.toFixed(1)}, ${z.toFixed(1)} side ${side} angle ${ang}${sprint ? ' sprint' : ''}`);
            jerkiest = Math.max(jerkiest, r.jerk);
            const ok = across > 1.25 && r.jerk < (sprint ? 0.09 : 0.05);
            note('kerb', ok, `kerb at ${x.toFixed(1)}, ${z.toFixed(1)} side ${side} angle ${ang}${sprint ? ' sprint' : ''}: got ${across.toFixed(2)} m across (want 1.25), lens jump ${(r.jerk * 100).toFixed(1)} cm, height ${y0.toFixed(2)} -> ${r.y1.toFixed(2)}`);
          }
        }
      }
    }
  }

  // ---- entrance stairs: up to the door from three angles, then back down
  if (want('steps')) {
    for (const [kind, x, z, nx, nz] of pois) {
      if (kind !== 'steps') continue;
      const topGround = ph.groundBelow(x, 3, z, 6);
      if (!topGround) continue;
      for (const ang of [0, 22, -22]) {
        const [ox, oz] = rot(nx, nz, ang);
        const sx = x + ox * 3.2;
        const sz = z + oz * 3.2;
        if (!put(sx, sz, heading(-ox, -oz))) continue;
        const y0 = p.y;
        const up = run({ move: 1 }, 1.9);
        const reached = p.y > topGround.y - 0.04;
        closest(up, `stairs at ${x.toFixed(1)}, ${z.toFixed(1)} angle ${ang}`);
        jerkiest = Math.max(jerkiest, up.jerk);
        note('steps', reached && up.jerk < 0.055, `stairs at ${x.toFixed(1)}, ${z.toFixed(1)} angle ${ang}: climbed ${(p.y - y0).toFixed(2)} of ${(topGround.y - y0).toFixed(2)} m, lens jump ${(up.jerk * 100).toFixed(1)} cm`);
        if (reached) {
          p.heading = heading(ox, oz);
          const down = run({ move: 1 }, 1.4);
          jerkiest = Math.max(jerkiest, down.jerk);
          note('steps', down.dist > 2.6 && down.jerk < 0.06, `stairs at ${x.toFixed(1)}, ${z.toFixed(1)} going down angle ${ang}: got ${down.dist.toFixed(2)} m (want 2.6), lens jump ${(down.jerk * 100).toFixed(1)} cm`);
        }
      }
    }
  }

  // ---- drainpipes: slide along the wall past each one, both ways, walking and sprinting
  if (want('pipe')) {
    const seen = new Set();
    for (const [kind, x, z, nx, nz] of pois) {
      if (kind !== 'pipe') continue;
      const key = `${x.toFixed(1)},${z.toFixed(1)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      for (const way of [1, -1]) {
        for (const sprint of [false, true]) {
          const tx = -nz * way;
          const tz = nx * way;
          const sx = x + nx * 0.14 - tx * 1.5;
          const sz = z + nz * 0.14 - tz * 1.5;
          // head along the wall, leaning into it a little: the way a player hugs a wall
          const [dx, dz] = [tx - nx * 0.25, tz - nz * 0.25];
          if (!put(sx, sz, heading(dx, dz))) continue;
          if (!openLine(x + nx * 0.6 - tx * 1.5, z + nz * 0.6 - tz * 1.5, tx, tz, 3.2, 0.3)) continue;
          // most pipes stand at a corner of the house: only come at them along the side that has a wall to hug
          if (ph.rayDistance(sx, p.y + 0.4, sz, -nx, 0, -nz, 0.5) >= 0.5) continue;
          const r = run({ move: 1, sprint }, sprint ? 0.9 : 1.6);
          const along = (r.x1 - r.x0) * tx + (r.z1 - r.z0) * tz;
          closest(r, `pipe at ${x.toFixed(1)}, ${z.toFixed(1)} way ${way}${sprint ? ' sprint' : ''}`);
          // slowed down is fine (it has to go round or over the outlet); stopped is not
          const need = sprint ? 1.2 : 1.7;
          note('pipe', along > need, `pipe at ${x.toFixed(1)}, ${z.toFixed(1)} way ${way}${sprint ? ' sprint' : ''}: got ${along.toFixed(2)} m along the wall (want ${need})`);
        }
      }
    }
  }

  // ---- parked cars: jump on from the front, the back and the side; crawl underneath
  if (want('car')) {
    for (const [kind, x, z, nx, nz] of pois) {
      if (kind !== 'car') continue;
      const approaches = [['nose', nx, nz, 2.9], ['tail', -nx, -nz, 3.1], ['side', -nz, nx, 2.0], ['other side', nz, -nx, 2.0]];
      for (const [name, ax, az, far] of approaches) {
        const sx = x + ax * (far + 1.3);
        const sz = z + az * (far + 1.3);
        if (!put(sx, sz, heading(-ax, -az)) || !openLine(sx, sz, -ax, -az, 1.2, 0.3)) continue;
        const y0 = p.y;
        // run at it and jump a little before reaching it
        let jumped = false;
        const r = run({ move: 1, sprint: false, jumpHeld: true }, 2.4, (i, held) => {
          const d = ph.rayDistance(p.x, y0 + 0.45, p.z, -ax, 0, -az, 3);
          if (!jumped && d < 0.75) {
            held.jump = true;
            jumped = true;
          }
        });
        closest(r, `car at ${x.toFixed(1)}, ${z.toFixed(1)} from the ${name}`);
        note('car', r.top - y0 > 0.6 && r.near > 0.03, `car at ${x.toFixed(1)}, ${z.toFixed(1)} from the ${name}: got ${(r.top - y0).toFixed(2)} m up${r.mantled ? ' (scrambled)' : ''}, lens came within ${(r.near * 100).toFixed(1)} cm`);
      }
      // underneath, nose to tail (between the wheels)
      const sx = x + nx * 3.6;
      const sz = z + nz * 3.6;
      if (put(sx, sz, heading(-nx, -nz)) && openLine(sx, sz, -nx, -nz, 0.8, 0.1)) {
        const r = run({ move: 1 }, 5.5);
        const through = (r.x1 - r.x0) * -nx + (r.z1 - r.z0) * -nz;
        closest(r, `under the car at ${x.toFixed(1)}, ${z.toFixed(1)}`);
        note('car', through > 6.0 && r.near > 0.03, `under the car at ${x.toFixed(1)}, ${z.toFixed(1)}: got ${through.toFixed(2)} m (want 6.0), lens came within ${(r.near * 100).toFixed(1)} cm`);
      }
    }
  }
  // ---- trees: walk at the trunk, climb to the fork, sit there, jump off and land
  // (trunks lean, and nobody walks at one dead centre: each tree is tried straight on, a little to
  // either side, and with a running jump at the trunk)
  if (want('tree')) {
    for (const [kind, x, z, perch, thick] of pois) {
      if (kind !== 'tree') continue;
      const away = (thick || 0.1) + 1.1;
      let sides = 0;
      for (const a of [0, 90, 180, 270]) {
        if (sides >= 2) break;
        const dx = Math.sin(a * DEG);
        const dz = -Math.cos(a * DEG);
        const sx = x - dx * away;
        const sz = z - dz * away;
        if (!put(sx, sz, a) || !openLine(sx, sz, dx, dz, 0.9, 0.3)) continue;
        sides++;
        const where = `tree at ${x.toFixed(1)}, ${z.toFixed(1)} from ${a}`;
        for (const [how, off, c] of [['walking', 0, { move: 1 }], ['walking, a bit left', -0.05, { move: 1 }], ['walking, a bit right', 0.05, { move: 1 }], ['jumping at it', 0, { move: 1, sprint: true }]]) {
          // `off` shifts the whole approach sideways; the jump gets a run-up
          const jumping = how === 'jumping at it';
          const back = jumping ? 1.6 : 0;
          if (jumping && !openLine(sx - dx * back, sz - dz * back, dx, dz, back + 0.9, 0.3)) continue;
          if (!put(sx - dx * back - dz * off, sz - dz * back + dx * off, a)) continue;
          const y0 = p.y;
          let clung = false;
          let jumped = -1;
          const up = run(c, perch / 1.5 + 4, (i, held) => {
            if (jumping && jumped < 0 && Math.hypot(p.x - x, p.z - z) < 1.15 + (thick || 0.1)) {
              jumped = i;
              held.jump = held.jumpHeld = true;
            }
            if (jumped >= 0 && i === jumped + 12) held.jumpHeld = false;
            // (a high jump may catch the fork itself and scramble straight up: that counts too)
            if (p.climbing || p.mantling) {
              clung = true;
              held.sprint = false;
            }
            // up in the fork the cat pauses for a moment: time to let go of the stick
            if (clung && !p.climbing && !p.mantling && !p.airborne && p.y - y0 > perch - 0.25) held.move = 0;
          });
          closest(up, where);
          const top = p.y - y0;
          note('tree', clung && top > perch - 0.25 && !p.climbing && up.near > 0.03, `${where}, ${how}: ${clung ? 'got a grip' : 'never got a grip'}, ended ${top.toFixed(2)} m up (fork at ${perch} m), lens came within ${(up.near * 100).toFixed(1)} cm`);
          if (top > perch - 0.25 && how === 'walking') {
            // jump off, and stand still once down (or it runs on into the next fence and climbs that)
            const off2 = run({ move: 1, sprint: true, jump: true, jumpHeld: true }, 2.5, (i, held) => {
              if (i > 10 && !p.airborne) held.move = 0;
            });
            closest(off2, where);
            note('tree', p.y - y0 < 0.4 && !p.airborne, `${where}: after jumping off it is ${(p.y - y0).toFixed(2)} m up`);
          }
        }
      }
      if (!sides) note('tree', false, `tree at ${x.toFixed(1)}, ${z.toFixed(1)}: no open ground next to the trunk to start from`);
    }
  }

  // ---- wooden fences: push against one, climb it, get onto the top
  if (want('fence')) {
    for (const [kind, x, z, nx, nz] of pois) {
      if (kind !== 'fence') continue;
      const top = ph.groundBelow(x, 3, z, 6);
      for (const side of [1, -1]) {
        const sx = x + nx * side * 1.1;
        const sz = z + nz * side * 1.1;
        if (!put(sx, sz, heading(-nx * side, -nz * side)) || !openLine(sx, sz, -nx * side, -nz * side, 0.8, 0.3)) continue;
        const y0 = p.y;
        let clung = false;
        const r = run({ move: 1 }, 3.2, () => {
          if (p.climbing) clung = true;
        });
        closest(r, `fence at ${x.toFixed(1)}, ${z.toFixed(1)} side ${side}`);
        const height = top ? top.y - y0 : 1.2;
        note('fence', r.top - y0 > height - 0.2 && r.near > 0.03, `fence at ${x.toFixed(1)}, ${z.toFixed(1)} side ${side}: ${clung ? 'climbed' : 'no grip'}, got ${(r.top - y0).toFixed(2)} m up (fence is ${height.toFixed(2)} m), lens came within ${(r.near * 100).toFixed(1)} cm`);
      }
    }
  }

  // ---- hedges: push in from the nearest open side and come out again
  if (want('hedge')) {
    for (const [kind, x, z] of pois) {
      if (kind !== 'hedge') continue;
      let tried = false;
      for (const a of [0, 90, 180, 270]) {
        if (tried) break;
        const dx = Math.sin(a * DEG);
        const dz = -Math.cos(a * DEG);
        const sx = x - dx * 1.6;
        const sz = z - dz * 1.6;
        if (!put(sx, sz, a) || !openLine(sx, sz, dx, dz, 3.2, 0.3)) continue;
        tried = true;
        let inside = false;
        const r = run({ move: 1 }, 3.5, () => {
          if (p.inHedge) inside = true;
        });
        closest(r, `hedge at ${x.toFixed(1)}, ${z.toFixed(1)}`);
        note('hedge', inside && r.dist > 2.6, `hedge at ${x.toFixed(1)}, ${z.toFixed(1)}: ${inside ? 'went in' : 'never got in'}, travelled ${r.dist.toFixed(2)} m (want 2.6)`);
      }
    }
  }

  // ---- what you see versus what stops you: wherever the drawn surface stands out in front of the solid one
  // by more than the lens keeps clear, the lens could end up inside it (seeing a car or a wall from within)
  if (want('skin') && wc.THREE) {
    const T = wc.THREE;
    const rc = new T.Raycaster();
    const solids = g.world.group.children.filter((c) => /^(cell|far)/.test(c.name));
    const seen = (ox, oy, oz, dx, dz, max) => {
      rc.set(new T.Vector3(ox, oy, oz), new T.Vector3(dx, 0, dz));
      rc.far = max;
      // hedges and leaves are drawn but deliberately not solid: the cat pushes through them
      const hits = rc.intersectObjects(solids, true).filter((h) => !/hedge|leaf|leaves|ivy|grass/.test(h.object.material?.name ?? ''));
      seenWhat = hits.length ? hits[0].object.material?.name || '?' : '';
      return hits.length ? hits[0].distance : max;
    };
    let seenWhat = '';
    const probe = (label, ox, oy, oz, dx, dz) => {
      const solid = ph.rayDistance(ox, oy, oz, dx, 0, dz, 2.5);
      const drawn = seen(ox, oy, oz, dx, dz, 2.5);
      if (drawn >= 2.5 && solid >= 2.5) return;
      const proud = solid - drawn; // how far the drawn surface stands in front of the solid one
      note('skin', proud < 0.065, `${label}: the drawn surface (${seenWhat}) is ${(proud * 100).toFixed(1)} cm in front of the solid one`);
    };
    for (const [kind, x, z, nx, nz] of pois) {
      const gr = ph.groundBelow(x + nx * 1.6, 3, z + nz * 1.6, 6);
      const y0 = gr ? gr.y : 0;
      if (kind === 'car') {
        for (const [name, ax, az, far] of [['nose', nx, nz, 3.4], ['tail', -nx, -nz, 3.6], ['side', -nz, nx, 2.2], ['other side', nz, -nx, 2.2]]) {
          for (const off of [-0.5, 0, 0.5]) {
            // look from close by, standing on the same ground as the car (not from a pavement above it)
            const fx = x + ax * far - az * off;
            const fz = z + az * far + ax * off;
            const g1 = ph.groundBelow(fx, 3, fz, 6);
            if (!g1 || g1.y > 0.3) continue;
            const reach = ph.rayDistance(fx, g1.y + 0.5, fz, -ax, 0, -az, far);
            if (reach >= far) continue;
            const ox = fx - ax * Math.max(0, reach - 0.35);
            const oz = fz - az * Math.max(0, reach - 0.35);
            const g2 = ph.groundBelow(ox, g1.y + 0.5, oz, 1.2);
            if (!g2 || g2.ny < 0.9) continue;
            // standing on a kerb that runs right behind the car? Then this is not where a cat goes under it
            const under = ph.groundBelow(ox - ax * 0.6, g2.y + 0.1, oz - az * 0.6, 0.5);
            if (under && Math.abs(under.y - g2.y) > 0.03) continue;
            for (const h of [0.1, 0.35, 0.6, 0.9]) probe(`car at ${x.toFixed(1)}, ${z.toFixed(1)} ${name} at ${h} m`, ox, g2.y + h, oz, -ax, -az);
          }
        }
      } else if (kind === 'pipe') {
        for (const h of [0.08, 0.3, 0.8]) for (const off of [-1.2, 1.2]) probe(`wall by the pipe at ${x.toFixed(1)}, ${z.toFixed(1)} at ${h} m`, x + nx * 1.6 - nz * off, y0 + h, z + nz * 1.6 + nx * off, -nx, -nz);
      }
    }
  }
  return { kinds, pois: pois.length, nearest, nearestWhere, jerkiest };
}, { only, extra });

// A handful of awkward corners out of thousands of approaches is expected (a probe that runs into a parked
// car on its way to a kerb, say). The run as a whole fails when a kind of obstacle fails too often.
const NEED = { jump: 1, kerb: 0.985, steps: 0.9, pipe: 0.95, car: 0.9, tree: 0.9, fence: 0.95, hedge: 0.95, skin: 0.9 };
let failed = 0;
for (const [kind, k] of Object.entries(report.kinds)) {
  const rate = (k.tried - k.failed) / Math.max(1, k.tried);
  const bad = rate < (NEED[kind] ?? 1);
  if (bad) failed += k.failed;
  console.log(`${bad ? 'FAIL' : k.failed ? 'ok* ' : 'ok  '}  ${kind}: ${k.tried - k.failed} of ${k.tried} passed${k.heights ? '  ' + JSON.stringify(k.heights) : ''}`);
  if (k.failed) for (const w of verbose ? k.worst : k.worst.slice(0, 4)) console.log(`        ${w}`);
}
if (!report.pois) console.log('note: this world lists no test spots (world.json has no "poi"); only the jump drills ran');
console.log(`lens: never closer than ${(report.nearest * 100).toFixed(1)} cm to a surface; biggest hop of the picture on the ground ${(report.jerkiest * 100).toFixed(1)} cm`);
if (report.nearest < 0.04) console.log(`      closest call: ${report.nearestWhere}`);
if (problems.length) console.log('browser errors:\n' + [...new Set(problems)].join('\n'));
await browser.close();
await server.close();
process.exit(failed || problems.length ? 1 : 0);
