// ABOUTME: One-shot helper that creates the R2/MinIO bucket named in R2_BUCKET if missing.
import { CreateBucketCommand, HeadBucketCommand } from '@aws-sdk/client-s3';
import { s3 } from '@/lib/r2';
import { config } from '@/config';

try {
  await s3.send(new HeadBucketCommand({ Bucket: config.R2_BUCKET }));
  console.log(`Bucket ${config.R2_BUCKET} already exists.`);
} catch {
  await s3.send(new CreateBucketCommand({ Bucket: config.R2_BUCKET }));
  console.log(`Created bucket ${config.R2_BUCKET}.`);
}
process.exit(0);
