import * as THREE from 'three';
import { setProbe, type Materials } from '../engine/materials';
import { SHADOW_LAYER } from '../engine/shadows';
import type { GroundLight, GroundSample } from '../engine/world';

interface Bird {
  group: THREE.Group;
  wingL: THREE.Mesh;
  wingR: THREE.Mesh;
  head: THREE.Mesh;
  x: number;
  y: number;
  z: number;
  heading: number;
  /** 'peck' on the ground, 'fly' away, 'away' = out of sight until it comes back */
  state: 'peck' | 'fly' | 'away';
  t: number;
  vx: number;
  vy: number;
  vz: number;
  phase: number;
  walk: number;
}

/** A small flock of pigeons on the ground. Run at them and they burst into the air. */
export class Pigeons {
  /** called once when the flock takes off: (x, z) of the flock */
  onScatter: ((x: number, z: number) => void) | null = null;
  private readonly birds: Bird[] = [];

  /** every bird's own object in the scene */
  get roots(): THREE.Object3D[] {
    return this.birds.map((b) => b.group);
  }
  private readonly mat: THREE.ShaderMaterial;
  private readonly sample: GroundSample = { r: 0, g: 0, b: 0, sun: 1 };
  private home = { x: 0, z: 0 };
  private groundY = 0;
  private spotIndex = 0;
  private awayFor = 0;
  private flockState: 'down' | 'up' = 'down';

  constructor(
    scene: THREE.Scene,
    private readonly materials: Materials,
    private readonly light: GroundLight,
    private readonly spots: [number, number, number][],
    count = 7,
  ) {
    this.mat = materials.custom('pigeon', { kind: 'flat', color: [0.2, 0.21, 0.23], rough: 0.7, metal: 0 });
    const neck = materials.custom('pigeon_neck', { kind: 'flat', color: [0.1, 0.16, 0.14], rough: 0.35, metal: 0.3 });
    const body = new THREE.SphereGeometry(0.06, 10, 8);
    body.scale(0.72, 0.8, 1.5);
    const headGeo = new THREE.SphereGeometry(0.026, 8, 6);
    const wingGeo = new THREE.BufferGeometry();
    // a wing: a long triangle fan hinged at the shoulder (x = out along the wing)
    wingGeo.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, -0.05, 0.19, 0, -0.02, 0.2, 0, 0.05, 0, 0, 0.07], 3));
    wingGeo.setIndex([0, 1, 2, 0, 2, 3, 2, 1, 0, 3, 2, 0]);
    wingGeo.computeVertexNormals();
    for (let i = 0; i < count; i++) {
      const group = new THREE.Group();
      const b = new THREE.Mesh(body, this.mat);
      b.position.y = 0.075;
      const head = new THREE.Mesh(headGeo, neck);
      head.position.set(0, 0.135, -0.075);
      const wingL = new THREE.Mesh(wingGeo, this.mat);
      wingL.position.set(-0.035, 0.1, -0.01);
      wingL.scale.x = -1;
      const wingR = new THREE.Mesh(wingGeo, this.mat);
      wingR.position.set(0.035, 0.1, -0.01);
      group.add(b, head, wingL, wingR);
      group.traverse((o) => o.layers.enable(SHADOW_LAYER));
      scene.add(group);
      this.birds.push({ group, wingL, wingR, head, x: 0, y: 0, z: 0, heading: 0, state: 'peck', t: Math.random() * 5, vx: 0, vy: 0, vz: 0, phase: Math.random() * 6, walk: 0 });
    }
    this.land(0);
  }

  private land(index: number): void {
    this.spotIndex = index % this.spots.length;
    const [x, y, z] = this.spots[this.spotIndex];
    this.home = { x, z };
    this.groundY = y;
    this.flockState = 'down';
    const s = this.light.sample(x, z, this.sample, y);
    setProbe(this.mat, s, this.materials.globals);
    for (const b of this.birds) {
      const a = Math.random() * Math.PI * 2;
      const r = 0.3 + Math.random() * 1.3;
      b.x = x + Math.cos(a) * r;
      b.z = z + Math.sin(a) * r;
      b.y = y;
      b.heading = Math.random() * 360;
      b.state = 'peck';
      b.group.visible = true;
    }
  }

  reset(): void {
    this.land(0);
  }

  /** (px, pz) = the cat, `speed` = how fast it is going. */
  update(dt: number, px: number, pz: number, speed: number): void {
    const d = Math.hypot(px - this.home.x, pz - this.home.z);
    if (this.flockState === 'down' && d < (Math.abs(speed) > 4 ? 5.5 : 3.2)) {
      this.flockState = 'up';
      this.awayFor = 0;
      this.onScatter?.(this.home.x, this.home.z);
      for (const b of this.birds) {
        // away from the cat, fanned out
        const away = Math.atan2(b.x - px, b.z - pz) + (Math.random() - 0.5) * 1.4;
        const v = 5 + Math.random() * 3;
        b.vx = Math.sin(away) * v;
        b.vz = Math.cos(away) * v;
        b.vy = 2.2 + Math.random() * 1.8;
        b.state = 'fly';
        b.t = -Math.random() * 0.25; // not all in the same instant
      }
    }
    if (this.flockState === 'up') {
      this.awayFor += dt;
      // once the fuss is over they settle somewhere else, as long as the cat is not there
      if (this.awayFor > 22) {
        const next = this.spotIndex + 1;
        const [nx, , nz] = this.spots[next % this.spots.length];
        if (Math.hypot(px - nx, pz - nz) > 14) this.land(next);
      }
    }
    for (const b of this.birds) {
      b.t += dt;
      if (b.state === 'peck') {
        // potter about: a few steps, a peck, a turn
        b.walk -= dt;
        if (b.walk <= 0) {
          b.walk = 0.6 + Math.random() * 2.2;
          b.heading += (Math.random() - 0.5) * 140;
        }
        const moving = b.walk > 0.5 ? 0.16 : 0;
        const h = (b.heading * Math.PI) / 180;
        b.x += Math.sin(h) * moving * dt;
        b.z -= Math.cos(h) * moving * dt;
        // stay near the flock
        const off = Math.hypot(b.x - this.home.x, b.z - this.home.z);
        if (off > 1.9) b.heading = (Math.atan2(this.home.x - b.x, -(this.home.z - b.z)) * 180) / Math.PI;
        const peck = Math.max(0, Math.sin(b.t * 3.1 + b.phase)) ** 6;
        b.head.position.y = 0.135 - peck * 0.09;
        b.head.position.z = -0.075 - peck * 0.03 + Math.sin(b.t * 9) * 0.006 * (moving > 0 ? 1 : 0);
        b.wingL.rotation.z = 1.25;
        b.wingR.rotation.z = -1.25;
        b.group.rotation.set(0, -h, 0);
      } else if (b.state === 'fly') {
        if (b.t < 0) continue;
        b.x += b.vx * dt;
        b.y += b.vy * dt;
        b.z += b.vz * dt;
        b.vy += (3.2 - b.vy) * dt * 0.8;
        const flap = Math.sin(b.t * 30 + b.phase) * 1.0;
        b.wingL.rotation.z = 0.15 + flap;
        b.wingR.rotation.z = -0.15 - flap;
        b.head.position.set(0, 0.125, -0.085);
        b.group.rotation.set(-0.35, Math.atan2(-b.vx, -b.vz), 0);
        if (b.y > this.groundY + 26 || b.t > 7) {
          b.state = 'away';
          b.group.visible = false;
        }
      }
      b.group.position.set(b.x, b.y, b.z);
    }
  }
}
