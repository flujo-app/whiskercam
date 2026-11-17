import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { setProbe, type Globals, type Materials } from '../engine/materials';
import { furFragment, furVertex } from '../engine/shaders/fur.glsl';
import { SHADOW_LAYER } from '../engine/shadows';
import type { GroundSample } from '../engine/world';
import type { CatLook, CatVisual, Coat } from './cats';

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));
const smoothstep = (a: number, b: number, x: number): number => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
const TAU = Math.PI * 2;

/**
 * Which way "positive" turns each joint, as built by pipeline/blender/assets/cat.py.
 * All bones have their local X axis pointing to the cat's right, so every bend in the
 * side-view plane is a rotation about X; these signs make +angle mean "forwards / up / flex".
 */
export /** The collar camera hangs this far below the neck bone and this far ahead of it (metres). */
const COLLAR_DROP = 0.082;
const COLLAR_AHEAD = 0.047;

const JOINT_SIGN: Record<string, number> = {
  // bones that point forwards (spine, neck, head): + tips the front end up
  spine: 1, neck: 1, head: 1,
  // bones that point backwards / down-back: + would tip them down, so lift = -1
  tail: -1, jaw: -1,
  // leg bones point down: + swings the far end forwards. Flexing a joint means:
  scapula: 1, upperarm: 1, forearm: 1, wrist: -1, paw: -1,
  thigh: 1, shin: -1, hock: 1, hindpaw: -1, ear: 1,
};

const SIDES = ['L', 'R'] as const;

/** The cat model, loaded once and copied for every cat on screen. */
export class CatModel {
  private constructor(
    private readonly template: THREE.Object3D,
    private readonly coats: Map<Coat, THREE.Texture>,
    private readonly furMap: THREE.Texture,
    private readonly eyeMap: THREE.Texture | null,
    private readonly materials: Materials,
  ) {}

  static async load(base: string, materials: Materials, coats: Coat[]): Promise<CatModel> {
    const gltf = await new GLTFLoader().loadAsync(`${base}cat.glb`);
    const loader = new THREE.TextureLoader();
    const tex = async (file: string, srgb: boolean) => {
      const t = await loader.loadAsync(base + file);
      t.flipY = false;
      t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.anisotropy = 4;
      return t;
    };
    const map = new Map<Coat, THREE.Texture>();
    await Promise.all(coats.map(async (c) => map.set(c, await tex(`cat_${c}_diff.webp`, true))));
    const fur = await tex('cat_fur.webp', false);
    let eyes: THREE.Texture | null = null;
    try {
      eyes = await tex('cat_eyes.webp', true);
    } catch {
      eyes = null;
    }
    return new CatModel(gltf.scene, map, fur, eyes, materials);
  }

  /** how many fur layers a cat right in front of the camera gets */
  shells = 16;

  make(coat: Coat, name: string): FurCat {
    return new FurCat(cloneSkinned(this.template), this.coats.get(coat) ?? [...this.coats.values()][0], this.furMap, this.eyeMap, this.materials, name, this.shells);
  }
}

export class FurCat implements CatVisual {
  readonly root = new THREE.Group();
  /** where the collar camera sits (under the throat), in the model's own space */
  readonly collarAt = new THREE.Vector3(0, 0.17, -0.19);
  private neck: THREE.Object3D | null = null;
  shellCount = 18;
  private readonly bones = new Map<string, THREE.Bone>();
  private readonly rest = new Map<string, THREE.Quaternion>();
  private readonly restPos = new Map<string, THREE.Vector3>();
  private readonly fur: THREE.ShaderMaterial;
  private readonly shells: THREE.SkinnedMesh;
  private readonly shellGeo: THREE.InstancedBufferGeometry;
  private readonly extra: THREE.ShaderMaterial[] = [];
  private readonly q = new THREE.Quaternion();
  private readonly e = new THREE.Euler();
  private readonly lag = new THREE.Vector3();
  private readonly lastPos = new THREE.Vector3();
  private t = Math.random() * 10;
  private blink = 0;
  private whiskerMat: THREE.LineBasicMaterial | null = null;

