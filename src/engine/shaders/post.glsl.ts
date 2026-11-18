// The "camera" part of the picture: everything a small action camera does to a scene.
//
//   lens     two flat renders (one tilted up, one tilted down) -> one fisheye picture + how far each pixel moved
//   blur     smear along the movement (shutter open while the cat runs)
//   bloom    glow around very bright things
//   meter    automatic exposure, like a phone: slow to settle, blown out when leaving shade
//   finish   exposure, tone curve, colour punch, sharpening halo, grain, dark corners

export const fullscreenVertex = /* glsl */ `
precision highp float;
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

export const lensFragment = /* glsl */ `
precision highp float;
layout(location = 0) out highp vec4 outColor;
layout(location = 1) out highp vec4 outVelocity;

uniform sampler2D uColUp;
uniform sampler2D uColDown;
uniform sampler2D uDepthUp;
uniform sampler2D uDepthDown;
uniform vec2 uTan;            // half-size of each view at distance 1 (x, y)
uniform float uPitch;         // how far the two views are tilted up / down (radians)
uniform vec2 uFrame;          // half picture size in "diagonal = 1" units
uniform float uSinHalfMax;    // sin(half of the corner-to-corner field of view / 2)
uniform vec2 uNearFar;
uniform mat4 uRigWorld;       // camera rig -> world
uniform mat4 uPrevRigInv;     // world -> where the rig was one shutter time ago
uniform float uVelScale;
uniform vec3 uFringe;         // colour fringing: radial scale per channel
uniform vec2 uJitter;         // this frame's tiny shift of the two views (see taaFragment), in view uv

varying vec2 vUv;

vec3 lensDir(vec2 p) {
  float r = length(p);
  float s = clamp(r * uSinHalfMax, 0.0, 0.9995);
  float theta = 2.0 * asin(s);
  vec2 d = r > 1e-6 ? p / r : vec2(0.0);
  return vec3(d * sin(theta), -cos(theta));
}

vec2 lensProject(vec3 dir) {
  float theta = acos(clamp(-dir.z, -1.0, 1.0));
  float r = sin(theta * 0.5) / uSinHalfMax;
  float l = length(dir.xy);
  return l > 1e-6 ? dir.xy / l * r : vec2(0.0);
}

// rig direction -> uv in the up or down view (and which one)
vec2 viewUv(vec3 dir, out float up) {
  up = step(0.0, dir.y);
  float a = up > 0.5 ? uPitch : -uPitch;
  float c = cos(a), s = sin(a);
  vec3 local = vec3(dir.x, c * dir.y + s * dir.z, -s * dir.y + c * dir.z);
  vec2 ndc = local.xy / max(-local.z, 1e-4) / uTan;
  return ndc * 0.5 + 0.5 + uJitter;
}

vec3 sampleScene(vec3 dir) {
  float up;
  vec2 uv = viewUv(dir, up);
  return up > 0.5 ? texture(uColUp, uv).rgb : texture(uColDown, uv).rgb;
}

