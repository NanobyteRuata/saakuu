import { HeadBucketCommand, S3Client } from "@aws-sdk/client-s3";

import { getEnv } from "@/lib/env";

const globalForS3 = globalThis as unknown as { s3?: S3Client };

/** S3-compatible client (MinIO in dev, any S3 in prod). */
export function getS3(): S3Client {
  if (!globalForS3.s3) {
    const env = getEnv();
    globalForS3.s3 = new S3Client({
      endpoint: env.S3_ENDPOINT,
      region: env.S3_REGION,
      forcePathStyle: env.S3_FORCE_PATH_STYLE,
      credentials: {
        accessKeyId: env.S3_ACCESS_KEY_ID,
        secretAccessKey: env.S3_SECRET_ACCESS_KEY,
      },
    });
  }
  return globalForS3.s3;
}

export function getBucket(): string {
  return getEnv().S3_BUCKET;
}

export async function checkStorage(): Promise<void> {
  await getS3().send(new HeadBucketCommand({ Bucket: getBucket() }));
}
