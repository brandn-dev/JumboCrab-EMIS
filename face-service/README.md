# JumboCrab Face Service

LAN-only FastAPI service for InsightFace identity continuity and MediaPipe active
liveness. Raw frames stay in memory and are never written to disk.

## Proxmox setup

Target: x86_64 Ubuntu/Debian VM with Docker and Python 3.11 container runtime.

```bash
sudo apt update
sudo apt install -y docker.io docker-compose-plugin
cd face-service
cp docker-compose.example.yml docker-compose.yml
docker compose up -d --build
```

Build downloads immutable MediaPipe Face Landmarker float16 model version 1 and
checks SHA-256 `64184e...e0bc9ff`. Keep image and model version pinned during
calibration.

## App environment

```bash
FACE_SERVICE_URL=http://YOUR_PROXMOX_VM_IP:8001
FACE_SERVICE_API_KEY=change-this-long-random-key
FACE_ENCRYPTION_KEY=change-this-long-random-secret
KIOSK_CHALLENGE_SECRET=change-this-other-long-random-secret
```

Face service environment:

```bash
FACE_SERVICE_API_KEY=change-this-long-random-key
FACE_CTX_ID=-1
FACE_DET_SCORE_MIN=0.60
FACE_MIN_BOX_RATIO=0.16
FACE_MAX_BOX_RATIO=0.72
FACE_CHALLENGE_CENTER_YAW=0.10
FACE_CHALLENGE_TURN_YAW=0.18
FACE_BLINK_OPEN_SCORE=0.25
FACE_BLINK_CLOSED_SCORE=0.55
FACE_CONTINUITY_MAX_DISTANCE=0.42
```

## Health and tests

```bash
curl http://YOUR_PROXMOX_VM_IP:8001/health
python3 -m unittest test_challenge_state.py
```

`/embed` remains enrollment-only compatible. `/verify-challenge` accepts 18–24
ordered 480×360 frames plus two server-provided actions. It returns per-frame
InsightFace embeddings, representative indices, server action results, and PAD
state. Next.js makes the final employee match and punch decision.

Passive PAD currently returns `UNAVAILABLE`, never a fabricated pass. If admin
requires passive PAD, Next.js fails closed. Validate any future PAD model against
real kiosk conditions before enabling it.

Keep service behind LAN/firewall. Require API key. Employees must use InsightFace
enrollments produced by the same model family.