void main() {
  vec2 p = (vUv * 2.0 - 1.0) * uFrame;
  vec3 dir = lensDir(p);

  // colour, with a little fringing towards the corners
  vec3 col;
  col.g = sampleScene(dir).g;
  col.r = sampleScene(lensDir(p * uFringe.r)).r;
  col.b = sampleScene(lensDir(p * uFringe.b)).b;

  // where was this point one shutter time ago?
  float up;
  vec2 uv = viewUv(dir, up);
  float depth = up > 0.5 ? texture(uDepthUp, uv).r : texture(uDepthDown, uv).r;
  vec3 prevDir;
  if (depth > 0.99999) {
    prevDir = mat3(uPrevRigInv) * (mat3(uRigWorld) * dir);
  } else {
    float zn = depth * 2.0 - 1.0;
    float viewZ = 2.0 * uNearFar.x * uNearFar.y / ((uNearFar.y + uNearFar.x) - zn * (uNearFar.y - uNearFar.x));
    float a = up > 0.5 ? uPitch : -uPitch;
    float c = cos(a), s = sin(a);
    vec3 local = vec3(dir.x, c * dir.y + s * dir.z, -s * dir.y + c * dir.z);
    vec3 rigPos = dir * (viewZ / max(-local.z, 1e-4));
    vec4 world = uRigWorld * vec4(rigPos, 1.0);
    prevDir = (uPrevRigInv * world).xyz;
  }
  prevDir = normalize(prevDir);
  vec2 prevUv = lensProject(prevDir) / uFrame * 0.5 + 0.5;
  vec2 vel = (vUv - prevUv) * uVelScale;
  if (prevDir.z > -0.05) vel = vec2(0.0);   // came from behind the lens: no sensible streak
  // the cat's own chin, whiskers and paws ride with the camera: they have not moved in the picture
  float own = 1.0 - step(0.5, up > 0.5 ? texture(uColUp, uv).a : texture(uColDown, uv).a);
  vel *= 1.0 - own;

  outColor = vec4(col, 1.0);
  outVelocity = vec4(vel, depth, own);
}
`;

// Edge smoothing over time. Every frame the two views are drawn shifted by a different fraction of a pixel;
// averaging the last frames (each one put back where it was, using how far every pixel moved) adds up to
// many samples per pixel. That is what removes the crawling on thin things such as railings and gate bars,
// which no single frame can draw properly because they are thinner than a pixel.
export const taaFragment = /* glsl */ `
precision highp float;
uniform sampler2D uCurrent;
uniform sampler2D uHistory;
uniform sampler2D uVelocity;  // xy = how far the pixel moved (scaled, see uInvVelScale)
uniform vec2 uTexel;
uniform float uInvVelScale;
uniform float uKeep;          // how much of the past to keep (0 = start afresh)
varying vec2 vUv;

// bright spots must not dominate the average
vec3 squash(vec3 c) { return c / (1.0 + max(c.r, max(c.g, c.b))); }
vec3 unsquash(vec3 c) { return c / max(1.0 - max(c.r, max(c.g, c.b)), 1e-4); }

void main() {
  vec3 cur = squash(texture2D(uCurrent, vUv).rgb);
  // what the neighbours look like now: the past is only believed as far as it fits in with them
  vec3 lo = cur;
  vec3 hi = cur;
  vec3 sum = cur;
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      if (i == 0 && j == 0) continue;
      vec3 n = squash(texture2D(uCurrent, vUv + vec2(float(i), float(j)) * uTexel).rgb);
      lo = min(lo, n);
      hi = max(hi, n);
      sum += n;
    }
  }
  // a slightly rounded box: mix the full neighbourhood with its plus-shaped part
  vec3 mean = sum / 9.0;
  lo = mix(lo, mean, 0.12);
  hi = mix(hi, mean, 0.12);

  vec4 moved = texture2D(uVelocity, vUv);
  vec2 vel = moved.xy * uInvVelScale;
  vec2 was = vUv - vel;
  // the cat's own paws move on their own; keep less of the past there so they leave no trail
  float keep = uKeep * (1.0 - 0.45 * moved.w);
  if (was.x < 0.0 || was.x > 1.0 || was.y < 0.0 || was.y > 1.0) keep = 0.0;
  // fast movement: lean on the new frame (the motion streaks smooth it anyway)
  keep *= 1.0 - 0.6 * smoothstep(0.004, 0.05, length(vel));
  vec3 past = clamp(squash(texture2D(uHistory, was).rgb), lo, hi);
  gl_FragColor = vec4(unsquash(mix(cur, past, keep)), 1.0);
}
`;

export const blurFragment = /* glsl */ `
precision highp float;
uniform sampler2D uColor;
uniform sampler2D uVelocity;  // xy = how far the pixel moved, z = depth
uniform float uMaxBlur;       // longest streak, as a fraction of the picture
uniform float uSeed;
uniform vec2 uNearFar;
uniform float uFocusNear;     // closer than this (metres) the fixed-focus lens goes soft
uniform float uNearBlur;      // blur radius right at the lens, as a fraction of the picture width
uniform vec2 uAspect;         // (1, width / height)
varying vec2 vUv;

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float nearness(vec2 uv) {
  float d = textureLod(uVelocity, uv, 0.0).z;
  float zn = d * 2.0 - 1.0;
  float z = 2.0 * uNearFar.x * uNearFar.y / ((uNearFar.y + uNearFar.x) - zn * (uNearFar.y - uNearFar.x));
  return clamp(1.0 - z / uFocusNear, 0.0, 1.0);
}

