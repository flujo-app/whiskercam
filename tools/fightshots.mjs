// Frame-by-frame pictures of cat fights (and a few other moves) for judging the animation.
//
//   node tools/fightshots.mjs [--seq windup,miss,...] [--rival 0|1|2] [--coat tabby] [--level 1|2|3]
//                             [--side -1|1] [--pcoat ginger] [--every 2] [--out build/fight] [--size 540x960]
//
// Starts the dev server, opens the game in a hidden Edge with ?manual=1 (frames only when asked),
// starts a fight with one of the rivals, stages a move by setting the fight state directly and saves
// every n-th frame twice: from the player's own collar camera and from a free camera beside the cat
// that is moving. Each sequence ends up as one contact sheet in the output folder:
//   <seq>_cam.jpg   what the player sees
//   <seq>_side.jpg  the moving cat seen from the side, at cat height
// Sequences:
//   guard    the rival waiting (1.6 s)
//   windup   the rival winds up, strikes, the swipe lands, it recovers
//   miss     the same, but the player pulls back so the swipe misses (long recover)
//   feint    a windup that is called off
//   stagger  the player slaps the rival while it recovers
//   gloat    the rival wins the fight
//   flee     the rival loses the fight and bolts
//   slap     the player's own slap, then the other paw
//   dodge    the player pulls back
//   flinch   the player gets slapped
//   swipe    the player bats at nothing outside a fight
//   jump     the player jumps on the spot and lands
//   idle     a rival sitting about (8 s, sampled slowly)
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import sharp from 'sharp';
import { createServer } from 'vite';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const outDir = path.resolve(ROOT, opt('out', 'build/fight'));
const size = opt('size', '540x960');
const [W, H] = size.split('x').map(Number);
const seqs = opt('seq', 'windup').split(',');
const rivalIndex = Number(opt('rival', '2'));
const coat = opt('coat', null);
const level = Number(opt('level', '0'));
const side = Number(opt('side', '1'));
const pcoat = opt('pcoat', null);
const every = Number(opt('every', '2'));
const tag = opt('tag', '');
await fs.mkdir(outDir, { recursive: true });

const server = await createServer({ root: ROOT, logLevel: 'error', server: { port: 5197, strictPort: false } });
await server.listen();
const browser = await chromium.launch({
  channel: 'msedge',
  headless: true,
  args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--disable-gpu-vsync', '--mute-audio'],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const problems = [];
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') problems.push(`[${m.type()}] ${m.text()}`);
});
page.on('pageerror', (e) => problems.push(`[pageerror] ${e.message}`));
await page.goto(`${server.resolvedUrls.local[0]}?set=estate&manual=1&size=${size}`);
await page.waitForFunction(() => window.__wc !== undefined, null, { timeout: 180000 });

