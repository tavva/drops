// ABOUTME: Resets the MinIO test bucket to a clean state before each integration test run.
import './env';
import { S3Client, CreateBucketCommand, DeleteObjectsCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';

export const s3 = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT!,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID!,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
  },
  forcePathStyle: true,
});

export async function resetBucket() {
  try {
    let ContinuationToken: string | undefined;
    do {
      const list = await s3.send(new ListObjectsV2Command({
        Bucket: process.env.R2_BUCKET!,
        ContinuationToken,
      }));
      if (list.Contents?.length) {
        await s3.send(new DeleteObjectsCommand({
          Bucket: process.env.R2_BUCKET!,
          Delete: { Objects: list.Contents.map((o) => ({ Key: o.Key! })) },
        }));
      }
      ContinuationToken = list.IsTruncated ? list.NextContinuationToken : undefined;
    } while (ContinuationToken);
  } catch (e: unknown) {
    const name = (e as { name?: string })?.name;
    if (name !== 'NoSuchBucket') throw e;
  }
  try { await s3.send(new CreateBucketCommand({ Bucket: process.env.R2_BUCKET! })); }
  catch (e: unknown) {
    const name = (e as { name?: string })?.name;
    if (name !== 'BucketAlreadyOwnedByYou' && name !== 'BucketAlreadyExists') throw e;
  }
}
