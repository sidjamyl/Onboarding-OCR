import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutBucketLifecycleConfigurationCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from "@aws-sdk/client-s3";
import type { CaptureStore } from "../ports.js";

export class MinioCaptureStore implements CaptureStore {
  readonly #client: S3Client;
  readonly #bucket: string;
  constructor(input: {
    endpoint: string;
    port: number;
    useSSL: boolean;
    accessKey: string;
    secretKey: string;
    bucket: string;
  }) {
    const protocol = input.useSSL ? "https" : "http";
    this.#client = new S3Client({
      endpoint: `${protocol}://${input.endpoint}:${input.port}`,
      region: "us-east-1",
      forcePathStyle: true,
      credentials: { accessKeyId: input.accessKey, secretAccessKey: input.secretKey },
    });
    this.#bucket = input.bucket;
  }

  async ensureBucket(): Promise<void> {
    try {
      await this.#client.send(new HeadBucketCommand({ Bucket: this.#bucket }));
    } catch (error) {
      if (!isMissingBucket(error)) throw error;
      await this.#client.send(new CreateBucketCommand({ Bucket: this.#bucket }));
    }
    await this.#client.send(
      new PutBucketLifecycleConfigurationCommand({
        Bucket: this.#bucket,
        LifecycleConfiguration: {
          Rules: [
            {
              ID: "delete-captures-after-30-days",
              Status: "Enabled",
              Filter: { Prefix: "" },
              Expiration: { Days: 30 },
            },
          ],
        },
      }),
    );
  }

  async put(key: string, data: Buffer, contentType: string): Promise<void> {
    await this.#client.send(
      new PutObjectCommand({
        Bucket: this.#bucket,
        Key: key,
        Body: data,
        ContentType: contentType,
        ContentLength: data.length,
      }),
    );
  }

  async get(key: string): Promise<Buffer> {
    const response = await this.#client.send(new GetObjectCommand({ Bucket: this.#bucket, Key: key }));
    if (!response.Body) throw new Error(`Object ${key} returned without a body`);
    return Buffer.from(await response.Body.transformToByteArray());
  }

  async remove(key: string): Promise<void> {
    await this.#client.send(new DeleteObjectCommand({ Bucket: this.#bucket, Key: key }));
  }

  async health(): Promise<boolean> {
    try {
      await this.#client.send(new HeadBucketCommand({ Bucket: this.#bucket }));
      return true;
    } catch {
      return false;
    }
  }
}

function isMissingBucket(error: unknown): boolean {
  return (
    error instanceof S3ServiceException &&
    (error.$metadata.httpStatusCode === 404 || error.name === "NotFound" || error.name === "NoSuchBucket")
  );
}
