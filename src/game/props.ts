import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { setProbe } from '../engine/materials';
import { G, type Physics } from '../engine/physics';
import { SHADOW_LAYER } from '../engine/shadows';
import type { GroundSample, LoadedWorld } from '../engine/world';

export interface Prop {
  kind: string;
  group: THREE.Group;
  body: import('@dimforge/rapier3d-compat').RigidBody;
  materials: THREE.ShaderMaterial[];
  /** where it stood at the start */
  home: THREE.Vector3;
  homeRot: THREE.Quaternion;
  /** seconds since it last counted as "knocked over" */
  quiet: number;
  knocked: boolean;
  litAt: THREE.Vector3;
  size: number;
}

export interface KnockEvent {
  prop: Prop;
  /** how fast it was moving when it counted, metres per second */
  speed: number;
}

/** Loose things: pots, cans, balls, a gnome. They sit still until something (a paw) moves them. */
export class Props {
  readonly items: Prop[] = [];
  onKnock: ((e: KnockEvent) => void) | null = null;
  private readonly sample: GroundSample = { r: 0, g: 0, b: 0, sun: 1 };
  private readonly tmp = new THREE.Vector3();

  private constructor(private readonly world: LoadedWorld) {}

  static async create(world: LoadedWorld, physics: Physics, scene: THREE.Scene): Promise<Props> {
    const props = new Props(world);
    const info = world.info.props;
    if (!info) return props;
    const loader = new GLTFLoader();
    loader.setMeshoptDecoder(MeshoptDecoder);
    const models = new Map<string, THREE.Group>();
    await Promise.all(
      Object.entries(info.models).map(async ([key, m]) => {
        const gltf = await loader.loadAsync(world.base + m.file);
        gltf.scene.updateMatrixWorld(true);
        models.set(key, gltf.scene);
      }),
    );
    const R = physics.R;
    for (const item of info.items) {
      const src = models.get(item.key);
      if (!src) continue;
      const group = src.clone(true);
      const mats: THREE.ShaderMaterial[] = [];
      const pts: number[] = [];
      const v = new THREE.Vector3();
      group.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        const mat = world.materials.fresh((mesh.material as THREE.Material).name);
        mesh.material = mat;
        mats.push(mat);
        mesh.layers.enable(SHADOW_LAYER);
        const pos = mesh.geometry.getAttribute('position');
        const step = Math.max(1, Math.floor(pos.count / 220));
        for (let i = 0; i < pos.count; i += step) {
          v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld).multiplyScalar(item.scale);
          pts.push(v.x, v.y, v.z);
        }
      });
      group.scale.setScalar(item.scale);
      const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), THREE.MathUtils.degToRad(item.rot));
      const body = physics.world.createRigidBody(
        R.RigidBodyDesc.dynamic()
          .setTranslation(item.pos[0], item.pos[1] + 0.004, item.pos[2])
          .setRotation({ x: q.x, y: q.y, z: q.z, w: q.w })
          .setLinearDamping(0.25)
          .setAngularDamping(item.kind === 'ball' ? 0.5 : 1.1)
          .setCanSleep(true),
      );
      const size = info.models[item.key].size;
      let desc =
        item.kind === 'ball'
          ? R.ColliderDesc.ball((Math.max(size[0], size[1], size[2]) * item.scale) / 2).setTranslation(0, (size[1] * item.scale) / 2, 0)
          : R.ColliderDesc.convexHull(new Float32Array(pts));
      if (!desc) desc = R.ColliderDesc.cuboid((size[0] * item.scale) / 2, (size[1] * item.scale) / 2, (size[2] * item.scale) / 2);
      desc
        .setMass(item.mass)
        .setFriction(item.kind === 'ball' ? 0.6 : 0.85)
        .setRestitution(item.kind === 'ball' ? 0.55 : 0.12)
        .setCollisionGroups((G.PROP << 16) | (G.WORLD | G.PROP | G.PLAYER));
      physics.world.createCollider(desc, body);
      body.sleep();
      group.position.set(item.pos[0], item.pos[1], item.pos[2]);
      group.quaternion.copy(q);
      scene.add(group);
      const prop: Prop = {
        kind: item.kind,
        group,
        body,
        materials: mats,
        home: new THREE.Vector3(item.pos[0], item.pos[1], item.pos[2]),
        homeRot: q.clone(),
        quiet: 99,
        knocked: false,
        litAt: new THREE.Vector3(1e9, 0, 0),
        size: Math.max(size[0], size[1], size[2]) * item.scale,
      };
      props.items.push(prop);
      props.light(prop);
    }
    return props;
  }

  private light(p: Prop): void {
    const s = this.world.groundLight.sample(p.group.position.x, p.group.position.z, this.sample);
    for (const m of p.materials) setProbe(m, s, this.world.materials.globals);
    p.litAt.copy(p.group.position);
  }

  update(dt: number): void {
    for (const p of this.items) {
      p.quiet += dt;
      if (p.body.isSleeping()) continue;
      const t = p.body.translation();
      const r = p.body.rotation();
      p.group.position.set(t.x, t.y, t.z);
      p.group.quaternion.set(r.x, r.y, r.z, r.w);
      if (p.litAt.distanceToSquared(p.group.position) > 0.04) this.light(p);
      const lv = p.body.linvel();
      const speed = Math.hypot(lv.x, lv.y, lv.z);
      const moved = this.tmp.copy(p.group.position).sub(p.home).length();
      if (!p.knocked && p.quiet > 1 && (speed > 1.1 || moved > Math.max(0.12, p.size * 0.5))) {
        p.knocked = true;
        p.quiet = 0;
        this.onKnock?.({ prop: p, speed });
      }
      if (t.y < -5) {
        // fell out of the world somehow: put it back
        p.body.setTranslation({ x: p.home.x, y: p.home.y + 0.05, z: p.home.z }, true);
        p.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      }
    }
  }

  /** Put everything back where it started (new run). */
  reset(): void {
    for (const p of this.items) {
      const q = p.homeRot;
      p.body.setTranslation({ x: p.home.x, y: p.home.y + 0.004, z: p.home.z }, false);
      p.body.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, false);
      p.body.setLinvel({ x: 0, y: 0, z: 0 }, false);
      p.body.setAngvel({ x: 0, y: 0, z: 0 }, false);
      p.body.sleep();
      p.group.position.copy(p.home);
      p.group.quaternion.copy(q);
      p.knocked = false;
      p.quiet = 99;
      this.light(p);
    }
  }

  /** A paw swipe: everything loose within reach in front of `origin` gets a shove along `dir`. */
  swipe(origin: THREE.Vector3, dir: THREE.Vector3, reach = 0.36, strength = 1): number {
    let hits = 0;
    for (const p of this.items) {
      const t = p.body.translation();
      this.tmp.set(t.x - origin.x, t.y + p.size * 0.4 - origin.y, t.z - origin.z);
      const d = this.tmp.length();
      if (d > reach + p.size * 0.5) continue;
      if (d > 0.05 && this.tmp.dot(dir) / d < 0.2) continue;
      const m = p.body.mass();
      const push = Math.min(2.6, 1.3 + 0.9 * strength) * m;
      p.body.applyImpulse({ x: dir.x * push, y: 0.35 * push, z: dir.z * push }, true);
      p.body.applyTorqueImpulse({ x: dir.z * push * 0.04, y: 0, z: -dir.x * push * 0.04 }, true);
      hits++;
    }
    return hits;
  }
}
