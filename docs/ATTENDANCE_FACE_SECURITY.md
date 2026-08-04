# Attendance Face Challenge Security

## Security model

Face kiosk modes use a server-issued, database-backed challenge. The server chooses
`BLINK` plus one random left/right turn, shuffles their order, stores only a nonce
hash, and binds the attempt to employee, kiosk ID, request IP/user agent, and the
employee QR when QR mode starts the flow.

The browser only displays prompts and uploads a continuous 24-frame JPEG sequence.
It cannot submit liveness, face count, employee identity, action results, or model
results. The Python service derives these from the frames with MediaPipe Face
Landmarker and InsightFace.

Success requires all checks:

- unexpired pending challenge and matching nonce/kiosk binding;
- valid ordered frame sequence with one face throughout;
- neutral/action/neutral/action/neutral temporal transitions;
- same InsightFace identity through the sequence;
- representative frames match the enrolled employee and are not ambiguous;
- passive PAD success when the administrator requires passive PAD;
- unchanged punch sequence and unlocked attendance at commit time.

Punch creation, challenge consumption, QR consumption, and the passed verification
record commit in one serializable transaction. Employee-scoped PostgreSQL advisory
locks prevent concurrent kiosk submissions from creating duplicate punch steps.

Raw frames are processed in memory and are never stored. Audit rows store hashes,
actions, metrics, thresholds, reason codes, latency, and model versions.

## Limits and threat model

Random active actions stop static-photo attacks and basic prerecorded blink clips.
Identity continuity rejects another person entering during capture. Exact ordered
frame hashes reject byte-for-byte replay.

Passive presentation-attack detection is an interface in this release, but its
provider reports `UNAVAILABLE`. When `passiveAntiSpoofRequired` is enabled, punches
fail closed with `anti_spoof_unavailable`. Active-only mode cannot guarantee defense
against a well-prepared real-time deepfake or action-matched screen replay. Do not
claim passive PAD coverage until a model is validated on the real kiosk cameras,
lighting, print media, and phone displays.

Kiosk binding relies on server HMAC plus configured kiosk ID, request IP, and user
agent. Keep `ALLOWED_PUNCH_IPS` configured and do not expose the kiosk publicly.

## Configuration

Next.js environment:

```bash
FACE_SERVICE_URL=http://FACE_VM_IP:8001
FACE_SERVICE_API_KEY=long-random-service-key
FACE_ENCRYPTION_KEY=long-random-template-key
KIOSK_CHALLENGE_SECRET=long-random-hmac-key
ALLOWED_PUNCH_IPS=192.168.0.18,192.168.0.19
NEXT_PUBLIC_KIOSK_ID=JUMBOCRAB-KIOSK-01
```

`KIOSK_CHALLENGE_SECRET` falls back to `SESSION_PASSWORD`, but a separate secret is
preferred. Admin attendance settings control challenge expiry, rate limits, failure
cooldown, identity distance, and passive-PAD fail-closed behavior. Face modes always
force active challenge and identity continuity on.

Face-service thresholds are environment variables documented in
`face-service/README.md`. Calibrate them with real staff before production rollout.

## Deploy and migrate

1. Back up database and reconcile Prisma migration history.
2. Apply `20260804090000_secure_attendance_face_challenges` in the target environment.
3. Run `npm run prisma:generate` and deploy Next.js.
4. Rebuild the face-service image so MediaPipe and `face_landmarker.task` are present.
5. Confirm `/health` reports active liveness and passive PAD as unavailable.
6. Test enrolled employee through every kiosk mode before enabling face mode.

This repository's shared Neon database has migration-history drift. Do not run
`prisma migrate deploy` there blindly. First compare `_prisma_migrations`, baseline
already-applied migrations, then apply this forward migration through the approved
deployment process. Disposable PostgreSQL should be used for clean migration tests.

During staged rollout, schema detection keeps legacy `QR_ONLY` mode working before
this migration is present. Both face modes fail closed with
`security_migration_required`; they never fall back to client liveness.

Rollback application code only after disabling face modes back to `QR_ONLY`.
Challenge and audit tables are additive and may remain. Dropping them loses security
audit history and needs separate approval.

## Verification

```bash
npm run prisma:generate
npm run test:attendance-security
npm run test:face-service
npm run lint
npm run build
```

Manual cases: valid actions, wrong order, no action, static photo, phone replay,
second face entering, face swap, expired challenge, reused QR, double submit,
camera denial, face-service outage, and passive PAD required while unavailable.