void main() {
  vec3 vd = textureLod(uVelocity, vUv, 0.0).xyz;
  vec2 vel = vd.xy;
  float len = length(vel);
  if (len > uMaxBlur) vel *= uMaxBlur / len;
  float j = hash12(gl_FragCoord.xy + uSeed);

  // things right in front of the lens (the chin, whiskers, leaves brushing past) are out of focus;
  // look around a little so their soft edges also spread over what is behind them
  float near = nearness(vUv);
  float ang0 = j * 6.2831;
  for (int i = 0; i < 4; i++) {
    float a = ang0 + float(i) * 1.5708;
    near = max(near, 0.8 * nearness(vUv + vec2(cos(a), sin(a)) * uAspect * uNearBlur * 0.6));
  }
  float radius = uNearBlur * near * near;

  if (len < 0.0006 && radius < 0.0008) {
    gl_FragColor = vec4(textureLod(uColor, vUv, 0.0).rgb, 1.0);
    return;
  }
  const int N = 14;
  vec3 acc = vec3(0.0);
  for (int i = 0; i < N; i++) {
    float f = (float(i) + 0.5) / float(N);
    float t = f + (j - 0.5) / float(N) - 0.5;
    // golden-angle spiral for the out-of-focus disc, a straight line for the motion streak
    float a = float(i) * 2.39996 + ang0;
    vec2 disc = vec2(cos(a), sin(a)) * sqrt(f) * radius * uAspect;
    acc += textureLod(uColor, vUv - vel * t + disc, 0.0).rgb;
  }
  gl_FragColor = vec4(acc / float(N), 1.0);
}
`;

export const downFragment = /* glsl */ `
precision highp float;
uniform sampler2D uTex;
uniform vec2 uTexel;
uniform float uThreshold;     // > 0 on the first step: keep only what is brighter than this (after exposure)
uniform sampler2D uMeter;
uniform float uKey;
varying vec2 vUv;
void main() {
  vec3 a = texture2D(uTex, vUv + uTexel * vec2(-1.0, -1.0)).rgb;
  vec3 b = texture2D(uTex, vUv + uTexel * vec2(1.0, -1.0)).rgb;
  vec3 c = texture2D(uTex, vUv + uTexel * vec2(-1.0, 1.0)).rgb;
  vec3 d = texture2D(uTex, vUv + uTexel * vec2(1.0, 1.0)).rgb;
  vec3 e = texture2D(uTex, vUv).rgb;
  vec3 col = (a + b + c + d) * 0.125 + e * 0.5;
  if (uThreshold > 0.0) {
    col *= clamp(uKey / max(texture2D(uMeter, vec2(0.5)).r, 1e-4), 0.02, 40.0);
    float l = max(col.r, max(col.g, col.b));
    col *= clamp((l - uThreshold) / max(l, 1e-4), 0.0, 1.0);
    col = min(col, vec3(40.0));
  }
  gl_FragColor = vec4(col, 1.0);
}
`;

export const upFragment = /* glsl */ `
precision highp float;
uniform sampler2D uTex;      // smaller level
uniform sampler2D uBase;     // this level
uniform vec2 uTexel;
uniform float uMix;
varying vec2 vUv;
void main() {
  vec3 s = vec3(0.0);
  s += texture2D(uTex, vUv + uTexel * vec2(-1.0, -1.0)).rgb;
  s += texture2D(uTex, vUv + uTexel * vec2(1.0, -1.0)).rgb;
  s += texture2D(uTex, vUv + uTexel * vec2(-1.0, 1.0)).rgb;
  s += texture2D(uTex, vUv + uTexel * vec2(1.0, 1.0)).rgb;
  s += 2.0 * texture2D(uTex, vUv + uTexel * vec2(0.0, -1.0)).rgb;
  s += 2.0 * texture2D(uTex, vUv + uTexel * vec2(0.0, 1.0)).rgb;
  s += 2.0 * texture2D(uTex, vUv + uTexel * vec2(-1.0, 0.0)).rgb;
  s += 2.0 * texture2D(uTex, vUv + uTexel * vec2(1.0, 0.0)).rgb;
  s += 4.0 * texture2D(uTex, vUv).rgb;
  gl_FragColor = vec4(mix(texture2D(uBase, vUv).rgb, s / 16.0, uMix), 1.0);
}
`;

export const meterFragment = /* glsl */ `
precision highp float;
uniform sampler2D uTex;       // small, already averaged picture of the scene
uniform sampler2D uPrev;      // last frame's reading
uniform float uBlendBrighter; // how fast to follow when the scene gets brighter (0 = never, 1 = at once)
uniform float uBlendDarker;
uniform float uDarkest;       // the dimmest average the exposure will still follow
varying vec2 vUv;
void main() {
  // first pass: the plain average, to know what counts as "deep shadow" in this picture
  float mean = 0.0, wsum = 0.0;
  for (int y = 0; y < 8; y++) {
    for (int x = 0; x < 6; x++) {
      vec2 uv = (vec2(float(x), float(y)) + 0.5) / vec2(6.0, 8.0);
      float l = dot(textureLod(uTex, uv, 5.0).rgb, vec3(0.2126, 0.7152, 0.0722));
      // phones weigh the middle and the lower part (the subject) more than the sky
      float w = 1.0 - 0.55 * smoothstep(0.55, 1.0, uv.y);
      w *= 1.0 - 0.3 * abs(uv.x - 0.5) * 2.0;
      mean += l * w;
      wsum += w;
    }
  }
  mean /= wsum;
  // second pass: the usual "middle grey" reading, except that deep shadows are not allowed to drag
  // the exposure up until everything in the sun burns out (phones protect the highlights)
  float sum = 0.0;
  for (int y = 0; y < 8; y++) {
    for (int x = 0; x < 6; x++) {
      vec2 uv = (vec2(float(x), float(y)) + 0.5) / vec2(6.0, 8.0);
      float l = dot(textureLod(uTex, uv, 5.0).rgb, vec3(0.2126, 0.7152, 0.0722));
      float w = 1.0 - 0.55 * smoothstep(0.55, 1.0, uv.y);
      w *= 1.0 - 0.3 * abs(uv.x - 0.5) * 2.0;
      sum += log(max(l, max(mean * 0.07, 1e-4))) * w;
    }
  }
  // a small camera can only open up so far: a really dark place (inside a hedge, under a car) stays dim
  // instead of everything outside it burning out to white
  float now = max(exp(sum / wsum), uDarkest);
  float prev = texture2D(uPrev, vec2(0.5)).r;
  float v = prev <= 0.0 ? now : mix(prev, now, now > prev ? uBlendBrighter : uBlendDarker);
  gl_FragColor = vec4(v, v, v, 1.0);
}
`;

export const finishFragment = /* glsl */ `
precision highp float;
uniform sampler2D uColor;
uniform sampler2D uBloom;
uniform sampler2D uMeter;
uniform vec2 uTexel;
uniform float uKey;           // how bright the picture should end up on average
uniform float uExposureBias;
uniform float uBloomAmount;
uniform float uTime;
uniform float uGrain;
uniform float uSharpen;
uniform float uVignette;
uniform float uSaturation;
uniform float uContrast;
uniform vec3 uWhiteBalance;
uniform vec2 uFrame;
uniform sampler2D uDepth;     // lens output: z = depth (to see whether the sun is hidden)
uniform vec2 uSunUv;          // where the sun is in the picture
uniform float uSunOn;         // 0 when the sun is behind the camera
uniform float uFlare;
varying vec2 vUv;

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

