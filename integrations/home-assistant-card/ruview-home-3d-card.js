// RuView Home 3D card for Home Assistant.
//
// Builds a 3D model of the flat from the Dreame vacuum map (walls, doors,
// rooms, furniture, robot, dock) served by the dreame_vacuum integration at
// /api/camera_map_data_proxy/<camera>, and overlays live state:
//   * RuView sensing nodes (ESP32) coloured by presence / motion,
//   * pets tracked by Bermuda, placed in the room of their Bermuda area.
// All data is read through the logged-in Home Assistant session; nothing is
// stored in this file. three.js is loaded from ./vendor next to this file.

const BASE = new URL('.', import.meta.url).href;
let THREE = null;
let OrbitControls = null;

async function loadThree() {
  if (THREE) return;
  THREE = await import(`${BASE}vendor/three.module.min.js`);
  ({ OrbitControls } = await import(`${BASE}vendor/OrbitControls.js`));
}

// Dreame furniture type -> [label, height in metres].
const FURNITURE = {
  1: ['Кровать', 0.5], 2: ['Двуспальная кровать', 0.55], 3: ['Диван', 0.8],
  4: ['Диван', 0.8], 5: ['Кресло', 0.8], 6: ['Обеденный стол', 0.75],
  7: ['Шкаф', 0.9], 8: ['Тумба', 0.5], 9: ['Унитаз', 0.45],
  10: ['Лоток', 0.4], 11: ['Холодильник', 1.8], 12: ['Миска', 0.1],
};

// Dreame floor material -> floor colour.
const FLOOR_COLOURS = { 0: 0xeef1f6, 1: 0xf6dcc8, 2: 0xf2d5be, 3: 0xdcebf8 };

const COLOURS = {
  background: 0xedf1f9, wall: 0xf4f5f7, wallTop: 0xffffff,
  furniture: 0xc9d7f4, nodeIdle: 0x4caf50, nodeMotion: 0xffb300,
  nodeOffline: 0x9e9e9e, nodeNoData: 0x90a4ae, pet: 0xe91e63, robot: 0x2196f3,
};

const norm = (s) => String(s ?? '').trim().toLowerCase();

async function readJson(response) {
  const buf = new Uint8Array(await response.arrayBuffer());
  // The integration serves gzip bytes without a Content-Encoding header.
  if (buf[0] === 0x1f && buf[1] === 0x8b && 'DecompressionStream' in window) {
    const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
    return JSON.parse(await new Response(stream).text());
  }
  return JSON.parse(new TextDecoder().decode(buf));
}

function textSprite(text, { size = 0.32, colour = '#37474f', background = 'rgba(255,255,255,0.85)' } = {}) {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const font = '600 44px Roboto, Arial, sans-serif';
  ctx.font = font;
  const w = Math.ceil(ctx.measureText(text).width) + 36;
  canvas.width = w;
  canvas.height = 68;
  ctx.font = font;
  ctx.fillStyle = background;
  const r = 20;
  ctx.beginPath();
  ctx.roundRect(0, 0, w, 68, r);
  ctx.fill();
  ctx.fillStyle = colour;
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 18, 36);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  sprite.scale.set((size * w) / 68, size, 1);
  sprite.renderOrder = 10;
  return sprite;
}

class RuViewHome3DCard extends HTMLElement {
  setConfig(config) {
    if (!config.camera) throw new Error('camera (Dreame map camera entity) is required');
    this._config = {
      wall_height: 1.1,
      title: 'Дом в 3D',
      nodes: [],
      pets: [],
      rooms: {},
      ...config,
    };
    if (!this._root) this._build();
  }

  getCardSize() { return 12; }

  static getStubConfig() { return { camera: 'camera.l20_ultra_complete_map' }; }

