import base64
import os
import time
from typing import Literal

import cv2
import mediapipe as mp
import numpy as np
from fastapi import FastAPI, Header, HTTPException
from insightface.app import FaceAnalysis
from mediapipe.tasks import python
from mediapipe.tasks.python import vision
from pydantic import BaseModel, Field
from challenge_state import evaluate_action_sequence


MODEL_VERSION = os.getenv("FACE_MODEL_VERSION", "insightface/arcface-buffalo_l")
LANDMARK_MODEL_PATH = os.getenv(
    "FACE_LANDMARK_MODEL_PATH", "/app/models/face_landmarker.task"
)
API_KEY = os.getenv("FACE_SERVICE_API_KEY", "").strip()
DET_SIZE = int(os.getenv("FACE_DET_SIZE", "640"))
DET_SCORE_MIN = float(os.getenv("FACE_DET_SCORE_MIN", "0.60"))
MIN_FACE_BOX_RATIO = float(os.getenv("FACE_MIN_BOX_RATIO", "0.16"))
MAX_FACE_BOX_RATIO = float(os.getenv("FACE_MAX_BOX_RATIO", "0.72"))
MAX_ABS_YAW_RATIO = float(os.getenv("FACE_MAX_ABS_YAW_RATIO", "0.12"))
CHALLENGE_CENTER_YAW = float(os.getenv("FACE_CHALLENGE_CENTER_YAW", "0.10"))
CHALLENGE_TURN_YAW = float(os.getenv("FACE_CHALLENGE_TURN_YAW", "0.18"))
BLINK_OPEN_SCORE = float(os.getenv("FACE_BLINK_OPEN_SCORE", "0.25"))
BLINK_CLOSED_SCORE = float(os.getenv("FACE_BLINK_CLOSED_SCORE", "0.55"))
CONTINUITY_MAX_DISTANCE = float(
    os.getenv("FACE_CONTINUITY_MAX_DISTANCE", "0.42")
)
CTX_ID = int(os.getenv("FACE_CTX_ID", "-1"))

FaceAction = Literal["BLINK", "TURN_LEFT", "TURN_RIGHT"]


class EmbedRequest(BaseModel):
    frames: list[str] = Field(min_length=1, max_length=18)
    purpose: Literal["enrollment", "verification"] = "verification"
    requireFrontFace: bool = True


class ChallengeRequest(BaseModel):
    frames: list[str] = Field(min_length=18, max_length=24)
    actions: list[FaceAction] = Field(min_length=2, max_length=2)


app = FastAPI(title="JumboCrab Face Service", version="1.1.0")
face_app: FaceAnalysis | None = None
face_landmarker: vision.FaceLandmarker | None = None


@app.on_event("startup")
def startup() -> None:
    global face_app, face_landmarker
    face_app = FaceAnalysis(name="buffalo_l", providers=["CPUExecutionProvider"])
    face_app.prepare(ctx_id=CTX_ID, det_size=(DET_SIZE, DET_SIZE))
    if not os.path.isfile(LANDMARK_MODEL_PATH):
        raise RuntimeError(f"Face landmarker model missing: {LANDMARK_MODEL_PATH}")
    options = vision.FaceLandmarkerOptions(
        base_options=python.BaseOptions(model_asset_path=LANDMARK_MODEL_PATH),
        running_mode=vision.RunningMode.VIDEO,
        num_faces=2,
        min_face_detection_confidence=0.6,
        min_face_presence_confidence=0.6,
        min_tracking_confidence=0.6,
        output_face_blendshapes=True,
        output_facial_transformation_matrixes=True,
    )
    face_landmarker = vision.FaceLandmarker.create_from_options(options)


def require_api_key(x_face_service_key: str | None) -> None:
    if API_KEY and x_face_service_key != API_KEY:
        raise HTTPException(status_code=401, detail="Invalid face service API key.")


def decode_frame(frame: str) -> np.ndarray:
    raw = frame.split(",", 1)[-1]
    try:
        data = base64.b64decode(raw, validate=True)
    except Exception as exc:
        raise HTTPException(status_code=400, detail="Invalid frame encoding.") from exc
    if len(data) > 120_000:
        raise HTTPException(status_code=413, detail="Frame is too large.")

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


def normalized_embedding(face) -> np.ndarray:
    embedding = np.asarray(face.normed_embedding, dtype=np.float32)
    norm = np.linalg.norm(embedding)
    if norm <= 0:
        raise ValueError("Face embedding could not be created.")
    return embedding / norm


def blendshape_score(result, name: str) -> float:
    if not result.face_blendshapes:
        return 0.0
    for category in result.face_blendshapes[0]:
        category_name = getattr(category, "category_name", "")
        if category_name == name:
            return float(category.score)
    return 0.0


def landmark_yaw_ratio(result) -> float | None:
    if not result.face_landmarks:
        return None
    landmarks = result.face_landmarks[0]
    if len(landmarks) <= 263:
        return None
    left_eye = landmarks[33]
    right_eye = landmarks[263]
    nose = landmarks[1]
    eye_distance = abs(float(right_eye.x - left_eye.x))
    if eye_distance <= 1e-6:
        return None
    return float((nose.x - ((left_eye.x + right_eye.x) / 2.0)) / eye_distance)


def passive_anti_spoof(_images: list[np.ndarray]) -> dict:
    return {
        "status": "UNAVAILABLE",
        "provider": "disabled",
        "score": None,
        "attackType": None,
    }


