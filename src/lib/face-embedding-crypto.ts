import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const ENVELOPE_VERSION = 1;

const getEncryptionKey = () => {
  const secret =
    process.env.FACE_ENCRYPTION_KEY ||
    process.env.FACE_EMBEDDING_SECRET ||
    process.env.SESSION_PASSWORD;

  if (!secret || secret.trim().length < 16) {
    throw new Error("FACE_ENCRYPTION_KEY must be configured before storing face embeddings.");
  }

  return createHash("sha256").update(secret).digest();
};

export const encryptFaceEmbedding = (embedding: number[]) => {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getEncryptionKey(), iv);
  const plaintext = Buffer.from(JSON.stringify(embedding), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  return Buffer.from(
    JSON.stringify({
      v: ENVELOPE_VERSION,
      iv: iv.toString("base64"),
      tag: tag.toString("base64"),
      data: ciphertext.toString("base64"),
    }),
    "utf8",
  );
};

export const decryptFaceEmbedding = (payload: Buffer | Uint8Array) => {
  const raw = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const envelope = JSON.parse(raw.toString("utf8")) as {
    v: number;
    iv: string;
    tag: string;
    data: string;
  };

  if (envelope.v !== ENVELOPE_VERSION) {
    throw new Error("Unsupported face embedding envelope version.");
  }

  const decipher = createDecipheriv(
    "aes-256-gcm",
    getEncryptionKey(),
    Buffer.from(envelope.iv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(envelope.data, "base64")),
    decipher.final(),
  ]);
  const embedding = JSON.parse(plaintext.toString("utf8")) as unknown;

  if (
    !Array.isArray(embedding) ||
    embedding.some((value) => typeof value !== "number" || !Number.isFinite(value))
  ) {
    throw new Error("Invalid face embedding payload.");
  }

  return embedding;
};

export const faceDistance = (left: number[], right: number[]) => {
  if (left.length !== right.length || left.length === 0) {
    return Number.POSITIVE_INFINITY;
  }

  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftMagnitude += left[index] * left[index];
    rightMagnitude += right[index] * right[index];
  }

  const denominator = Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude);
  if (denominator <= 0) return Number.POSITIVE_INFINITY;

  return 1 - dot / denominator;
};