// helpers living in the page
await page.evaluate(() => {
  const wc = window.__wc;
  const g = wc.game;
  const DEG = Math.PI / 180;
  window.__fs = {
    /** fresh run, the chosen rival in the chosen coat, the player standing in front of it, fight started */
    fight(o) {
      g.resetRun();
      wc.play();
      const s = g.session;
      if (o.pcoat) g.setPlayerCoat(o.pcoat);
      const r = s.rivals[o.rival];
      window.__fs.lastRival = o.rival;
      window.__fs.idleRival = null;
      if (o.coat && o.coat !== r.npc.coat) {
        g.scene.remove(r.npc.visual.root);
        const v = g.catModel.make(o.coat, `${r.info.name}_${o.coat}`);
        g.scene.add(v.root);
        r.npc.visual = v;
        r.npc.coat = o.coat;
      }
      if (o.level) r.info.level = o.level;
      r.npc.look.stance = 'stand';
      const h = r.npc.heading * DEG;
      wc.pose(null);
      wc.place(r.npc.x + Math.sin(h) * 1.0, r.npc.y + 0.6, r.npc.z - Math.cos(h) * 1.0, (r.npc.heading + 180) % 360);
      wc.step(4);
      s.beginDuel(r);
      wc.step(80);
      return { name: r.info.name, level: r.info.level, coat: r.npc.coat };
    },
    /** stand somewhere open for the moves outside a fight */
    open() {
      g.resetRun();
      wc.play();
      if (g.session.phase === 'intro') g.session.phase = 'play';
      wc.pose(null);
      wc.place(10.5, 0.6, 6.5, 0);
      wc.step(40);
    },
    /** keep putting these look fields on the player's cat after every game step (moves the game does not send yet) */
    force(f) {
      const s = g.session;
      if (!s.__forced) {
        const orig = s.update.bind(s);
        s.update = (dt, c) => {
          orig(dt, c);
          const k = window.__fs.forced;
          if (!k) return;
          k.t += dt;
          const l = s.playerLook;
          Object.assign(l, k.look);
          l.actT = k.t;
          if (k.rate) l.phase = (k.t * k.rate) % 1;
        };
        s.__forced = true;
      }
      window.__fs.forced = f ? { ...f, t: 0 } : null;
    },
    get duel() {
      return g.session.duel;
    },
    get rival() {
      return g.session.duelRival ?? g.session.rivals[window.__fs.idleRival ?? window.__fs.lastRival ?? 0];
    },
    label() {
      const d = g.session.duel;
      if (!d) {
        const l = g.session.playerLook;
        return `${l.act ?? (l.airborne ? 'air' : l.stance)} ${l.airborne ? (l.airSpeed ?? 0).toFixed(1) : (l.actT ?? 0).toFixed(2)}`;
      }
      return `${d.rivalState} ${d.rivalT.toFixed(2)} | ${d.playerState} ${d.playerT.toFixed(2)}`;
    },
    /** a picture from a free camera beside a cat (who: 'rival' | 'player'), then back to the collar camera */
    sideShot(who, dist, height, back) {
      let x;
      let z;
      let hd;
      if (who === 'player') {
        x = g.player.x;
        z = g.player.z;
        hd = g.player.heading;
      } else {
        const n = window.__fs.rival.npc;
        x = n.x;
        z = n.z;
        hd = n.heading;
      }
      const h = hd * DEG;
      // stand off to the cat's right, a little towards its front, looking back at it
      const fx = Math.sin(h);
      const fz = -Math.cos(h);
      const rx = Math.cos(h);
      const rz = Math.sin(h);
      const cx = x + rx * dist + fx * back;
      const cz = z + rz * dist + fz * back;
      const look = Math.atan2(x + fx * 0.08 - cx, -(z + fz * 0.08 - cz)) / DEG;
      const y = (who === 'player' ? g.player.y : window.__fs.rival.npc.y) + height;
      g.freeCam = { x: cx, y, z: cz, heading: look, pitch: -4, roll: 0 };
      g.post.cut();
      g.render(0);
      const data = wc.shot();
      g.freeCam = null;
      g.post.cut();
      return data;
    },
  };
});