@app.get("/health")
def health() -> dict:
    return {
        "ok": face_app is not None and face_landmarker is not None,
        "modelVersion": MODEL_VERSION,
        "activeLiveness": "mediapipe-face-landmarker",
        "passiveAntiSpoof": "unavailable",
    }


@app.post("/embed")
async def embed(
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
                "error": "Face frame rejected.",
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
        try:
            embeddings.append(normalized_embedding(faces[0]))
        except ValueError:
            return {
                "success": False,
                "error": "Face embedding could not be created.",
                "reason": "invalid_face_embedding",
                "faceCount": 1,
                "modelVersion": MODEL_VERSION,
            }

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


@app.post("/verify-challenge")
async def verify_challenge(
    request: ChallengeRequest,
    x_face_service_key: str | None = Header(default=None),
) -> dict:
    require_api_key(x_face_service_key)
    if face_app is None or face_landmarker is None:
        raise HTTPException(status_code=503, detail="Face models are not ready.")
    if set(request.actions) not in ({"BLINK", "TURN_LEFT"}, {"BLINK", "TURN_RIGHT"}):
        raise HTTPException(status_code=400, detail="Invalid challenge actions.")

    started = time.perf_counter()
    images: list[np.ndarray] = []
    embeddings: list[np.ndarray] = []
    metrics: list[dict] = []
    qualities: list[dict] = []

    for index, frame in enumerate(request.frames):
        image = decode_frame(frame)
        height, width = image.shape[:2]
        if (width, height) != (480, 360):
            return {
                "success": False,
                "error": "Face frame dimensions are invalid.",
                "reason": "invalid_frame_dimensions",
                "faceCount": 0,
                "modelVersion": MODEL_VERSION,
            }
        faces = face_app.get(image)
        rgb = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
        mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
        landmarks = face_landmarker.detect_for_video(mp_image, index * 200)
        face_count = max(len(faces), len(landmarks.face_landmarks))
        if len(faces) != 1 or len(landmarks.face_landmarks) != 1:
            return {
                "success": False,
                "error": "Face sequence rejected.",
                "reason": "no_face_detected" if face_count == 0 else "multiple_faces",
                "faceCount": face_count,
                "modelVersion": MODEL_VERSION,
            }

        quality = face_quality(faces[0], image)
        if (
            quality["detectionScore"] < DET_SCORE_MIN
            or quality["faceBoxRatio"] < MIN_FACE_BOX_RATIO
            or quality["faceBoxRatio"] > MAX_FACE_BOX_RATIO
        ):
            return {
                "success": False,
                "error": "Face is outside capture guide.",
                "reason": "face_quality_failed",
                "faceCount": 1,
                "modelVersion": MODEL_VERSION,
            }

        try:
            embedding = normalized_embedding(faces[0])
        except ValueError:
            return {
                "success": False,
                "error": "Face identity could not be measured.",
                "reason": "invalid_face_embedding",
                "faceCount": 1,
                "modelVersion": MODEL_VERSION,
            }
        blink = (
            blendshape_score(landmarks, "eyeBlinkLeft")
            + blendshape_score(landmarks, "eyeBlinkRight")
        ) / 2.0
        metrics.append(
            {
                "frame": index,
                "blink": blink,
                "yaw": landmark_yaw_ratio(landmarks),
            }
        )
        images.append(image)
        embeddings.append(embedding)
        qualities.append(quality)

    adjacent_distances = [
        float(1.0 - np.dot(embeddings[index - 1], embeddings[index]))
        for index in range(1, len(embeddings))
    ]
    if adjacent_distances and max(adjacent_distances) > CONTINUITY_MAX_DISTANCE:
        return {
            "success": False,
            "error": "Face identity changed during challenge.",
            "reason": "face_changed_during_challenge",
            "faceCount": 1,
            "modelVersion": MODEL_VERSION,
        }

    try:
        action_results, representative_indices = evaluate_action_sequence(
            metrics,
            request.actions,
            center_yaw=CHALLENGE_CENTER_YAW,
            turn_yaw=CHALLENGE_TURN_YAW,
            blink_open_score=BLINK_OPEN_SCORE,
            blink_closed_score=BLINK_CLOSED_SCORE,
        )
    except ValueError as exc:
        return {
            "success": False,
            "error": "Requested actions were not completed in order.",
            "reason": str(exc),
            "faceCount": 1,
            "livenessPassed": False,
            "modelVersion": MODEL_VERSION,
        }

    anti_spoof = passive_anti_spoof(images)
    return {
        "success": True,
        "embeddings": [embedding.astype(float).tolist() for embedding in embeddings],
        "representativeIndices": representative_indices,
        "modelVersion": MODEL_VERSION,
        "faceCount": 1,
        "livenessPassed": True,
        "actionResults": action_results,
        "antiSpoof": anti_spoof,
        "quality": {
            "detectionScoreMin": min(q["detectionScore"] for q in qualities),
            "faceBoxRatioMin": min(q["faceBoxRatio"] for q in qualities),
            "faceBoxRatioMax": max(q["faceBoxRatio"] for q in qualities),
            "maxAdjacentIdentityDistance": max(adjacent_distances, default=0.0),
            "metrics": metrics,
        },
        "serviceLatencyMs": round((time.perf_counter() - started) * 1000),
    }
