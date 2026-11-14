/* eslint-disable */
// @ts-nocheck
// The landing page globe (three.js WebGPU with a WebGL2 fallback): a dot-matrix earth, an orbit of the ten coin and
// chain icons, and payment arcs that settle. Supplied as a finished component; kept as it was written.
const DEFAULT_ICONS = [
  "arbitrum.svg",
  "base.svg",
  "bsc.svg",
  "ethereum.svg",
  "near.svg",
  "optimism.svg",
  "polygon.svg",
  "solana.svg",
  "usdc.svg",
  "usdt.svg",
];

// Rasterize an SVG URL onto a square offscreen canvas so SVGs without explicit width/height render crisply.
function loadSvgTexture(THREE, url, size = 128) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      const c = document.createElement("canvas");
      c.width = size;
      c.height = size;
      const ctx = c.getContext("2d");
      ctx.drawImage(img, 0, 0, size, size);
      const tex = new THREE.CanvasTexture(c);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.needsUpdate = true;
      resolve(tex);
    };
    img.onerror = reject;
    img.src = url;
  });
}

// Small deterministic 3D value noise, used once on the CPU to shape the continents.
function makeNoise(seed) {
  const h = (x, y, z) => {
    const n = Math.sin(x * 127.1 + y * 311.7 + z * 74.7 + seed * 13.3) * 43758.5453;
    return n - Math.floor(n);
  };
  const s = (t) => t * t * (3 - 2 * t);
  const lerp = (a, b, t) => a + (b - a) * t;
  const v = (x, y, z) => {
    const xi = Math.floor(x),
      yi = Math.floor(y),
      zi = Math.floor(z),
      xf = s(x - xi),
      yf = s(y - yi),
      zf = s(z - zi);
    const c = (dx, dy, dz) => h(xi + dx, yi + dy, zi + dz);
    return lerp(
      lerp(lerp(c(0, 0, 0), c(1, 0, 0), xf), lerp(c(0, 1, 0), c(1, 1, 0), xf), yf),
      lerp(lerp(c(0, 0, 1), c(1, 0, 1), xf), lerp(c(0, 1, 1), c(1, 1, 1), xf), yf),
      zf,
    );
  };
  return (x, y, z) =>
    v(x, y, z) * 0.6 + v(x * 2.1, y * 2.1, z * 2.1) * 0.3 + v(x * 4.3, y * 4.3, z * 4.3) * 0.1;
}

