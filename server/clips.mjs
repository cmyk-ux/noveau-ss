// Clipes: o navegador de quem clipou manda um MP4 dos últimos 2 min, o servidor guarda no
// Cloudflare R2 e devolve um link de download que vale CLIP_TTL_MS. Passou disso (ou a pessoa
// apagou antes), o arquivo some. Só quem clipou recebe o link e o código para apagar.
//
// .env: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET. Sem eles, clipes desligados.

import { randomBytes, timingSafeEqual } from 'node:crypto';

const ACCOUNT = process.env.R2_ACCOUNT_ID ?? '';
const KEY_ID = process.env.R2_ACCESS_KEY_ID ?? '';
const SECRET = process.env.R2_SECRET_ACCESS_KEY ?? '';
const BUCKET = process.env.R2_BUCKET ?? '';
export const clipsEnabled = ACCOUNT !== '' && KEY_ID !== '' && SECRET !== '' && BUCKET !== '';

export const CLIP_TTL_MS = 5 * 60_000;
const MAX_BYTES = 400 * 1024 * 1024; // 2 min a 1080p60 fica em ~150 MB; folga para picos.
const MAX_PER_PERSON = 3;
const PREFIX = 'clips/';
const SWEEP_MS = 60_000;

export class ClipError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

let s3 = null;
let sdk = null;
let presign = null;

async function client() {
  if (s3 !== null) return s3;
  sdk = await import('@aws-sdk/client-s3');
  ({ getSignedUrl: presign } = await import('@aws-sdk/s3-request-presigner'));
  s3 = new sdk.S3Client({
    region: 'auto',
    endpoint: `https://${ACCOUNT}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: KEY_ID, secretAccessKey: SECRET },
  });
  return s3;
}

/** id -> { key, token, owner, expiresAt, timer } */
const clips = new Map();

function sameToken(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

async function removeObject(key) {
  const c = await client();
  await c.send(new sdk.DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
}

function forget(id) {
  const clip = clips.get(id);
  if (clip === undefined) return null;
  clearTimeout(clip.timer);
  clips.delete(id);
  return clip;
}

/** Recebe o corpo (MP4) e sobe para o R2. `owner` é a identidade do LiveKit de quem clipou. */
export async function uploadClip(req, owner, name) {
  if (!clipsEnabled) throw new ClipError(503, 'Clipes não estão configurados neste servidor (faltam R2_* no .env).');
  const mine = [...clips.values()].filter((c) => c.owner === owner).length;
  if (mine >= MAX_PER_PERSON) throw new ClipError(429, `No máximo ${MAX_PER_PERSON} clipes ao mesmo tempo. Apague ou espere um sumir.`);
  const declared = Number(req.headers['content-length'] ?? 0);
  if (!(declared > 0)) throw new ClipError(411, 'Tamanho do clipe não informado.');
  if (declared > MAX_BYTES) throw new ClipError(413, 'Clipe grande demais.');

  const body = await new Promise((resolve, reject) => {
    const parts = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BYTES) {
        reject(new ClipError(413, 'Clipe grande demais.'));
        req.destroy();
        return;
      }
      parts.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(parts)));
    req.on('error', reject);
  });

  const id = randomBytes(9).toString('base64url');
  const key = `${PREFIX}${id}.mp4`;
  const c = await client();
  await c.send(new sdk.PutObjectCommand({ Bucket: BUCKET, Key: key, Body: body, ContentType: 'video/mp4' }));

  const expiresAt = Date.now() + CLIP_TTL_MS;
  const token = randomBytes(18).toString('base64url');
  const timer = setTimeout(() => {
    forget(id);
    removeObject(key).catch((e) => console.error('[clipes] apagar no prazo:', e.message));
  }, CLIP_TTL_MS);
  clips.set(id, { key, token, owner, expiresAt, timer });

  const file = `noveau-${(name || 'clipe').replace(/[^\w-]+/g, '-').slice(0, 40)}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.mp4`;
  const url = await presign(
    c,
    new sdk.GetObjectCommand({ Bucket: BUCKET, Key: key, ResponseContentDisposition: `attachment; filename="${file}"` }),
    { expiresIn: Math.floor(CLIP_TTL_MS / 1000) },
  );
  console.log(`[clipes] ${owner} clipou ${(body.length / 1e6).toFixed(1)} MB (${id})`);
  return { id, url, token, expiresAt, bytes: body.length };
}

export async function deleteClip(id, token) {
  const clip = clips.get(id);
  if (clip === undefined) return { deleted: false };
  if (!sameToken(clip.token, token)) throw new ClipError(403, 'Só quem fez o clipe pode apagar.');
  forget(id);
  await removeObject(clip.key);
  return { deleted: true };
}

/**
 * Faxina: apaga do R2 qualquer clipe mais velho que o prazo. Cobre o caso do servidor ter
 * reiniciado no meio (os temporizadores da memória somem, os arquivos não).
 */
async function sweep() {
  if (!clipsEnabled) return;
  try {
    const c = await client();
    const out = await c.send(new sdk.ListObjectsV2Command({ Bucket: BUCKET, Prefix: PREFIX, MaxKeys: 1000 }));
    const limit = Date.now() - CLIP_TTL_MS - 30_000;
    for (const o of out.Contents ?? []) {
      if (o.Key !== undefined && o.LastModified !== undefined && o.LastModified.getTime() < limit) await removeObject(o.Key);
    }
  } catch (e) {
    console.error('[clipes] faxina:', e.message);
  }
}

if (clipsEnabled) {
  void sweep();
  setInterval(() => void sweep(), SWEEP_MS).unref();
}
