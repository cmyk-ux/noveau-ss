// Desenho sobre a tela compartilhada: formato binário dos traços enviados pelo
// canal de dados do LiveKit (tópico "draw"). Recuperado do bundle deployado.

export const DRAW_TOPIC = 'draw';
export type Tool = 'pen' | 'line' | 'arrow' | 'rect' | 'ellipse';
export type ToolChoice = Tool | 'eraser';
export const TOOLS: Tool[] = ['pen', 'line', 'arrow', 'rect', 'ellipse'];
/** Espessuras como fração da altura da imagem. */
export const WIDTHS = [0.0028, 0.0055, 0.0105];
export const PALETTE = [0xff5f56, 0xffc75a, 0x7ee787, 0x79c0ff, 0xd2a8ff, 0xff9bd2, 0x5ce1e6];

const OP_POINTS = 0;
const OP_CLEAR = 1;
const OP_UNDO = 2;
const OP_ERASE = 3;
const FLAG_START = 1;
const FLAG_END = 2;
const FLAG_EVERYONE = 4;
const HEADER = 13;
const POINT_BYTES = 4;
export const U16 = 65535;
/** Tamanho máximo de um pacote "ao vivo" (sem retransmissão). */
export const LIVE_FRAME = 1200;
/** Tamanho máximo de um pacote confiável. */
export const RELIABLE_FRAME = 15e3;
const MAX_STROKES = 400;
const STALE_MS = 3e3;
const MAX_REPLAY_FRAMES = 60;
const SIMPLIFY_EPSILON = 0.0012;
const MIN_WIDTH_PX = 2;
const HIT_SLOP = 6;

export interface Point {
  x: number;
  y: number;
}
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type DrawOp =
  | { op: 'clear'; shareId: string; everyone: boolean }
  | { op: 'undo'; shareId: string }
  | { op: 'erase'; shareId: string; target: { identity: string; strokeId: number } }
  | PointsOp;

export interface PointsOp {
  op: 'points';
  shareId: string;
  strokeId: number;
  seq: number;
  start: boolean;
  end: boolean;
  tool: Tool;
  width: number;
  color: number;
  points: Point[];
}