// The camera's tone curve.
// Contrast is put on the light itself, around middle grey, so shade gets deeper without ever being cut
// off to black: a phone camera keeps detail in the shade, and a shadow on sunlit ground is a darker
// version of that ground, not a hole. Bright things roll off to white over a long shoulder.
vec3 curve(vec3 x) {
  vec3 t = 0.2484 * pow(max(x, 0.0) / 0.18, vec3(uContrast));
  vec3 u = max(t - 0.25, 0.0) / 0.75;
  vec3 high = 0.25 + 0.75 * u * (1.0 + u / 36.0) / (1.0 + u);
  return clamp(mix(t, high, step(0.25, t)), 0.0, 1.0);
}

void main() {
  vec3 hdr = texture2D(uColor, vUv).rgb;

  // unsharp mask: the slight bright/dark outline phone cameras put on edges
  vec3 around = texture2D(uColor, vUv + uTexel * vec2(1.2, 0.0)).rgb + texture2D(uColor, vUv - uTexel * vec2(1.2, 0.0)).rgb
              + texture2D(uColor, vUv + uTexel * vec2(0.0, 1.2)).rgb + texture2D(uColor, vUv - uTexel * vec2(0.0, 1.2)).rgb;
  hdr = max(hdr + (hdr - around * 0.25) * uSharpen, 0.0);

  float metered = max(texture2D(uMeter, vec2(0.5)).r, 1e-4);
  float exposure = clamp(uKey / metered, 0.02, 40.0) * uExposureBias;
  vec3 c = (hdr * exposure + texture2D(uBloom, vUv).rgb * uBloomAmount) * uWhiteBalance;

  // sun in the picture: a small cheap lens answers with a star, a veil and a couple of ghosts
  if (uSunOn > 0.0 && uFlare > 0.0) {
    float seen = 0.0;
    for (int i = 0; i < 5; i++) {
      vec2 o = vec2(float(i % 3) - 1.0, float(i / 3) - 0.5) * 0.004;
      seen += step(0.99999, texture2D(uDepth, uSunUv + o).z);
    }
    seen = seen * 0.2 * uSunOn;
    if (seen > 0.0) {
      vec2 aspect = vec2(uFrame.x / uFrame.y, 1.0);
      vec2 d = (vUv - uSunUv) * aspect;
      float r = length(d);
      float ang = atan(d.y, d.x);
      float star = pow(abs(cos(ang * 3.0 + 0.4)), 40.0) * 0.012 / (r + 0.012) + pow(abs(cos(ang * 3.0 + 1.3)), 90.0) * 0.006 / (r + 0.02);
      float veil = 0.05 / (1.0 + pow(r / 0.3, 2.0));
      vec2 axis = vec2(0.5) - uSunUv;
      vec2 g1 = (vUv - (vec2(0.5) + axis * 0.45)) * aspect;
      vec2 g2 = (vUv - (vec2(0.5) + axis * 0.95)) * aspect;
      vec3 ghosts = vec3(0.35, 0.9, 0.5) * smoothstep(0.045, 0.035, length(g1)) * 0.02 + vec3(0.9, 0.5, 0.3) * smoothstep(0.085, 0.07, length(g2)) * 0.012;
      c += (vec3(1.0, 0.95, 0.85) * (star + veil) + ghosts) * seen * uFlare;
    }
  }

  // dark corners
  vec2 p = (vUv * 2.0 - 1.0) * uFrame;
  float r2 = dot(p, p);
  c *= 1.0 - uVignette * smoothstep(0.25, 1.15, r2);

  c = curve(c);
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = clamp(mix(vec3(l), c, uSaturation), 0.0, 1.0);
  c = pow(c, vec3(1.0 / 2.2));

  // sensor noise: a little more in the dark parts, different every frame (added to the finished picture,
  // so it stays fine grain in the shade instead of turning into speckles)
  float n = hash12(gl_FragCoord.xy + fract(uTime) * 311.7) - 0.5;
  c += n * uGrain * (1.15 - 0.6 * sqrt(l));

  gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}