  _build() {
    this._root = this.attachShadow({ mode: 'open' });
    this._root.innerHTML = `
      <style>
        :host { display: block; height: 100%; }
        ha-card { display: block; position: relative; height: 100%; min-height: 480px; overflow: hidden; background: #edf1f9; }
        #view { position: absolute; inset: 0; touch-action: none; }
        #view canvas { display: block; width: 100% !important; height: 100% !important; }
        #status { position: absolute; left: 12px; bottom: 12px; right: 12px; display: flex; flex-wrap: wrap; gap: 6px; pointer-events: none; }
        .chip { background: rgba(255,255,255,0.92); border-radius: 14px; padding: 4px 10px; font: 500 13px Roboto, Arial, sans-serif; color: #37474f; box-shadow: 0 1px 3px rgba(0,0,0,.12); }
        .dot { display: inline-block; width: 9px; height: 9px; border-radius: 50%; margin-right: 6px; vertical-align: 1px; }
        #title { position: absolute; left: 14px; top: 10px; font: 600 16px Roboto, Arial, sans-serif; color: #37474f; }
        #msg { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font: 15px Roboto, Arial, sans-serif; color: #546e7a; text-align: center; padding: 24px; }
        button { position: absolute; right: 12px; top: 8px; border: 0; border-radius: 16px; padding: 6px 12px; background: rgba(255,255,255,.92); font: 500 13px Roboto, Arial, sans-serif; color: #37474f; cursor: pointer; min-height: 32px; }
      </style>
      <ha-card>
        <div id="view"></div>
        <div id="title"></div>
        <button id="reset" type="button" aria-label="Сбросить вид">Сбросить вид</button>
        <div id="status"></div>
        <div id="msg">Загружаю карту пылесоса…</div>
      </ha-card>`;
    this._root.getElementById('reset').addEventListener('click', () => this._resetView());
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._started) {
      this._started = true;
      this._init().catch((err) => this._showMessage(`Не удалось построить карту: ${err.message}`));
    } else if (this._scene) {
      this._updateLive();
    }
  }

  _showMessage(text) {
    const el = this._root.getElementById('msg');
    el.textContent = text;
    el.style.display = text ? 'flex' : 'none';
  }

  async _fetchMap() {
    const cam = this._hass.states[this._config.camera];
    if (!cam) throw new Error(`нет сущности ${this._config.camera}`);
    const token = cam.attributes.access_token;
    const res = await fetch(`/api/camera_map_data_proxy/${this._config.camera}?token=${token}`);
    if (!res.ok) throw new Error(`карта недоступна (HTTP ${res.status})`);
    return readJson(res);
  }

  async _init() {
    this._root.getElementById('title').textContent = this._config.title;
    await loadThree();
    this._map = await this._fetchMap();
    this._setupScene();
    this._buildHome(this._map);
    this._buildNodes();
    this._buildPets();
    this._updateLive();
    this._resetView();
    this._showMessage('');
    // Refresh robot position and map edits every 5 minutes.
    this._refreshTimer = setInterval(() => this._refreshMap(), 300000);
  }

  disconnectedCallback() {
    if (this._refreshTimer) clearInterval(this._refreshTimer);
    this._refreshTimer = null;
    this._resizeObserver?.disconnect();
  }

  connectedCallback() {
    if (this._scene && !this._refreshTimer) {
      this._refreshTimer = setInterval(() => this._refreshMap(), 300000);
      this._resizeObserver?.observe(this._root.getElementById('view'));
    }
  }

  async _refreshMap() {
    try {
      const map = await this._fetchMap();
      if (JSON.stringify(map.walls) !== JSON.stringify(this._map.walls) || map.furniture_version !== this._map.furniture_version) {
        this._map = map;
        this._scene.remove(this._home);
        this._buildHome(map);
      } else {
        this._map = map;
        this._placeRobot(map);
      }
      this._render();
    } catch (err) {
      // Keep the last good model on a transient failure.
    }
  }

  // Map millimetres (x right, y up on the robot map) to scene metres.
  _p(x, y, h = 0) { return new THREE.Vector3(x / 1000, h, -y / 1000); }

  _setupScene() {
    const view = this._root.getElementById('view');
    this._renderer = new THREE.WebGLRenderer({ antialias: true });
    this._renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this._renderer.outputColorSpace = THREE.SRGBColorSpace;
    view.appendChild(this._renderer.domElement);

    this._scene = new THREE.Scene();
    this._scene.background = new THREE.Color(COLOURS.background);
    this._camera = new THREE.PerspectiveCamera(40, 1, 0.1, 200);
    this._scene.add(new THREE.HemisphereLight(0xffffff, 0xb0bec5, 2.2));
    const sun = new THREE.DirectionalLight(0xffffff, 1.4);
    sun.position.set(-6, 14, 8);
    this._scene.add(sun);

    this._controls = new OrbitControls(this._camera, this._renderer.domElement);
    this._controls.enableDamping = true;
    this._controls.maxPolarAngle = Math.PI / 2.1;
    this._controls.addEventListener('change', () => this._render());

    const resize = () => {
      const w = view.clientWidth || 600;
      const h = view.clientHeight || 480;
      this._renderer.setSize(w, h);
      this._camera.aspect = w / h;
      this._camera.updateProjectionMatrix();
      this._render();
    };
    this._resizeObserver = new ResizeObserver(resize);
    this._resizeObserver.observe(view);
    resize();

    const tick = () => {
      if (!this.isConnected) { this._raf = null; return; }
      if (this._controls.update()) this._render();
      this._raf = requestAnimationFrame(tick);
    };
    this._raf = requestAnimationFrame(tick);
  }

  _render() {
    if (this._renderer) this._renderer.render(this._scene, this._camera);
  }

  _resetView() {
    if (!this._bounds) return;
    const { cx, cz, size } = this._bounds;
    this._controls.target.set(cx, 0, cz);
    this._camera.position.set(cx - size * 0.35, size * 0.95, cz + size * 0.75);
    this._controls.update();
    this._render();
  }

  _buildHome(map) {
    const home = new THREE.Group();
    this._home = home;
    this._scene.add(home);
    const walls = map.walls || {};
    const doors = (map.doors || []).map((d) => d.slice(0, 4));
    const floorMat = map.floor_material || {};
    let minX = Infinity; let maxX = -Infinity; let minY = Infinity; let maxY = -Infinity;

    this._roomCentres = {};
    for (const seg of map.segments || []) this._roomCentres[seg[0]] = [seg[1], seg[2]];

    const wallMat = new THREE.MeshStandardMaterial({ color: COLOURS.wall, roughness: 0.9 });
    const topMat = new THREE.MeshStandardMaterial({ color: COLOURS.wallTop, roughness: 0.6 });
    const seen = new Set();
    const h = this._config.wall_height;

    for (const [roomId, list] of Object.entries(walls)) {
      // Floor polygon from the wall loop.
      const shape = new THREE.Shape();
      list.forEach((w, i) => {
        const [x, y] = [w[0] / 1000, w[1] / 1000];
        if (i === 0) shape.moveTo(x, y); else shape.lineTo(x, y);
        minX = Math.min(minX, w[0], w[2]); maxX = Math.max(maxX, w[0], w[2]);
        minY = Math.min(minY, w[1], w[3]); maxY = Math.max(maxY, w[1], w[3]);
      });
      const floor = new THREE.Mesh(
        new THREE.ShapeGeometry(shape),
        new THREE.MeshStandardMaterial({ color: FLOOR_COLOURS[floorMat[roomId]] ?? FLOOR_COLOURS[0], roughness: 1 }),
      );
      floor.rotation.x = -Math.PI / 2;
      home.add(floor);

      for (const w of list) {
        const [x0, y0, x1, y1] = w;
        if (x0 === x1 && y0 === y1) continue;
        const key = [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)].join(',');
        if (seen.has(key)) continue;
        seen.add(key);
        const thick = (w[8] === 1 ? 0.2 : 0.1);
        for (const [a, b] of this._cutDoors(x0, y0, x1, y1, doors)) {
          const len = Math.hypot(b[0] - a[0], b[1] - a[1]) / 1000;
          if (len < 0.02) continue;
          const mid = this._p((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, h / 2);
          const box = new THREE.Mesh(new THREE.BoxGeometry(len + thick, h, thick), [wallMat, wallMat, topMat, wallMat, wallMat, wallMat]);
          box.position.copy(mid);
          // Local +X maps to (dx, 0, -dy) in the scene for a rotation of atan2(dy, dx).
          box.rotation.y = Math.atan2(b[1] - a[1], b[0] - a[0]);
          home.add(box);
        }
      }
    }

    // Room labels.
    for (const seg of map.segments || []) {
      const name = this._roomName(seg[0]);
      if (!name) continue;
      const label = textSprite(name, { size: 0.3, colour: '#546e7a', background: 'rgba(255,255,255,0.7)' });
      label.position.copy(this._p(seg[1], seg[2], h + 0.35));
      home.add(label);
    }

    // Furniture.
    const furnMat = new THREE.MeshStandardMaterial({ color: COLOURS.furniture, roughness: 0.7 });
    for (const f of map.furnitures || []) {
      const [x, y, w, d, type, , angle = 0, scale = 1] = f;
      const height = (FURNITURE[type] || ['', 0.6])[1];
      const box = new THREE.Mesh(new THREE.BoxGeometry((w * scale) / 1000, height, (d * scale) / 1000), furnMat);
      box.position.copy(this._p(x, y, height / 2));
      box.rotation.y = (angle * Math.PI) / 180;
      home.add(box);
    }

    // Dock.
    if (map.charger_position) {
      const dock = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.45, 0.35), new THREE.MeshStandardMaterial({ color: 0xffffff }));
      dock.position.copy(this._p(map.charger_position[0], map.charger_position[1], 0.225));
      home.add(dock);
    }
    this._placeRobot(map);

    const cx = (minX + maxX) / 2000; const cz = -(minY + maxY) / 2000;
    this._bounds = { cx, cz, size: Math.max(maxX - minX, maxY - minY) / 1000 };
    this._render();
  }

  _placeRobot(map) {
    if (!map.robot_position) return;
    if (!this._robot) {
      this._robot = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.17, 0.1, 32), new THREE.MeshStandardMaterial({ color: COLOURS.robot }));
      this._scene.add(this._robot);
    }
    this._robot.position.copy(this._p(map.robot_position[0], map.robot_position[1], 0.05));
  }

  // Split a wall segment around the door spans that lie on it.
  _cutDoors(x0, y0, x1, y1, doors) {
    const horizontal = Math.abs(y1 - y0) < Math.abs(x1 - x0);
    const lo = horizontal ? Math.min(x0, x1) : Math.min(y0, y1);
    const hi = horizontal ? Math.max(x0, x1) : Math.max(y0, y1);
    const line = horizontal ? (y0 + y1) / 2 : (x0 + x1) / 2;
    const gaps = [];
    for (const [dx0, dy0, dx1, dy1] of doors) {
      const dHorizontal = Math.abs(dy1 - dy0) < Math.abs(dx1 - dx0);
      if (dHorizontal !== horizontal) continue;
      const dLine = horizontal ? (dy0 + dy1) / 2 : (dx0 + dx1) / 2;
      if (Math.abs(dLine - line) > 120) continue;
      const a = Math.max(lo, horizontal ? Math.min(dx0, dx1) : Math.min(dy0, dy1));
      const b = Math.min(hi, horizontal ? Math.max(dx0, dx1) : Math.max(dy0, dy1));
      if (b - a > 10) gaps.push([a, b]);
    }
    gaps.sort((g1, g2) => g1[0] - g2[0]);
    const parts = [];
    let cur = lo;
    for (const [a, b] of gaps) {
      if (a > cur) parts.push([cur, a]);
      cur = Math.max(cur, b);
    }
    if (hi > cur) parts.push([cur, hi]);
    return parts.map(([a, b]) => (horizontal ? [[a, line], [b, line]] : [[line, a], [line, b]]));
  }

  _roomName(roomId) {
    const configured = this._config.rooms[roomId];
    if (configured) return typeof configured === 'string' ? configured : configured.name;
    const cam = this._hass.states[this._config.camera];
    return cam?.attributes?.rooms?.[roomId]?.name || '';
  }

  _roomForArea(area) {
    const a = norm(area);
    if (!a) return null;
    for (const [id, cfg] of Object.entries(this._config.rooms)) {
      const names = typeof cfg === 'string' ? [cfg] : [cfg.name, ...(cfg.areas || [])];
      if (names.some((n) => norm(n) === a)) return Number(id);
    }
    return null;
  }

  _buildNodes() {
    this._nodeObjs = {};
    for (const node of this._config.nodes) {
      const group = new THREE.Group();
      const z = (node.z ?? 1500) / 1000;
      const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, z, 8), new THREE.MeshStandardMaterial({ color: 0xb0bec5 }));
      stem.position.y = z / 2;
      const ball = new THREE.Mesh(new THREE.SphereGeometry(0.13, 24, 16), new THREE.MeshStandardMaterial({ color: COLOURS.nodeNoData, emissive: 0x000000 }));
      ball.position.y = z;
      const halo = new THREE.Mesh(new THREE.RingGeometry(0.2, 0.55, 40), new THREE.MeshBasicMaterial({ color: COLOURS.nodeMotion, transparent: true, opacity: 0, side: THREE.DoubleSide }));
      halo.rotation.x = -Math.PI / 2;
      halo.position.y = 0.02;
      const label = textSprite(node.name, { size: 0.24 });
      label.position.y = z + 0.32;
      group.add(stem, ball, halo, label);
      group.position.copy(this._p(node.x, node.y, 0));
      this._scene.add(group);
      this._nodeObjs[node.id] = { group, ball, halo };
    }
  }

  _buildPets() {
    this._petObjs = {};
    for (const pet of this._config.pets) {
      const group = new THREE.Group();
      const body = new THREE.Mesh(new THREE.SphereGeometry(0.18, 24, 16), new THREE.MeshStandardMaterial({ color: COLOURS.pet }));
      body.position.y = 0.2;
      const label = textSprite(`🐾 ${pet.name}`, { size: 0.28, colour: '#ad1457' });
      label.position.y = 0.6;
      group.add(body, label);
      group.visible = false;
      this._scene.add(group);
      this._petObjs[pet.name] = { group, offset: Object.keys(this._petObjs).length };
    }
  }

  // RuView MQTT discovery names entities ..._node<N>_presence / _motion_level.
  _nodeEntities(id) {
    this._nodeEntityCache = this._nodeEntityCache || {};
    const cached = this._nodeEntityCache[id];
    if (cached && (cached.presence || cached.motion)) return cached;
    const suffix = `_node${id}_`;
    const found = {};
    for (const eid of Object.keys(this._hass.states)) {
      if (!eid.includes('ruview_node_') || !eid.includes(suffix)) continue;
      if (eid.startsWith('binary_sensor.') && eid.endsWith(`${suffix}presence`)) found.presence = eid;
      if (eid.startsWith('sensor.') && eid.endsWith(`${suffix}motion_level`)) found.motion = eid;
    }
    this._nodeEntityCache[id] = found;
    return found;
  }

  _nodeState(id) {
    const ids = this._nodeEntities(id);
    const presence = ids.presence ? this._hass.states[ids.presence]?.state : undefined;
    const motion = ids.motion ? Number(this._hass.states[ids.motion]?.state) : undefined;
    return { found: Boolean(ids.presence || ids.motion), presence, motion };
  }

  _updateLive() {
    if (!this._nodeObjs) return;
    const chips = [];
    for (const node of this._config.nodes) {
      const obj = this._nodeObjs[node.id];
      const { found, presence, motion } = this._nodeState(node.id);
      let colour = COLOURS.nodeNoData; let text = 'нет данных'; let halo = 0;
      if (found && (presence === 'unavailable' || presence === undefined)) { colour = COLOURS.nodeOffline; text = 'не на связи'; }
      else if (presence === 'on') {
        const moving = Number.isFinite(motion) && motion >= 30;
        colour = moving ? COLOURS.nodeMotion : COLOURS.nodeIdle;
        text = moving ? 'движение' : 'кто-то есть';
        halo = moving ? 0.35 : 0.15;
      } else if (presence === 'off') { colour = COLOURS.nodeIdle; text = 'пусто'; }
      obj.ball.material.color.setHex(colour);
      obj.halo.material.color.setHex(colour);
      obj.halo.material.opacity = halo;
      chips.push(`<span class="chip"><span class="dot" style="background:#${colour.toString(16).padStart(6, '0')}"></span>${node.name}: ${text}</span>`);
    }
    for (const pet of this._config.pets) {
      const obj = this._petObjs[pet.name];
      const tracker = this._hass.states[pet.tracker];
      const area = pet.area ? this._hass.states[pet.area]?.state : null;
      const room = tracker?.state === 'home' ? this._roomForArea(area) : null;
      const centre = room != null ? this._roomCentres[room] : null;
      if (centre) {
        const dx = (obj.offset % 2 ? 1 : -1) * 350;
        obj.group.position.copy(this._p(centre[0] + dx, centre[1] - 250, 0));
        obj.group.visible = true;
        chips.push(`<span class="chip"><span class="dot" style="background:#e91e63"></span>${pet.name}: ${String(area).trim()}</span>`);
      } else {
        obj.group.visible = false;
        chips.push(`<span class="chip"><span class="dot" style="background:#9e9e9e"></span>${pet.name}: метка не слышна</span>`);
      }
    }
    this._root.getElementById('status').innerHTML = chips.join('');
    this._render();
  }
}

customElements.define('ruview-home-3d-card', RuViewHome3DCard);
window.customCards = window.customCards || [];
window.customCards.push({
  type: 'ruview-home-3d-card',
  name: 'RuView Home 3D',
  description: '3D-план квартиры по карте Dreame с узлами RuView и питомцами Bermuda',
});