export async function mount(canvas, opts = {}) {
  // The module is passed in (`three/webgpu`, bundled with the page); a URL in `opts.lib` still works.
  const THREE = opts.THREE ?? (await import(/* webpackIgnore: true */ opts.lib));
  const {
    Fn,
    uniform,
    time,
    instanceIndex,
    hash,
    mix,
    float,
    sin,
    smoothstep,
    positionWorld,
    abs,
  } = THREE.TSL;
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const small = canvas.clientWidth < 520;

  const renderer = new THREE.WebGPURenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  await renderer.init();

  const iconBase = opts.iconBase ?? "./icons/";
  const iconUrls = (opts.icons ?? DEFAULT_ICONS).map((name) =>
    name.includes("/") ? name : iconBase + name,
  );
  const iconTextures = await Promise.all(iconUrls.map((url) => loadSvgTexture(THREE, url, 128)));
  const iconMats = iconTextures.map(
    (tex) => new THREE.SpriteNodeMaterial({ map: tex, transparent: true, depthWrite: false }),
  );

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 50);
  camera.position.set(0, 0, 6.2);
  const world = new THREE.Group();
  world.rotation.set(0.42, -0.4, 0.08);
  scene.add(world);

  const palette = Object.assign(
    { ink: "#EDEBE6", dim: "#2F2F35", accent: "#3f46fe", mint: "#3f46fe", bg: "#0A0A0B" },
    opts.colors ? opts.colors() : {},
  );
  const theme = {
    ink: uniform(new THREE.Color(palette.ink)),
    dim: uniform(new THREE.Color(palette.dim)),
    accent: uniform(new THREE.Color(palette.accent)),
    mint: uniform(new THREE.Color(palette.mint)),
    bg: uniform(new THREE.Color(palette.bg)),
  };

  // Dot-matrix sphere on a Fibonacci lattice: land dots bright, ocean dots faint.
  const noise = makeNoise(11);
  // Seeded so the ocean pattern is the same on every load; a regular stride would draw spirals.
  let seed = 7;
  const rand = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  const N = small ? 8000 : 15000;
  const golden = Math.PI * (3 - Math.sqrt(5));
  const land = [],
    sea = [];
  for (let i = 0; i < N; i++) {
    const y = 1 - (i / (N - 1)) * 2,
      r = Math.sqrt(1 - y * y),
      th = golden * i;
    const p = new THREE.Vector3(Math.cos(th) * r, y, Math.sin(th) * r);
    if (noise(p.x * 1.9 + 3, p.y * 1.9 + 1, p.z * 1.9 + 5) > 0.5) land.push(p);
    else if (rand() < 0.22) sea.push(p);
  }
  const dummy = new THREE.Object3D();
  const dotLayer = (points, radius, colorNode) => {
    const mat = new THREE.MeshBasicNodeMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    mat.colorNode = colorNode;
    const mesh = new THREE.InstancedMesh(new THREE.CircleGeometry(radius, 8), mat, points.length);
    points.forEach((p, i) => {
      dummy.position.copy(p).multiplyScalar(1.002);
      dummy.lookAt(p.clone().multiplyScalar(2));
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    });
    return mesh;
  };
  // A scan band sweeps the latitudes in #3f46fe; a few dots blink "settled" in #3f46fe.
  const landColor = Fn(() => {
    const band = smoothstep(
      float(0.07),
      float(0.0),
      abs(positionWorld.y.sub(sin(time.mul(0.4)).mul(1.05))),
    );
    const blink = smoothstep(
      float(0.985),
      float(1.0),
      sin(time.mul(1.2).add(hash(instanceIndex).mul(50)))
        .mul(0.5)
        .add(0.5),
    );
    return mix(mix(theme.ink, theme.accent, band), theme.mint, blink);
  });
  world.add(dotLayer(land, small ? 0.012 : 0.0098, landColor()));
  world.add(dotLayer(sea, 0.0055, theme.dim));

  // Solid core hides the far side of the lattice.
  const coreMat = new THREE.MeshBasicNodeMaterial();
  coreMat.colorNode = theme.bg;
  const core = new THREE.Mesh(new THREE.SphereGeometry(0.985, 64, 48), coreMat);
  world.add(core);

  // Orbit ring with the 10 flat icon satellites.
  const orbit = new THREE.Group();
  orbit.rotation.set(1.2, 0.18, -0.38);
  scene.add(orbit);
  const R = 1.58;
  const ringMat = new THREE.LineBasicNodeMaterial({ transparent: true, opacity: 0.7 });
  ringMat.colorNode = theme.dim;
  orbit.add(
    new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(
        Array.from({ length: 257 }, (_, i) => {
          const a = (i / 256) * Math.PI * 2;
          return new THREE.Vector3(Math.cos(a) * R, Math.sin(a) * R, 0);
        }),
      ),
      ringMat,
    ),
  );
  const sats = iconMats.map((mat, i) => {
    const s = new THREE.Sprite(mat);
    s.scale.set(0.11, 0.11, 1);
    s.userData.a = (i / iconMats.length) * Math.PI * 2;
    orbit.add(s);
    return s;
  });

  // Payment arcs: the line draws on, a random flat icon packet rides it, a #3f46fe ring marks settlement.
  const arcs = [];
  const SEG = 64;
  function spawnArc(from, to) {
    from = from || land[(Math.random() * land.length) | 0];
    to = to || land[(Math.random() * land.length) | 0];
    if (!from || !to || from.distanceTo(to) < 0.5) return false;
    const lift = 1 + from.distanceTo(to) * 0.6;
    const curve = new THREE.QuadraticBezierCurve3(
      from.clone(),
      from.clone().add(to).normalize().multiplyScalar(lift),
      to.clone(),
    );
    const geo = new THREE.BufferGeometry().setFromPoints(curve.getPoints(SEG));
    geo.setDrawRange(0, 2);
    const lineMat = new THREE.LineBasicNodeMaterial({ transparent: true, opacity: 0.95 });
    lineMat.colorNode = theme.accent;
    const line = new THREE.Line(geo, lineMat);
    const packetMat = iconMats[(Math.random() * iconMats.length) | 0];
    const packet = new THREE.Sprite(packetMat);
    packet.scale.set(0.085, 0.085, 1);
    const ringMat = new THREE.MeshBasicNodeMaterial({
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    ringMat.colorNode = theme.mint;
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.02, 0.03, 32), ringMat);
    ring.position.copy(to).multiplyScalar(1.004);
    ring.lookAt(to.clone().multiplyScalar(2));
    ring.visible = false;
    world.add(line, packet, ring);
    arcs.push({ line, packet, ring, curve, t: 0, speed: 0.35 + Math.random() * 0.25 });
    if (arcs.length > 28) dispose(arcs.shift());
    return true;
  }
  function dispose(a) {
    world.remove(a.line, a.packet, a.ring);
    a.line.geometry.dispose();
    a.line.material.dispose();
    a.ring.geometry.dispose();
    a.ring.material.dispose();
  }

  // Drag to spin with inertia; a tap on the globe sends a request from that point.
  let dragging = false,
    lastX = 0,
    lastY = 0,
    velX = 0.0016,
    velY = 0,
    moved = 0;
  const tilt = { x: 0, y: 0 };
  canvas.addEventListener("pointerdown", (e) => {
    dragging = true;
    moved = 0;
    lastX = e.clientX;
    lastY = e.clientY;
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener("pointermove", (e) => {
    const r = canvas.getBoundingClientRect();
    tilt.x = (e.clientX - r.left) / r.width - 0.5;
    tilt.y = (e.clientY - r.top) / r.height - 0.5;
    if (!dragging) return;
    const dx = e.clientX - lastX,
      dy = e.clientY - lastY;
    moved += Math.abs(dx) + Math.abs(dy);
    velX = dx * 0.0045;
    velY = dy * 0.0045;
    lastX = e.clientX;
    lastY = e.clientY;
  });
  canvas.addEventListener("pointerleave", () => {
    tilt.x = 0;
    tilt.y = 0;
  });
  const raycaster = new THREE.Raycaster(),
    ndc = new THREE.Vector2();
  canvas.addEventListener("pointerup", (e) => {
    dragging = false;
    if (moved > 6) return;
    const r = canvas.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    const hit = raycaster.intersectObject(core)[0];
    if (!hit) return;
    spawnArc(
      world.worldToLocal(hit.point.clone()).normalize(),
      land[(Math.random() * land.length) | 0],
    );
    if (opts.onRequest) opts.onRequest({ x: e.clientX - r.left, y: e.clientY - r.top });
  });

  const resize = () => {
    const r = canvas.getBoundingClientRect();
    renderer.setSize(Math.max(1, r.width), Math.max(1, r.height), false);
    camera.aspect = r.width / Math.max(1, r.height);
    camera.position.z = camera.aspect < 0.9 ? 7.4 : 6.2;
    camera.updateProjectionMatrix();
  };
  resize();
  new ResizeObserver(resize).observe(canvas);

  let visible = true,
    last = performance.now(),
    spawnIn = 0;
  for (let i = 0; i < 12; i++) spawnArc();
  renderer.setAnimationLoop((now) => {
    if (!visible) return;
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (!dragging) {
      velX += ((reduce ? 0 : 0.0016) - velX) * 0.02;
      velY *= 0.94;
    }
    world.rotation.y += velX;
    world.rotation.x = Math.max(-0.6, Math.min(1.0, world.rotation.x + velY * 0.6));
    scene.rotation.x += (tilt.y * 0.12 - scene.rotation.x) * 0.04;
    scene.rotation.y += (tilt.x * 0.18 - scene.rotation.y) * 0.04;
    sats.forEach((s, i) => {
      if (!reduce) s.userData.a += dt * (0.22 + i * 0.03);
      s.position.set(Math.cos(s.userData.a) * R, Math.sin(s.userData.a) * R, 0);
    });
    spawnIn -= dt;
    if (spawnIn <= 0 && !reduce && spawnArc()) spawnIn = 0.22 + Math.random() * 0.35;
    for (const a of arcs) {
      a.t += dt * a.speed;
      const grow = Math.min(1, a.t);
      a.line.geometry.setDrawRange(0, Math.max(2, Math.floor(grow * SEG) + 1));
      a.packet.position.copy(a.curve.getPoint(grow));
      a.packet.visible = a.t < 1;
      if (a.t >= 1) {
        const k = a.t - 1;
        a.ring.visible = k < 1;
        a.ring.scale.setScalar(1 + k * 4);
        a.ring.material.opacity = Math.max(0, 1 - k);
        a.line.material.opacity = Math.max(0, 0.95 - k * 0.6);
      }
    }
    renderer.render(scene, camera);
  });
  new IntersectionObserver(([e]) => {
    visible = e.isIntersecting;
    last = performance.now();
  }).observe(canvas);

  return {
    dispose() {
      renderer.setAnimationLoop(null);
      renderer.dispose();
    },
    backend: renderer.backend && renderer.backend.isWebGPUBackend ? "WebGPU" : "WebGL2",
    setColors(c) {
      theme.ink.value.set(c.ink);
      theme.dim.value.set(c.dim);
      theme.accent.value.set(c.accent);
      theme.mint.value.set(c.mint);
      theme.bg.value.set(c.bg);
    },
  };
}
