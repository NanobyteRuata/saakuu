import {
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  NotFound,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

import { getEnv } from "@/lib/env";

const globalForS3 = globalThis as unknown as { s3?: S3Client; s3Public?: S3Client };

function createClient(endpoint: string): S3Client {
  const env = getEnv();
  return new S3Client({
    endpoint,
    region: env.S3_REGION,
    forcePathStyle: env.S3_FORCE_PATH_STYLE,
    credentials: {
      accessKeyId: env.S3_ACCESS_KEY_ID,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    },
  });
}

/** S3-compatible client (MinIO in dev, any S3 in prod). */
export function getS3(): S3Client {
  if (!globalForS3.s3) {
    globalForS3.s3 = createClient(getEnv().S3_ENDPOINT);
  }
  return globalForS3.s3;
}

/** Client used only to sign URLs the browser will call; it never sends requests itself. */
function getPublicS3(): S3Client {
  if (!globalForS3.s3Public) {
    const env = getEnv();
    globalForS3.s3Public = createClient(env.S3_PUBLIC_ENDPOINT ?? env.S3_ENDPOINT);
  }
  return globalForS3.s3Public;
}

export function getBucket(): string {
  return getEnv().S3_BUCKET;
}

export async function checkStorage(): Promise<void> {
  await getS3().send(new HeadBucketCommand({ Bucket: getBucket() }));
}

const UPLOAD_URL_TTL_SECONDS = 15 * 60;
const DOWNLOAD_URL_TTL_SECONDS = 2 * 3600;

/**
 * Presigned PUT for a browser upload. Content type and length are part of the signature, so the
 * browser can't upload a bigger file or a different type than the one we validated.
 */
export async function presignPut(key: string, contentType: string, byteSize: number): Promise<string> {
  return getSignedUrl(
    getPublicS3(),
    new PutObjectCommand({ Bucket: getBucket(), Key: key, ContentType: contentType, ContentLength: byteSize }),
    { expiresIn: UPLOAD_URL_TTL_SECONDS, signableHeaders: new Set(["content-type", "content-length"]) },
  );
}

/**
 * Presigned GET. The signing time is floored to the hour so the same object yields the same URL
 * for an hour, which lets the browser cache thumbnails across list reloads.
 */
export async function presignGet(key: string): Promise<string> {
  const hour = 3600 * 1000;
  const signingDate = new Date(Math.floor(Date.now() / hour) * hour);
  return getSignedUrl(getPublicS3(), new GetObjectCommand({ Bucket: getBucket(), Key: key }), {
    expiresIn: DOWNLOAD_URL_TTL_SECONDS,
    signingDate,
  });
}

export async function headObject(key: string): Promise<{ byteSize: number; contentType: string | null } | null> {
  try {
    const res = await getS3().send(new HeadObjectCommand({ Bucket: getBucket(), Key: key }));
    return { byteSize: res.ContentLength ?? 0, contentType: res.ContentType ?? null };
  } catch (err) {
    if (err instanceof NotFound || (err as { name?: string }).name === "NotFound") return null;
    throw err;
  }
}

export async function getObjectBuffer(key: string): Promise<Buffer> {
  const res = await getS3().send(new GetObjectCommand({ Bucket: getBucket(), Key: key }));
  if (!res.Body) throw new Error(`storage object ${key} has no body`);
  return Buffer.from(await res.Body.transformToByteArray());
}

/** Writes a derived object. Never call with an `uploads/` key: originals are write-once from the browser. */
export async function putObject(key: string, body: Buffer, contentType: string): Promise<void> {
  if (key.includes("/uploads/")) throw new Error(`refusing to overwrite an original upload: ${key}`);
  await getS3().send(new PutObjectCommand({ Bucket: getBucket(), Key: key, Body: body, ContentType: contentType }));
}
