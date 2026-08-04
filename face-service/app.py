import base64
import os
import time
from typing import Literal

import cv2
import numpy as np
from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

from insightface.app import FaceAnalysis


MODEL_VERSION = os.getenv("FACE_MODEL_VERSION", "insightface/arcface-buffalo_l")
API_KEY = os.getenv("FACE_SERVICE_API_KEY", "").strip()
DET_SIZE = int(os.getenv("FACE_DET_SIZE", "640"))
DET_SCORE_MIN = float(os.getenv("FACE_DET_SCORE_MIN", "0.60"))
MIN_FACE_BOX_RATIO = float(os.getenv("FACE_MIN_BOX_RATIO", "0.16"))
MAX_FACE_BOX_RATIO = float(os.getenv("FACE_MAX_BOX_RATIO", "0.72"))
MAX_ABS_YAW_RATIO = float(os.getenv("FACE_MAX_ABS_YAW_RATIO", "0.12"))
CTX_ID = int(os.getenv("FACE_CTX_ID", "-1"))


class EmbedRequest(BaseModel):
    frames: list[str] = Field(min_length=1, max_length=18)
    purpose: Literal["enrollment", "verification"] = "verification"
    requireFrontFace: bool = True


app = FastAPI(title="JumboCrab Face Service", version="1.0.0")
face_app: FaceAnalysis | None = None


@app.on_event("startup")
def startup() -> None:
    global face_app
    face_app = FaceAnalysis(name="buffalo_l", providers=["CPUExecutionProvider"])
    face_app.prepare(ctx_id=CTX_ID, det_size=(DET_SIZE, DET_SIZE))


def require_api_key(x_face_service_key: str | None) -> None:
    if API_KEY and x_face_service_key != API_KEY:
        raise HTTPException(status_code=401, detail="Invalid face service API key.")


def decode_frame(frame: str) -> np.ndarray:
    raw = frame.split(",", 1)[-1]
    try:
        data = base64.b64decode(raw, validate=True)
    except Exception as exc:
        raise HTTPException(status_code=400, detail="Invalid frame encoding.") from exc

    image = cv2.imdecode(np.frombuffer(data, dtype=np.uint8), cv2.IMREAD_COLOR)
    if image is None:
        raise HTTPException(status_code=400, detail="Invalid image frame.")
    return image


def face_quality(face, image: np.ndarray) -> dict:
    height, width = image.shape[:2]
    x1, y1, x2, y2 = face.bbox.astype(float)
    box_width = max(0.0, x2 - x1)
    box_height = max(0.0, y2 - y1)
    face_box_ratio = min(
        box_width / max(1.0, float(width)),
        box_height / max(1.0, float(height)),
    )

    yaw_ratio = None
    if getattr(face, "kps", None) is not None and len(face.kps) >= 3:
        left_eye = face.kps[0]
        right_eye = face.kps[1]
        nose = face.kps[2]
        eye_distance = float(np.linalg.norm(right_eye - left_eye))
        if eye_distance > 0:
            eye_mid_x = float((left_eye[0] + right_eye[0]) / 2)
            yaw_ratio = float((nose[0] - eye_mid_x) / eye_distance)

    front_face = (
        face.det_score >= DET_SCORE_MIN
        and MIN_FACE_BOX_RATIO <= face_box_ratio <= MAX_FACE_BOX_RATIO
        and yaw_ratio is not None
        and abs(yaw_ratio) <= MAX_ABS_YAW_RATIO
    )

    return {
        "detectionScore": float(face.det_score),
        "faceBoxRatio": float(face_box_ratio),
        "yawRatio": yaw_ratio,
        "frontFace": front_face,
        "box": {
            "x": float(x1),
            "y": float(y1),
            "width": float(box_width),
            "height": float(box_height),
        },
        "inputWidth": int(width),
        "inputHeight": int(height),
    }


@app.get("/health")
def health() -> dict:
    return {"ok": True, "modelVersion": MODEL_VERSION}


@app.post("/embed")
def embed(
    request: EmbedRequest,
    x_face_service_key: str | None = Header(default=None),
) -> dict:
    require_api_key(x_face_service_key)
    if face_app is None:
        raise HTTPException(status_code=503, detail="Face model is not ready.")

    started = time.perf_counter()
    embeddings: list[np.ndarray] = []
    qualities: list[dict] = []

    for frame in request.frames:
        image = decode_frame(frame)
        faces = face_app.get(image)
        if len(faces) != 1:
            return {
                "success": False,
                "error": (
                    "No face detected. Please retry."
                    if len(faces) == 0
                    else "Multiple faces detected. Only one employee may be in frame."
                ),
                "reason": "no_face_detected" if len(faces) == 0 else "multiple_faces",
                "faceCount": len(faces),
                "modelVersion": MODEL_VERSION,
            }

        quality = face_quality(faces[0], image)
        qualities.append(quality)
        if request.requireFrontFace and not quality["frontFace"]:
            return {
                "success": False,
                "error": "Face camera directly and fit your face inside the guide.",
                "reason": "face_not_front",
                "faceCount": 1,
                "quality": quality,
                "modelVersion": MODEL_VERSION,
            }

        embedding = np.asarray(faces[0].normed_embedding, dtype=np.float32)
        norm = np.linalg.norm(embedding)
        if norm <= 0:
            return {
                "success": False,
                "error": "Face embedding could not be created.",
                "reason": "invalid_face_embedding",
                "faceCount": 1,
                "modelVersion": MODEL_VERSION,
            }
        embeddings.append(embedding / norm)

    averaged = np.mean(np.stack(embeddings), axis=0)
    averaged_norm = np.linalg.norm(averaged)
    if averaged_norm > 0:
        averaged = averaged / averaged_norm

    scores = [quality["detectionScore"] for quality in qualities]
    box_ratios = [quality["faceBoxRatio"] for quality in qualities]
    yaw_ratios = [
        quality["yawRatio"] for quality in qualities if quality["yawRatio"] is not None
    ]

    return {
        "success": True,
        "embedding": averaged.astype(float).tolist(),
        "modelVersion": MODEL_VERSION,
        "faceCount": 1,
        "quality": {
            "detectionScore": float(np.mean(scores)) if scores else None,
            "faceBoxRatio": float(np.mean(box_ratios)) if box_ratios else None,
            "yawRatio": float(np.mean(yaw_ratios)) if yaw_ratios else None,
            "frontFace": all(quality["frontFace"] for quality in qualities),
            "frames": qualities,
        },
        "serviceLatencyMs": round((time.perf_counter() - started) * 1000),
    }
