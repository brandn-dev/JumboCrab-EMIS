# JumboCrab Face Service

Local FastAPI service for attendance face embeddings using InsightFace/ArcFace.

## Proxmox Setup

Use an Ubuntu VM for simplest dependency handling.

```bash
sudo apt update
sudo apt install -y docker.io docker-compose-plugin
cd face-service
cp docker-compose.example.yml docker-compose.yml
docker compose up -d --build
```

Keep this service LAN-only. Do not expose it to the public internet.

## App Env

Set these in the Next.js app:

```bash
FACE_SERVICE_URL=http://YOUR_PROXMOX_VM_IP:8001
FACE_SERVICE_API_KEY=change-this-long-random-key
FACE_MATCH_PROVIDER=insightface
```

The API key must match `FACE_SERVICE_API_KEY` in `docker-compose.yml`.

## Health Check

```bash
curl http://YOUR_PROXMOX_VM_IP:8001/health
```

## Notes

- Raw images are processed in memory only.
- No frame is written to disk by the service.
- Employees must re-enroll after switching from face-api.js to InsightFace.
- CPU works for small teams; GPU can be added later if punch traffic grows.
