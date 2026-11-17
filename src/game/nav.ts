/** The paths the other cats use: a small graph laid over the estate (see pipeline/blender/sets/plan.py). */
export interface NavInfo {
  nodes: [number, number][];
  edges: [number, number][];
  ring: number[];
  home: number;
}

export class Nav {
  readonly nodes: [number, number][];
  readonly next: number[][];

  constructor(readonly info: NavInfo) {
    this.nodes = info.nodes;
    this.next = info.nodes.map(() => []);
    for (const [a, b] of info.edges) {
      if (!this.next[a].includes(b)) this.next[a].push(b);
      if (!this.next[b].includes(a)) this.next[b].push(a);
    }
  }

  dist(a: number, b: number): number {
    return Math.hypot(this.nodes[a][0] - this.nodes[b][0], this.nodes[a][1] - this.nodes[b][1]);
  }

  nearest(x: number, z: number): number {
    let best = 0;
    let bd = Infinity;
    for (let i = 0; i < this.nodes.length; i++) {
      const d = (this.nodes[i][0] - x) ** 2 + (this.nodes[i][1] - z) ** 2;
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    return best;
  }

  /** Shortest path from a to b (node indices, including both ends). */
  path(a: number, b: number): number[] {
    const n = this.nodes.length;
    const cost = new Float32Array(n).fill(Infinity);
    const prev = new Int32Array(n).fill(-1);
    const done = new Uint8Array(n);
    cost[a] = 0;
    for (let iter = 0; iter < n; iter++) {
      let u = -1;
      let best = Infinity;
      for (let i = 0; i < n; i++) {
        if (!done[i] && cost[i] < best) {
          best = cost[i];
          u = i;
        }
      }
      if (u < 0 || u === b) break;
      done[u] = 1;
      for (const v of this.next[u]) {
        const c = cost[u] + this.dist(u, v);
        if (c < cost[v]) {
          cost[v] = c;
          prev[v] = u;
        }
      }
    }
    const out: number[] = [];
    for (let v = b; v !== -1; v = prev[v]) out.push(v);
    out.reverse();
    return out[0] === a ? out : [a];
  }

  /**
   * A wandering route of about `length` metres starting at `from`: keeps going forward,
   * avoids doubling back, and prefers nodes far from `avoid` (the player) so a chase stays a chase.
   */
  wander(from: number, length: number, rand: () => number, avoid?: [number, number], cameFrom = -1): number[] {
    const out = [from];
    let cur = from;
    let last = cameFrom;
    let total = 0;
    let guard = 0;
    while (total < length && guard++ < 200) {
      const options = this.next[cur].filter((v) => v !== last);
      const pool = options.length ? options : this.next[cur];
      if (!pool.length) break;
      let pick = pool[0];
      let bestScore = -Infinity;
      for (const v of pool) {
        let score = rand() * 6;
        if (avoid) score += Math.hypot(this.nodes[v][0] - avoid[0], this.nodes[v][1] - avoid[1]) * 0.5;
        if (out.includes(v)) score -= 12;
        if (score > bestScore) {
          bestScore = score;
          pick = v;
        }
      }
      total += this.dist(cur, pick);
      last = cur;
      cur = pick;
      out.push(cur);
    }
    return out;
  }
}