const SEQ = {
  guard: { frames: 96, setup: 'fight', stage: (d) => { d.rivalState = 'guard'; d.rivalT = 0; } , who: 'rival', every: 4 },
  windup: {
    frames: 0, setup: 'fight', who: 'rival',
    stage: (d, o) => { d.rivalState = 'windup'; d.rivalT = 0; d.rivalSide = o.side; },
  },
  miss: {
    frames: 0, setup: 'fight', who: 'rival', dodgeAt: true,
    stage: (d, o) => { d.rivalState = 'windup'; d.rivalT = 0; d.rivalSide = o.side; },
  },
  feint: { frames: 0, setup: 'fight', who: 'rival', stage: (d, o) => { d.rivalState = 'feint'; d.rivalT = 0; d.rivalSide = o.side; } },
  stagger: {
    frames: 50, setup: 'fight', who: 'rival', slapAt: 2,
    stage: (d, o) => { d.rivalState = 'recover'; d.rivalT = 0.2; d.rivalSide = o.side; },
  },
  gloat: {
    frames: 0, setup: 'fight', who: 'rival', extra: 70,
    stage: (d, o) => { d.playerNerve = 1; d.rivalState = 'windup'; d.rivalT = 0; d.rivalSide = o.side; },
  },
  flee: {
    frames: 70, setup: 'fight', who: 'rival', slapAt: 2,
    stage: (d, o) => { d.rivalNerve = 1; d.rivalState = 'recover'; d.rivalT = 0.1; d.rivalSide = o.side; },
  },
  slap: { frames: 44, setup: 'fight', who: 'player', slapAt: 2, slapAt2: 26, every: 2, stage: (d) => { d.rivalState = 'guard'; d.rivalT = -5; } },
  dodge: { frames: 40, setup: 'fight', who: 'player', dodgeAtFrame: 2, stage: (d) => { d.rivalState = 'guard'; d.rivalT = -5; } },
  flinch: {
    frames: 32, setup: 'fight', who: 'player',
    stage: (d) => { d.rivalState = 'guard'; d.rivalT = -5; d.playerState = 'flinch'; d.playerT = 0; },
  },
  swipe: { frames: 30, setup: 'open', who: 'player', swipeAt: 2, stage: null },
  jump: { frames: 64, setup: 'open', who: 'player', jumpAt: 4, stage: null, every: 3 },
  idle: { frames: 480, setup: 'idle', who: 'rival', stage: null, every: 12 },
  climb: { frames: 60, setup: 'open', who: 'player', stage: null, every: 3, force: { look: { act: 'climb', speed: 1.4, actLen: 0 }, rate: 1.6 }, tilt: 45 },
  hang: { frames: 30, setup: 'open', who: 'player', stage: null, every: 6, force: { look: { act: 'climb', speed: 0, actLen: 0 }, rate: 0 }, tilt: 45 },
  mantle: { frames: 54, setup: 'open', who: 'player', stage: null, every: 3, force: { look: { act: 'mantle', speed: 0, actLen: 0.8 } }, tilt: 25 },
  tired: { frames: 60, setup: 'fight', who: 'rival', every: 6, stage: (d) => { d.rivalState = 'guard'; d.rivalT = -5; }, force: { look: { tired: 1 } }, tiredRival: true },
};

const opts = { rival: rivalIndex, coat, level, side, pcoat };
const sheets = [];