  constructor(model: THREE.Object3D, coat: THREE.Texture, furMap: THREE.Texture, eyeMap: THREE.Texture | null, private readonly materials: Materials, name: string, shells = 16) {
    this.shellCount = shells;
    const g: Globals = materials.globals;
    this.root.add(model);
    this.root.name = `cat:${name}`;
    let body: THREE.SkinnedMesh | null = null;
    model.traverse((o) => {
      const bone = o as THREE.Bone;
      if (bone.isBone) {
        this.bones.set(bone.name, bone);
        this.rest.set(bone.name, bone.quaternion.clone());
        this.restPos.set(bone.name, bone.position.clone());
      }
      const mesh = o as THREE.SkinnedMesh;
      if (mesh.isSkinnedMesh) {
        mesh.frustumCulled = false;
        const matName = (mesh.material as THREE.Material).name;
        if (matName === 'cat_body' || mesh.name.toLowerCase().includes('body')) body = mesh;
        else {
          // eyes and other smooth parts: ordinary shiny surface, lit like the rest of the cat
          const m = materials.custom(`${name}_${matName}`, eyeMap ? { kind: 'flat', color: [1, 1, 1], rough: 0.08, metal: 0 } : { kind: 'flat', color: [0.35, 0.3, 0.08], rough: 0.08, metal: 0 });
          if (eyeMap) {
            m.defines.USE_MAP = 1;
            m.uniforms.uMapDiff.value = eyeMap;
            m.uniforms.uRough.value = 0.08;
            m.uniforms.uMetal.value = 0;
            m.needsUpdate = true;
          }
          mesh.material = m;
          this.extra.push(m);
        }
      }
    });
    if (!body) throw new Error('cat model has no body mesh');
    const base = body as THREE.SkinnedMesh;

    this.fur = new THREE.ShaderMaterial({
      vertexShader: furVertex,
      fragmentShader: furFragment,
      uniforms: {
        uCoat: { value: coat },
        uFurMap: { value: furMap },
        uShells: { value: this.shellCount },
        uFurLength: { value: 0.026 },
        uDensity: { value: 520 },
        uPuff: { value: 0 },
        uLag: { value: this.lag },
        uTint: { value: new THREE.Color(1, 1, 1) },
        uCoatSat: { value: 1 },
        uProbeIrrUp: { value: new THREE.Color(0.3, 0.4, 0.6) },
        uProbeIrrDown: { value: new THREE.Color(0.2, 0.18, 0.15) },
        uProbeSun: { value: 1 },
        uSunDir: g.uSunDir,
        uSunColor: g.uSunColor,
        uFogColor: g.uFogColor,
        uFogDensity: g.uFogDensity,
        uShadowNear: g.uShadowNear,
        uShadowNearMat: g.uShadowNearMat,
        uShadowTexel: g.uShadowTexel,
        uShadowOn: g.uShadowOn,
      },
    });
    // the same body, drawn once per shell in a single call
    const ig = new THREE.InstancedBufferGeometry();
    ig.index = base.geometry.index;
    for (const [key, attr] of Object.entries(base.geometry.attributes)) ig.setAttribute(key, attr);
    ig.instanceCount = this.shellCount;
    ig.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 2);
    this.shellGeo = ig;
    this.shells = new THREE.SkinnedMesh(ig, this.fur);
    this.shells.bind(base.skeleton, base.bindMatrix);
    this.shells.frustumCulled = false;
    base.parent!.add(this.shells);
    // the plain body only exists to throw the shadow
    base.material = new THREE.MeshBasicMaterial();
    base.layers.set(SHADOW_LAYER);

