import {
  CopyObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
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
    // The SDK's default adds a CRC32 of an empty body to presigned PUT URLs, which R2 and S3 then
    // check against the real upload and refuse. Checksums stay on where the API requires them.
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
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

/**
 * Copies an object inside the bucket, server-side (decision 78: a specimen and a document never share
 * a file). The destination must be a fresh key: a copy is written once, like every other original.
 */
export async function copyObject(sourceKey: string, destinationKey: string): Promise<void> {
  if (sourceKey === destinationKey) throw new Error(`refusing to copy an object onto itself: ${sourceKey}`);
  await getS3().send(
    new CopyObjectCommand({
      Bucket: getBucket(),
      CopySource: `${getBucket()}/${sourceKey.split("/").map(encodeURIComponent).join("/")}`,
      Key: destinationKey,
    }),
  );
}

export type StoredObject = { key: string; lastModified: Date };

/** One page (up to 1,000 keys) of objects under `prefix`. */
export async function listObjects(
  prefix: string,
  continuationToken?: string,
): Promise<{ objects: StoredObject[]; nextToken: string | null }> {
  const res = await getS3().send(
    new ListObjectsV2Command({ Bucket: getBucket(), Prefix: prefix, ContinuationToken: continuationToken }),
  );
  const objects = (res.Contents ?? []).flatMap((o) => (o.Key ? [{ key: o.Key, lastModified: o.LastModified ?? new Date(0) }] : []));
  return { objects, nextToken: res.IsTruncated ? (res.NextContinuationToken ?? null) : null };
}

/**
 * Permanently deletes objects. Only the storage lifecycle calls this, after checking no row references
 * them (lib/storage/lifecycle.ts). Throws if storage reports any key it couldn't delete.
 */
export async function deleteObjects(keys: string[]): Promise<void> {
  for (let i = 0; i < keys.length; i += 1000) {
    const batch = keys.slice(i, i + 1000);
    const res = await getS3().send(
      new DeleteObjectsCommand({ Bucket: getBucket(), Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true } }),
    );
    const failed = res.Errors ?? [];
    if (failed.length > 0) {
      throw new Error(`storage refused to delete ${failed.length} objects, e.g. ${failed[0]?.Key ?? "?"}: ${failed[0]?.Message ?? ""}`);
    }
  }
}