for (const name of seqs) {
  const q = SEQ[name];
  if (!q) {
    console.error(`unknown sequence ${name}`);
    continue;
  }
  let info = '';
  if (q.setup === 'fight') info = JSON.stringify(await page.evaluate((o) => window.__fs.fight(o), opts));
  else if (q.setup === 'idle') {
    await page.evaluate((o) => {
      window.__fs.open();
      const s = window.__wc.game.session;
      const r = s.rivals[o.rival];
      window.__wc.place(r.npc.x + 4.6, r.npc.y + 0.6, r.npc.z + 4.6, 0);
      window.__fs.idleRival = o.rival;
      window.__wc.step(10);
    }, opts);
  } else await page.evaluate(() => window.__fs.open());
  await page.evaluate(([f, tilt, tr]) => {
    window.__fs.force(f ?? null);
    window.__wc.game.player.tiltUp = tilt ?? 0;
    window.__fs.tiltHold = tilt ?? null;
    window.__fs.tiredRival = !!tr;
  }, [q.force, q.tilt, q.tiredRival]);
  if (q.stage) await page.evaluate(([code, o]) => { const d = window.__fs.duel; d.playerNerve = Math.max(d.playerNerve, 2); d.rivalNerve = Math.max(d.rivalNerve, 2); (0, eval)(`(${code})`)(d, o); }, [q.stage.toString(), opts]);
  // how long to film: a whole windup, strike and recover for the rival's attacks
  let frames = q.frames;
  let dodgeFrame = q.dodgeAtFrame ?? -1;
  if (!frames) {
    const t = await page.evaluate(() => window.__fs.duel.tuning);
    const wind = name === 'feint' ? t.windup * 0.7 : t.windup;
    frames = Math.round((wind + 0.16 + (name === 'miss' ? 0.85 : name === 'feint' ? 0.3 : 0.5) + 0.25) * 60) + (q.extra ?? 0);
    if (q.dodgeAt) dodgeFrame = Math.max(0, Math.round((t.windup - 0.22) * 60));
  }
  const n = q.every ?? every;
  const camShots = [];
  const sideShots = [];
  for (let f = 0; f <= frames; f++) {
    const input = {};
    if (f === dodgeFrame) input.dodge = true;
    if (f === q.slapAt || f === q.swipeAt) input[side < 0 ? 'pawLeft' : 'pawRight'] = true;
    if (f === q.slapAt2) input[side < 0 ? 'pawRight' : 'pawLeft'] = true;
    if (f === q.jumpAt) input.jump = true;
    const res = await page.evaluate(
      ([inp, take, who]) => {
        const wc = window.__wc;
        if (window.__fs.tiltHold !== null && window.__fs.tiltHold !== undefined) wc.game.player.tiltUp = window.__fs.tiltHold;
        if (window.__fs.tiredRival) window.__fs.rival.npc.look.tired = 1;
        if (inp) wc.sim(inp, 1 / 60);
        if (!take) return null;
        const label = window.__fs.label();
        const cam = wc.shot();
        const sideA = window.__fs.sideShot(who, who === 'player' ? 0.7 : 0.8, 0.2, who === 'player' ? 0.12 : 0.08);
        return { label, cam, side: sideA };
      },
      [f === 0 ? null : input, f % n === 0, q.who],
    );
    if (!res) continue;
    const id = `${name}${tag}_${String(f).padStart(3, '0')}`;
    const camFile = path.join(outDir, 'frames', `${id}_cam.jpg`);
    const sideFile = path.join(outDir, 'frames', `${id}_side.jpg`);
    await fs.mkdir(path.dirname(camFile), { recursive: true });
    await fs.writeFile(camFile, Buffer.from(res.cam.split(',')[1], 'base64'));
    await fs.writeFile(sideFile, Buffer.from(res.side.split(',')[1], 'base64'));
    const label = `${f} ${res.label}`;
    camShots.push({ file: camFile, label });
    sideShots.push({ file: sideFile, label });
  }
  for (const [kind, list] of [['cam', camShots], ['side', sideShots]]) {
    const out = path.join(outDir, `${name}${tag}_${kind}.jpg`);
    await sheet(out, list, kind === 'cam' ? { cols: 10, w: 180, h: 320, crop: null } : { cols: 10, w: 240, h: 240, crop: { left: 0, top: Math.round(H * 0.5 - W * 0.5), width: W, height: W } });
    sheets.push(out);
  }
  console.log(`${name}: ${frames} frames, ${camShots.length} samples ${info}`);
}

async function sheet(out, items, { cols, w, h, crop }) {
  const labelH = 18;
  const rows = Math.ceil(items.length / cols);
  const comps = [];
  for (let i = 0; i < items.length; i++) {
    const x = (i % cols) * w;
    const y = Math.floor(i / cols) * (h + labelH);
    let img = sharp(items[i].file);
    if (crop) img = img.extract(crop);
    comps.push({ input: await img.resize(w, h, { fit: 'cover' }).toBuffer(), left: x, top: y });
    const safe = items[i].label.replace(/[<&>]/g, '');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${labelH}"><rect width="100%" height="100%" fill="#111"/><text x="4" y="13" font-family="Segoe UI, Arial" font-size="11" fill="#eee">${safe}</text></svg>`;
    comps.push({ input: Buffer.from(svg), left: x, top: y + h });
  }
  await sharp({ create: { width: cols * w, height: rows * (h + labelH), channels: 3, background: '#202020' } })
    .composite(comps)
    .jpeg({ quality: 84 })
    .toFile(out);
}

console.log('sheets:\n' + sheets.join('\n'));
if (problems.length) console.log('browser messages:\n' + [...new Set(problems)].slice(0, 20).join('\n'));
await browser.close();
await server.close();
