// Clipes: o navegador de quem clipou manda um MP4 dos últimos 2 min direto para o Cloudflare R2
// (com um endereço assinado por este servidor) e recebe um link de download que vale CLIP_TTL_MS. Passou disso (ou a pessoa
// apagou antes), o arquivo some. Só quem clipou recebe o link e o código para apagar.
//
// Passo a passo para criar o bucket, a chave e o CORS: docs/CLIPES.md
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
/** Tempo para o navegador terminar de mandar o arquivo para o R2. */
const UPLOAD_WINDOW_MS = 15 * 60_000;

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
    // R2_ENDPOINT só para testes com um S3 local; no uso normal fica vazio.
    endpoint: process.env.R2_ENDPOINT || `https://${ACCOUNT}.r2.cloudflarestorage.com`,
    forcePathStyle: Boolean(process.env.R2_ENDPOINT),
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

/**
 * Passo 1: reserva um clipe e devolve um endereço assinado para o navegador mandar o MP4 DIRETO
 * para o R2. O arquivo (até centenas de MB) nunca passa pela memória deste servidor, que é
 * pequeno (1 GB de RAM). O bucket precisa de uma regra de CORS liberando PUT deste site.
 */
export async function startClip(owner, name, bytes) {
  if (!clipsEnabled) throw new ClipError(503, 'Clipes não estão configurados neste servidor (faltam R2_* no env).');
  const size = Number(bytes);
  if (!(size > 0)) throw new ClipError(411, 'Tamanho do clipe não informado.');
  if (size > MAX_BYTES) throw new ClipError(413, 'Clipe grande demais.');
  const mine = [...clips.values()].filter((c) => c.owner === owner).length;
  if (mine >= MAX_PER_PERSON) throw new ClipError(429, `No máximo ${MAX_PER_PERSON} clipes ao mesmo tempo. Apague ou espere um sumir.`);

  const id = randomBytes(9).toString('base64url');
  const key = `${PREFIX}${id}.mp4`;
  const token = randomBytes(18).toString('base64url');
  const c = await client();
  const uploadUrl = await presign(
    c,
    new sdk.PutObjectCommand({ Bucket: BUCKET, Key: key, ContentType: 'video/mp4', ContentLength: size }),
    { expiresIn: Math.floor(UPLOAD_WINDOW_MS / 1000) },
  );
  const file = `noveau-${String(name || 'clipe').replace(/[^\w-]+/g, '-').slice(0, 40)}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.mp4`;
  // Se o envio nunca terminar, esquece a reserva (e apaga o que tiver chegado).
  const timer = setTimeout(() => {
    forget(id);
    removeObject(key).catch(() => undefined);
  }, UPLOAD_WINDOW_MS + 60_000);
  clips.set(id, { key, token, owner, file, size, expiresAt: 0, timer, ready: false });
  return { id, token, uploadUrl };
}

/** Passo 2: o navegador terminou o PUT. Confere no R2 e devolve o link de download. */
export async function finishClip(id, token) {
  const clip = clips.get(id);
  if (clip === undefined) throw new ClipError(404, 'Esse clipe expirou antes de terminar de subir.');
  if (!sameToken(clip.token, token)) throw new ClipError(403, 'Só quem fez o clipe pode terminar o envio.');
  const c = await client();
  let head;
  try {
    head = await c.send(new sdk.HeadObjectCommand({ Bucket: BUCKET, Key: clip.key }));
  } catch {
    throw new ClipError(409, 'O arquivo não chegou no R2.');
  }
  if ((head.ContentLength ?? 0) > MAX_BYTES) {
    forget(id);
    await removeObject(clip.key).catch(() => undefined);
    throw new ClipError(413, 'Clipe grande demais.');
  }
  clearTimeout(clip.timer);
  clip.ready = true;
  clip.expiresAt = Date.now() + CLIP_TTL_MS;
  clip.timer = setTimeout(() => {
    forget(id);
    removeObject(clip.key).catch((e) => console.error('[clipes] apagar no prazo:', e.message));
  }, CLIP_TTL_MS);
  const url = await presign(
    c,
    new sdk.GetObjectCommand({ Bucket: BUCKET, Key: clip.key, ResponseContentDisposition: `attachment; filename="${clip.file}"` }),
    { expiresIn: Math.floor(CLIP_TTL_MS / 1000) },
  );
  console.log(`[clipes] ${clip.owner} clipou ${((head.ContentLength ?? 0) / 1e6).toFixed(1)} MB (${id})`);
  return { id, url, expiresAt: clip.expiresAt, bytes: head.ContentLength ?? 0 };
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
    // Pronto há mais que o prazo, ou um envio largado no meio há mais que a janela de envio.
    const limit = Date.now() - Math.max(CLIP_TTL_MS, UPLOAD_WINDOW_MS) - 60_000;
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