    this.root.updateMatrixWorld(true);
    this.addWhiskers();
    const neck = this.bones.get('neck') ?? this.bones.get('chest');
    if (neck) {
      // the camera hangs from the collar: below the throat and a little ahead of it, clear of the chest fur
      this.neck = neck;
      neck.getWorldPosition(this.collarAt);
      this.collarAt.y -= COLLAR_DROP;
      this.collarAt.z -= COLLAR_AHEAD;
    }
  }

  /** Where the collar camera hangs right now (world space), after the pose has been applied. */
  collarWorld(out: THREE.Vector3): THREE.Vector3 {
    if (!this.neck) return this.root.localToWorld(out.copy(this.collarAt));
    this.root.updateMatrixWorld(true);
    this.neck.getWorldPosition(out);
    const yaw = this.root.rotation.y;
    out.y -= COLLAR_DROP;
    out.x -= Math.sin(yaw) * COLLAR_AHEAD;
    out.z -= Math.cos(yaw) * COLLAR_AHEAD;
    return out;
  }

  /** Long white whiskers on both sides of the muzzle: thin lines that ride on the head. */
  private addWhiskers(): void {
    const head = this.bones.get('head');
    if (!head) return;
    const pts: number[] = [];
    const v = new THREE.Vector3();
    const push = (x: number, y: number, z: number) => {
      head.worldToLocal(v.set(x, y, z));
      pts.push(v.x, v.y, v.z);
    };
    for (const side of [-1, 1]) {
      for (let k = 0; k < 6; k++) {
        const row = k % 3;
        const col = Math.floor(k / 3);
        const x0 = side * (0.011 + col * 0.006);
        const y0 = 0.2395 - row * 0.005;
        const z0 = -0.251 + col * 0.007;
        const len = 0.062 + 0.018 * ((k * 37) % 5) / 4;
        const up = (1 - row) * 0.22 - 0.05;          // top row fans up, bottom row down
        const fwd = -0.1 - col * 0.25;
        const n = 7;
        let px = x0;
        let py = y0;
        let pz = z0;
        for (let i = 1; i <= n; i++) {
          const f = i / n;
          const nx = x0 + side * len * f;
          const ny = y0 + len * (up * f - 0.35 * f * f);  // a gentle droop towards the tip
          const nz = z0 + len * fwd * f;
          push(px, py, pz);
          push(nx, ny, nz);
          px = nx;
          py = ny;
          pz = nz;
        }
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    this.whiskerMat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85 });
    const lines = new THREE.LineSegments(geo, this.whiskerMat);
    lines.frustumCulled = false;
    head.add(lines);
  }

  /** Fewer shells for cats far from the camera; none at all when too far to see fur. */
  setDetail(distance: number): void {
    const n = Math.min(this.shellCount, distance < 2.5 ? this.shellCount : distance < 7 ? 12 : distance < 16 ? 8 : distance < 34 ? 5 : 3);
    this.shellGeo.instanceCount = n;
    this.fur.uniforms.uShells.value = n;
    this.root.visible = distance < 75;
  }

  setLight(sample: GroundSample): void {
    // whiskers are white hairs: as bright as a white thing would be in this light
    const sun = this.materials.globals.uSunColor.value;
    const k = (sample.sun * 0.5) / Math.PI;
    this.whiskerMat?.color.setRGB((sample.r + sun.r * k) * 0.8, (sample.g + sun.g * k) * 0.8, (sample.b + sun.b * k) * 0.8);
    setProbe(this.fur, sample, this.materials.globals);
    for (const m of this.extra) setProbe(m, sample, this.materials.globals);
  }

  setVisible(mainView: boolean): void {
    this.shells.visible = mainView;
    this.root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh && mesh !== this.shells && !mesh.layers.isEnabled(SHADOW_LAYER)) mesh.visible = mainView;
    });
  }

  private turn(name: string, x: number, y = 0, z = 0): void {
    const bone = this.bones.get(name);
    const rest = this.rest.get(name);
    if (!bone || !rest) return;
    this.e.set(x, y, z, 'XYZ');
    bone.quaternion.copy(rest).multiply(this.q.setFromEuler(this.e));
  }

  update(look: CatLook, dt: number): void {
    this.t += dt;
    const S = JOINT_SIGN;
    const a = look.phase * TAU;
    const v = look.speed;
    const moving = look.stance === 'move' ? clamp(v / 1.0, 0, 1) : 0;
    const run = clamp((v - 1) / 6.6, 0, 1);
    const gallop = smoothstep(3.6, 4.8, v) * moving;
    const lowAng = clamp(look.headLow / 0.17, -0.5, 0.9);
    const sit = look.stance === 'sit' ? 1 : 0;
    const low = look.stance === 'crouch' ? 1 : 0;
    const fight = look.stance === 'fight' ? 1 : 0;

    // ---- spine: arches and stretches with every bound, sags when crouching, tips up to sit
    const bound = Math.sin(a) * gallop;
    const arch = bound * 0.2 + look.puff * 0.16 - low * 0.05 + look.flinch * 0.1;
    this.turn('hips', S.spine * (sit * 0.62 - arch * 0.6 + low * 0.06 + fight * 0.1));
    this.turn('spine1', S.spine * (-arch * 0.5 - sit * 0.1));
    this.turn('spine2', S.spine * (arch * 0.4 - sit * 0.12));
    this.turn('chest', S.spine * (arch * 0.7 - sit * 0.1 - fight * 0.05 - lowAng * 0.5));
    const sway = Math.sin(a) * 0.05 * moving * (1 - gallop);
    const nod = Math.sin(a * 2) * 0.04 * moving * (1 - gallop) + bound * 0.1;
    // the head stays level whatever the body does; turning left / right is a twist about the bone's own up axis
    this.turn('neck', S.neck * (-sit * 0.3 + nod - low * 0.2 + fight * 0.08 + look.flinch * 0.25 - lowAng * 0.35), 0, -look.headTurn * 0.5 - sway);
    this.turn('head', S.head * (-sit * 0.25 + low * 0.25 + look.flinch * 0.12 - arch * 0.3 + lowAng * 0.7), 0, -look.headTurn * 0.6);
    this.turn('jaw', S.jaw * (look.puff > 0.5 && fight ? 0.28 : 0));
    const earBack = clamp(look.puff * 0.9 + look.flinch, 0, 1);
    for (const ear of ['ear.L', 'earL']) this.turn(ear, -earBack * 0.6, 0, earBack * 0.4);
    for (const ear of ['ear.R', 'earR']) this.turn(ear, -earBack * 0.6, 0, -earBack * 0.4);

    // ---- tail: streams behind at speed, curls round when sitting, bottle-brush in a fight
    for (let i = 1; i <= 5; i++) {
      const wave = Math.sin(this.t * 2.1 - i * 0.6) * 0.1 * (1 - run);
      const lift = (0.06 + run * 0.1 + look.puff * 0.3) * (i === 1 ? 1.4 : 0.6) - sit * (i === 1 ? 0.75 : 0.02);
      this.turn(`tail${i}`, S.tail * (lift + Math.sin(a - i * 0.5) * 0.06 * gallop), 0, wave + sit * 0.42 + Math.sin(this.t * 0.9 + i) * 0.04 * sit);
    }

    // ---- legs
    for (let s = 0; s < 2; s++) {
      const side = SIDES[s];
      const out = s === 0 ? -1 : 1;       // sideways direction for this leg (left leg swings out to the left)
      const b = (base: string) => (this.bones.has(`${base}.${side}`) ? `${base}.${side}` : `${base}${side}`);
      // front: trot = diagonals together, gallop = both fronts nearly together
      const fPhase = a + (s === 0 ? 0 : Math.PI) * (1 - gallop) + (s === 0 ? 0 : 0.6) * gallop;
      const fSwing = Math.sin(fPhase) * (0.3 + 0.2 * run + 0.08 * gallop) * moving;
      const fLift = Math.max(0, Math.cos(fPhase)) * moving;
      const raised = s === 0 ? look.pawLeft : look.pawRight;
      // sitting tips the chest up; the front legs swing back under it so the paws stay planted
      this.turn(b('scapula'), S.scapula * (fSwing * 0.3 + raised * 0.2 - sit * 0.22));
      this.turn(b('upperarm'), S.upperarm * (fSwing * 0.9 + raised * 1.1 - sit * 0.5 + low * 0.45 + fight * 0.06), 0, out * raised * 0.3);
      this.turn(b('forearm'), S.forearm * (fLift * (0.45 + 0.45 * run) + raised * 0.55 - low * 0.95 + sit * 0.12));
      this.turn(b('wrist'), S.wrist * (fLift * 0.7 - raised * 0.5 - low * 0.4));
      this.turn(b('paw'), S.paw * (fLift * 0.4 - raised * 0.3));
      // hind: opposite the fronts in a gallop, diagonal partner in a trot
      const hPhase = a + (s === 0 ? Math.PI : 0) * (1 - gallop) + (Math.PI + (s === 0 ? 0 : 0.5)) * gallop;
      const hSwing = Math.sin(hPhase) * (0.28 + 0.26 * run + 0.32 * gallop) * moving;
      const hLift = Math.max(0, Math.cos(hPhase)) * moving;
      this.turn(b('thigh'), S.thigh * (hSwing * 0.9 + sit * 0.5 + low * 0.5 + fight * 0.2), 0, out * sit * 0.22);
      this.turn(b('shin'), S.shin * (hLift * (0.5 + 0.4 * run) + sit * 1.25 + low * 0.9 + fight * 0.3));
      this.turn(b('hock'), S.hock * (hLift * 0.6 + sit * 1.1 + low * 0.5 + fight * 0.2));
      this.turn(b('hindpaw'), S.hindpaw * (hLift * 0.4));
    }

    // ---- whole body: bob with the stride, sink when sitting or ducking
    const root = this.bones.get('root');
    const rp = this.restPos.get('root');
    if (root && rp) {
      const bob = gallop * Math.abs(Math.sin(a)) * 0.022 + (1 - gallop) * Math.sin(a * 2) * 0.004 * moving;
      root.position.set(rp.x, rp.y, rp.z);
      this.root.children[0].position.y = bob - sit * 0.145 - low * 0.058 + look.puff * 0.012;
    }

    // ---- fur: stands on end when scared, trails behind when running
    this.fur.uniforms.uPuff.value = look.puff;
    this.root.getWorldPosition(this.q0);
    if (dt > 0) {
      const vx = (this.q0.x - this.lastPos.x) / dt;
      const vz = (this.q0.z - this.lastPos.z) / dt;
      this.lag.set(clamp(-vx * 0.045, -0.5, 0.5), -0.28, clamp(-vz * 0.045, -0.5, 0.5));
    }
    this.lastPos.copy(this.q0);
    this.blink = (this.blink + dt) % 4.3;
  }

  private readonly q0 = new THREE.Vector3();
}