export interface Stroke {
  key: string;
  identity: string;
  strokeId: number;
  shareId: string;
  color: number;
  tool: Tool;
  width: number;
  points: Point[];
  live: boolean;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function encodeOp(op: DrawOp): Uint8Array {
  const share = encoder.encode(op.shareId);
  const target = encoder.encode(op.op === 'erase' ? op.target.identity : '');
  const points = op.op === 'points' ? op.points : [];
  const buf = new ArrayBuffer(HEADER + share.length + target.length + points.length * POINT_BYTES);
  const bytes = new Uint8Array(buf);
  const v = new DataView(buf);
  v.setUint8(0, opCode(op));
  v.setUint8(1, flags(op));
  v.setUint16(2, strokeIdOf(op), true);
  v.setUint16(4, op.op === 'points' ? op.seq & U16 : 0, true);
  v.setUint8(6, op.op === 'points' ? TOOLS.indexOf(op.tool) : 0);
  v.setUint8(7, op.op === 'points' ? clampWidth(op.width) : 0);
  const color = op.op === 'points' ? clampColor(op.color) : 0;
  v.setUint8(8, (color >> 16) & 255);
  v.setUint8(9, (color >> 8) & 255);
  v.setUint8(10, color & 255);
  v.setUint8(11, share.length);
  v.setUint8(12, target.length);
  bytes.set(share, HEADER);
  bytes.set(target, HEADER + share.length);
  let at = HEADER + share.length + target.length;
  for (const p of points) {
    v.setUint16(at, toU16(p.x), true);
    v.setUint16(at + 2, toU16(p.y), true);
    at += POINT_BYTES;
  }
  return bytes;
}

export function decodeOp(bytes: Uint8Array): DrawOp | null {
  if (bytes.length < HEADER) return null;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const shareLen = v.getUint8(11);
  const targetLen = v.getUint8(12);
  const shareEnd = HEADER + shareLen;
  const bodyStart = shareEnd + targetLen;
  if (bytes.length < bodyStart) return null;
  const shareId = decoder.decode(bytes.subarray(HEADER, shareEnd));
  if (shareId === '') return null;
  const f = v.getUint8(1);
  switch (v.getUint8(0)) {
    case OP_CLEAR:
      return { op: 'clear', shareId, everyone: (f & FLAG_EVERYONE) !== 0 };
    case OP_UNDO:
      return { op: 'undo', shareId };
    case OP_ERASE: {
      const identity = decoder.decode(bytes.subarray(shareEnd, bodyStart));
      return identity === '' ? null : { op: 'erase', shareId, target: { identity, strokeId: v.getUint16(2, true) } };
    }
    case OP_POINTS:
      break;
    default:
      return null;
  }
  const tool = TOOLS[v.getUint8(6)];
  if (tool === undefined || (bytes.length - bodyStart) % POINT_BYTES !== 0) return null;
  const points: Point[] = [];
  for (let at = bodyStart; at < bytes.length; at += POINT_BYTES)
    points.push({ x: v.getUint16(at, true) / U16, y: v.getUint16(at + 2, true) / U16 });
  return {
    op: 'points',
    shareId,
    strokeId: v.getUint16(2, true),
    seq: v.getUint16(4, true),
    start: (f & FLAG_START) !== 0,
    end: (f & FLAG_END) !== 0,
    tool,
    width: clampWidth(v.getUint8(7)),
    color: (v.getUint8(8) << 16) | (v.getUint8(9) << 8) | v.getUint8(10),
    points,
  };
}

/** Quebra um traço em vários pacotes que caibam em `maxBytes`. */
export function splitOp(op: PointsOp, maxBytes: number): PointsOp[] {
  const per = pointsPerFrame(op.shareId, maxBytes);
  if (op.points.length <= per) return [op];
  const out: PointsOp[] = [];
  for (let i = 0; i < op.points.length; i += per) {
    const slice = op.points.slice(i, i + per);
    const last = i + per >= op.points.length;
    out.push({ ...op, seq: (op.seq + out.length) & U16, start: op.start && i === 0, end: op.end && last, points: slice });
  }
  return out;
}

function pointsPerFrame(shareId: string, maxBytes: number): number {
  const room = maxBytes - HEADER - encoder.encode(shareId).length;
  return Math.max(1, Math.floor(room / POINT_BYTES));
}

/** Ramer–Douglas–Peucker. */
export function simplify(points: Point[], epsilon = SIMPLIFY_EPSILON): Point[] {
  if (points.length < 3) return [...points];
  let worst = 0;
  let at = 0;
  const first = points[0];
  const last = points[points.length - 1];
  for (let i = 1; i < points.length - 1; i++) {
    const d = segmentDistance(points[i], first, last);
    if (d > worst) {
      worst = d;
      at = i;
    }
  }
  if (worst <= epsilon) return [first, last];
  const a = simplify(points.slice(0, at + 1), epsilon);
  const b = simplify(points.slice(at), epsilon);
  return [...a.slice(0, -1), ...b];
}

export function colorFor(identity: string): number {
  let h = 0;
  for (let i = 0; i < identity.length; i++) h = (h * 31 + identity.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

export function cssColor(c: number): string {
  return `#${clampColor(c).toString(16).padStart(6, '0')}`;
}

export function parseColor(css: string): number {
  const n = Number.parseInt(css.replace('#', ''), 16);
  return Number.isNaN(n) ? 0 : clampColor(n);
}

export function lineWidthPx(width: number, height: number): number {
  return Math.max(MIN_WIDTH_PX, height * WIDTHS[clampWidth(width)]);
}

/** Área onde a imagem aparece dentro da caixa, mantendo a proporção. */
export function fitRect(box: { width: number; height: number }, source: { width: number; height: number }): Rect {
  if (source.width <= 0 || source.height <= 0 || box.width <= 0 || box.height <= 0)
    return { x: 0, y: 0, width: box.width, height: box.height };
  const k = Math.min(box.width / source.width, box.height / source.height);
  const w = source.width * k;
  const h = source.height * k;
  return { x: (box.width - w) / 2, y: (box.height - h) / 2, width: w, height: h };
}

export const ARROW_HEAD = 0.028;
const SNAP = Math.PI / 4;

/** Com Shift: linhas em múltiplos de 45° e formas quadradas. */
export function constrain(anchor: Point, p: Point, tool: Tool, squared: boolean, frame: Rect): Point {
  if (!squared || frame.width === 0 || frame.height === 0) return p;
  const dx = (p.x - anchor.x) * frame.width;
  const dy = (p.y - anchor.y) * frame.height;
  if (tool === 'line' || tool === 'arrow') {
    const angle = Math.round(Math.atan2(dy, dx) / SNAP) * SNAP;
    const len = Math.hypot(dx, dy);
    return {
      x: clamp01(anchor.x + (Math.cos(angle) * len) / frame.width),
      y: clamp01(anchor.y + (Math.sin(angle) * len) / frame.height),
    };
  }
  const side = Math.max(Math.abs(dx), Math.abs(dy));
  return {
    x: clamp01(anchor.x + (Math.sign(dx) * side) / frame.width),
    y: clamp01(anchor.y + (Math.sign(dy) * side) / frame.height),
  };
}

/** Caixa (em px da tela) que cobre os traços, para limpar só o necessário. */
export function strokesBox(strokes: Stroke[], frame: Rect, bounds: { width: number; height: number }, pad = 0): Rect | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, margin = 0;
  for (const s of strokes) {
    for (const p of s.points) {
      minX = Math.min(minX, frame.x + p.x * frame.width);
      maxX = Math.max(maxX, frame.x + p.x * frame.width);
      minY = Math.min(minY, frame.y + p.y * frame.height);
      maxY = Math.max(maxY, frame.y + p.y * frame.height);
    }
    if (s.points.length > 0) {
      const head = s.tool === 'arrow' ? Math.max(8, frame.height * ARROW_HEAD) : 0;
      margin = Math.max(margin, lineWidthPx(s.width, frame.height) + pad + head);
    }
  }
  return maxX === -Infinity
    ? null
    : clipRect({ x: minX - margin, y: minY - margin, width: maxX - minX + margin * 2, height: maxY - minY + margin * 2 }, bounds);
}

function clipRect(r: Rect, bounds: { width: number; height: number }): Rect {
  const x = Math.max(0, r.x);
  const y = Math.max(0, r.y);
  return { x, y, width: Math.min(bounds.width, r.x + r.width) - x, height: Math.min(bounds.height, r.y + r.height) - y };
}

export function unionRect(a: Rect | null, b: Rect | null): Rect | null {
  if (a === null) return b;
  if (b === null) return a;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
}

const MAX_CANVAS_PIXELS = 4e6;
const MAX_RATIO = 2;
export function canvasRatio(width: number, height: number, dpr: number): number {
  const cap = Math.sqrt(MAX_CANVAS_PIXELS / Math.max(1, width * height));
  return Math.max(1, Math.min(dpr || 1, MAX_RATIO, cap));
}

export function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

/** Quais telas sumiram: os traços delas são descartados (exceto durante um reinício). */
export function endedShares(previous: string[], current: string[], restarting: boolean) {
  return restarting
    ? { drop: [] as string[], remember: [...previous] }
    : { drop: previous.filter((id) => !current.includes(id)), remember: [...current] };
}

export function isFreehand(tool: Tool): boolean {
  return tool === 'pen';
}

/** Traço mais de cima que passa perto do ponto. */
export function strokeAt(strokes: Stroke[], p: Point, frame: Rect): Stroke | null {
  const toPx = (q: Point) => ({ x: frame.x + q.x * frame.width, y: frame.y + q.y * frame.height });
  const at = toPx(p);
  for (let i = strokes.length - 1; i >= 0; i--) {
    const s = strokes[i];
    const reach = lineWidthPx(s.width, frame.height) / 2 + HIT_SLOP;
    if (distanceToStroke(s, at, toPx) <= reach) return s;
  }
  return null;
}

function distanceToStroke(s: Stroke, p: Point, toPx: (q: Point) => Point): number {
  const pts = s.points;
  if (pts.length === 0) return Infinity;
  if (pts.length === 1) return Math.hypot(p.x - toPx(pts[0]).x, p.y - toPx(pts[0]).y);
  const a = toPx(pts[0]);
  const b = toPx(pts[1]);
  if (s.tool === 'rect') {
    const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x), y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y);
    return Math.min(
      segmentDistance(p, { x: x0, y: y0 }, { x: x1, y: y0 }),
      segmentDistance(p, { x: x1, y: y0 }, { x: x1, y: y1 }),
      segmentDistance(p, { x: x1, y: y1 }, { x: x0, y: y1 }),
      segmentDistance(p, { x: x0, y: y1 }, { x: x0, y: y0 }),
    );
  }
  if (s.tool === 'ellipse') {
    const rx = Math.abs(b.x - a.x) / 2;
    const ry = Math.abs(b.y - a.y) / 2;
    if (rx === 0 || ry === 0) return segmentDistance(p, a, b);
    const u = (p.x - (a.x + b.x) / 2) / rx;
    const v = (p.y - (a.y + b.y) / 2) / ry;
    return Math.abs(Math.hypot(u, v) - 1) * Math.min(rx, ry);
  }
  if (s.tool !== 'pen') return segmentDistance(p, a, b);
  let best = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    best = Math.min(best, segmentDistance(p, toPx(pts[i]), toPx(pts[i + 1])));
    if (best === 0) return 0;
  }
  return best;
}

