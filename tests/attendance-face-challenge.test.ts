import assert from "node:assert/strict";
import test from "node:test";
import {
  challengeNonceMatches,
  createChallengeNonce,
  createRandomFaceActions,
  evaluateIdentitySequence,
  hashChallengeNonce,
  validateAndHashFrameSequence,
} from "../src/lib/attendance-face-challenge";

process.env.SESSION_PASSWORD =
  process.env.SESSION_PASSWORD || "test-only-kiosk-challenge-secret-32-bytes";

const frames = Array.from({ length: 18 }, (_, index) =>
  Buffer.alloc(220, index + 1).toString("base64"),
);

test("server challenge always includes blink and one random turn", () => {
  for (let index = 0; index < 50; index += 1) {
    const actions = createRandomFaceActions();
    assert.equal(actions.length, 2);
    assert.ok(actions.includes("BLINK"));
    assert.equal(actions.filter((action) => action.startsWith("TURN_")).length, 1);
  }
});

test("nonce hash validates without storing raw nonce", () => {
  const nonce = createChallengeNonce();
  const hash = hashChallengeNonce(nonce);
  assert.notEqual(hash, nonce);
  assert.equal(challengeNonceMatches(nonce, hash), true);
  assert.equal(challengeNonceMatches(`${nonce}x`, hash), false);
});

test("frame sequence validation is ordered and deterministic", () => {
  const first = validateAndHashFrameSequence(frames, {
    minFrames: 18,
    maxFrames: 24,
    maxPayloadBytes: 20_000,
  });
  const same = validateAndHashFrameSequence(frames, {
    minFrames: 18,
    maxFrames: 24,
    maxPayloadBytes: 20_000,
  });
  const reversed = validateAndHashFrameSequence([...frames].reverse(), {
    minFrames: 18,
    maxFrames: 24,
    maxPayloadBytes: 20_000,
  });
  assert.equal(first.sequenceHash, same.sequenceHash);
  assert.notEqual(first.sequenceHash, reversed.sequenceHash);
  assert.equal(first.frames.length, 18);
});

test("frame validation rejects short and oversized payloads", () => {
  assert.throws(
    () =>
      validateAndHashFrameSequence(frames.slice(0, 17), {
        minFrames: 18,
        maxFrames: 24,
        maxPayloadBytes: 20_000,
      }),
    /18-24 frames/,
  );
  assert.throws(
    () =>
      validateAndHashFrameSequence(frames, {
        minFrames: 18,
        maxFrames: 24,
        maxPayloadBytes: 1_000,
      }),
    /too large/,
  );
});

test("identity continuity accepts same target through representatives", () => {
  const embeddings = Array.from({ length: 8 }, (_, index) => [
    1,
    index * 0.002,
    0,
  ]);
  const result = evaluateIdentitySequence({
    embeddings,
    representativeIndices: [0, 2, 4, 6, 7],
    targetEmbeddings: [[1, 0, 0]],
    otherEmbeddings: [{ employeeId: "other", enrollmentId: "e2", embedding: [0, 1, 0] }],
    matchThreshold: 0.35,
    continuityThreshold: 0.35,
    ambiguityMargin: 0.05,
    requiredRepresentativeFrames: 5,
  });
  assert.equal(result.success, true);
});

test("identity continuity rejects face switch", () => {
  const result = evaluateIdentitySequence({
    embeddings: [[1, 0, 0], [1, 0.01, 0], [0, 1, 0], [0, 1, 0], [0, 1, 0]],
    representativeIndices: [0, 1, 2, 3, 4],
    targetEmbeddings: [[1, 0, 0]],
    otherEmbeddings: [],
    matchThreshold: 0.35,
    continuityThreshold: 0.35,
    ambiguityMargin: 0.05,
    requiredRepresentativeFrames: 5,
  });
  assert.equal(result.success, false);
  assert.equal(result.reason, "face_changed_during_challenge");
});

test("identity continuity rejects ambiguous employee", () => {
  const result = evaluateIdentitySequence({
    embeddings: Array.from({ length: 5 }, () => [1, 0, 0]),
    representativeIndices: [0, 1, 2, 3, 4],
    targetEmbeddings: [[1, 0, 0]],
    otherEmbeddings: [{ employeeId: "other", enrollmentId: "e2", embedding: [1, 0, 0] }],
    matchThreshold: 0.35,
    continuityThreshold: 0.35,
    ambiguityMargin: 0.05,
    requiredRepresentativeFrames: 5,
  });
  assert.equal(result.success, false);
  assert.equal(result.reason, "ambiguous_face_match");
});
