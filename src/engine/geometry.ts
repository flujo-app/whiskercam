import * as THREE from 'three';

/**
 * The packed world files store positions and directions as small whole numbers to keep the download
 * small. Browsers on Windows draw through Direct3D, which has no three-part whole-number format, so
 * they convert every such vertex again on every draw: about ten times slower than it should be.
 * Turning them into ordinary numbers once, while loading, avoids that. Other systems draw the small
 * numbers directly and keep them (less memory, which matters on phones).
 */
export const NEEDS_PLAIN_NUMBERS = (() => {
  if (typeof navigator === 'undefined') return false;
  const forced = new URLSearchParams(location.search).get('floats');
  if (forced !== null) return forced !== '0';
  return /Windows/i.test(navigator.userAgent);
})();

const done = new WeakSet<THREE.BufferGeometry>();

export function plainNumbers(root: THREE.Object3D): void {
  if (!NEEDS_PLAIN_NUMBERS) return;
  root.traverse((obj) => {
    const geo = (obj as THREE.Mesh).geometry as THREE.BufferGeometry | undefined;
    if (!geo || done.has(geo)) return;
    done.add(geo);
    for (const name of Object.keys(geo.attributes)) {
      const a = geo.attributes[name] as THREE.BufferAttribute | THREE.InterleavedBufferAttribute;
      const interleaved = (a as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute === true;
      const floats = a.array instanceof Float32Array;
      // two- and four-part whole numbers kept apart (picture coordinates, baked colours) are drawn directly
      if ((floats && !interleaved) || name === 'skinIndex' || (!interleaved && a.itemSize !== 3)) continue;
      const n = a.count;
      const s = a.itemSize;
      const out = new Float32Array(n * s);
      for (let i = 0; i < n; i++) for (let c = 0; c < s; c++) out[i * s + c] = a.getComponent(i, c);
      geo.setAttribute(name, new THREE.BufferAttribute(out, s));
    }
  });
}