export function segmentDistance(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = Math.min(1, Math.max(0, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Guarda os traços de todo mundo e aplica as operações recebidas. */
export class StrokePad {
  private readonly strokes = new Map<string, Stroke>();
  private readonly seen = new Map<string, number>();
  private readonly grewAt = new Map<string, number>();
  private readonly ended = new Set<string>();
  private nextStrokeId = 0;
  private _settled = 0;
  private _revision = 0;

  constructor(
    private readonly mayWipeAll: (identity: string, shareId: string) => boolean = (a, b) => a === b,
    private readonly clock: () => number = Date.now,
  ) {}

  get settled() {
    return this._settled;
  }
  get revision() {
    return this._revision;
  }

  openStroke(): number {
    const id = this.nextStrokeId;
    this.nextStrokeId = (this.nextStrokeId + 1) & U16;
    return id;
  }

  apply(identity: string, op: DrawOp) {
    if (op.op === 'clear') {
      const all = op.everyone && this.mayWipeAll(identity, op.shareId);
      this.forget((s) => s.shareId === op.shareId && (all || s.identity === identity));
      return;
    }
    if (op.op === 'erase') {
      if (identity !== op.target.identity && !this.mayWipeAll(identity, op.shareId)) return;
      this.forget(
        (s) => s.shareId === op.shareId && s.identity === op.target.identity && s.strokeId === op.target.strokeId,
      );
      return;
    }
    if (op.op === 'undo') {
      const last = [...this.strokes.values()].filter((s) => s.identity === identity && s.shareId === op.shareId).at(-1);
      if (last !== undefined) this.forget((s) => s.key === last.key);
      return;
    }
    const key = `${identity} ${op.strokeId}`;
    if (op.start) {
      this.seen.delete(key);
      this.strokes.delete(key);
      this.grewAt.delete(key);
      this.ended.delete(key);
    }
    const seen = this.seen.get(key);
    if ((seen !== undefined && op.seq <= seen) || this.ended.has(key)) return;
    this.seen.set(key, op.seq);
    let stroke = this.strokes.get(key);
    if (stroke === undefined) {
      stroke = {
        key,
        identity,
        strokeId: op.strokeId,
        shareId: op.shareId,
        color: op.color,
        tool: op.tool,
        width: op.width,
        points: [],
        live: true,
      };
      this.strokes.set(key, stroke);
      this.evictOldest();
    }
    if (isFreehand(op.tool)) stroke.points.push(...op.points);
    else stroke.points = [...op.points];
    this._revision++;
    this.grewAt.set(key, this.clock());
    const live = !op.end;
    if (stroke.live !== live) {
      stroke.live = live;
      this._settled++;
    }
    if (op.end) this.ended.add(key);
  }

  strokesFor(shareId: string): Stroke[] {
    return [...this.strokes.values()].filter((s) => s.shareId === shareId);
  }

  liveCount(shareId: string): number {
    let n = 0;
    for (const s of this.strokes.values()) if (s.live && s.shareId === shareId) n++;
    return n;
  }

  hasMarks(identity: string, shareId: string): boolean {
    for (const s of this.strokes.values()) if (s.identity === identity && s.shareId === shareId) return true;
    return false;
  }

  /** Meus traços, em pacotes, para mandar a quem acabou de entrar. */
  replay(identity: string): PointsOp[] {
    const frames: PointsOp[][] = [];
    let count = 0;
    for (const s of [...this.strokes.values()].reverse()) {
      if (s.identity !== identity || s.points.length === 0) continue;
      const parts = splitOp(
        {
          op: 'points',
          shareId: s.shareId,
          strokeId: s.strokeId,
          seq: 0,
          start: true,
          end: this.ended.has(s.key),
          tool: s.tool,
          width: s.width,
          color: s.color,
          points: s.points,
        },
        RELIABLE_FRAME,
      );
      if (count + parts.length > MAX_REPLAY_FRAMES) break;
      frames.push(parts);
      count += parts.length;
    }
    return frames.reverse().flat();
  }

  dropShare(shareId: string) {
    this.forget((s) => s.shareId === shareId);
  }

  /** Traço que parou de crescer há um tempo vira "assentado" mesmo sem o fim. */
  settleStale() {
    const before = this.clock() - STALE_MS;
    for (const [key, s] of this.strokes) {
      if (!s.live || (this.grewAt.get(key) ?? 0) > before) continue;
      s.live = false;
      this._settled++;
    }
  }

  forgetDeparted(present: Set<string>) {
    this.forget((s) => !present.has(s.identity));
  }

  private forget(match: (s: Stroke) => boolean) {
    for (const [key, s] of this.strokes) {
      if (!match(s)) continue;
      this.strokes.delete(key);
      this.seen.delete(key);
      this.grewAt.delete(key);
      this.ended.delete(key);
      this._revision++;
      if (!s.live) this._settled++;
    }
  }

  private evictOldest() {
    while (this.strokes.size > MAX_STROKES) {
      const first = this.strokes.keys().next();
      if (first.done === true) return;
      this.forget((s) => s.key === first.value);
    }
  }
}

function opCode(op: DrawOp): number {
  switch (op.op) {
    case 'clear':
      return OP_CLEAR;
    case 'undo':
      return OP_UNDO;
    case 'erase':
      return OP_ERASE;
    default:
      return OP_POINTS;
  }
}

function flags(op: DrawOp): number {
  if (op.op === 'clear') return op.everyone ? FLAG_EVERYONE : 0;
  if (op.op !== 'points') return 0;
  return (op.start ? FLAG_START : 0) | (op.end ? FLAG_END : 0);
}

function clampWidth(w: number): number {
  return Math.min(WIDTHS.length - 1, Math.max(0, Math.round(w)));
}

function clampColor(c: number): number {
  return Math.round(Math.min(0xffffff, Math.max(0, c)));
}

function strokeIdOf(op: DrawOp): number {
  return op.op === 'points' ? op.strokeId & U16 : op.op === 'erase' ? op.target.strokeId & U16 : 0;
}

function toU16(v: number): number {
  return Math.round(Math.min(1, Math.max(0, v)) * U16);
}