`;

export const skyVertex = /* glsl */ `
precision highp float;
varying vec3 vDir;
void main() {
  vDir = position;
  vec4 p = projectionMatrix * vec4(mat3(viewMatrix) * position, 1.0);
  gl_Position = p.xyww;
}
`;

export const skyFragment = /* glsl */ `
precision highp float;
uniform sampler2D uSky;
uniform float uSkyRange;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uSunDisc;   // 0 in the pictures that reflections are looked up in: surfaces add the sun's glint themselves
varying vec3 vDir;
void main() {
  vec3 d = normalize(vDir);
  vec2 uv = vec2(atan(d.z, d.x) / 6.283185307179586 + 0.5, 0.5 - asin(clamp(d.y, -1.0, 1.0)) / 3.141592653589793);
  vec3 t = texture2D(uSky, uv).rgb;
  vec3 col = t * t * uSkyRange;
  float c = dot(d, uSunDir);
  // the sun itself (kept far below its true brightness so the glow stays controllable) and its halo
  col += uSunColor * ((smoothstep(0.99995, 0.99999, c) * 900.0 + pow(max(c, 0.0), 900.0) * 6.0) * uSunDisc + pow(max(c, 0.0), 60.0) * 0.25);
  gl_FragColor = vec4(col, 1.0);
}
`;
