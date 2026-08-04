FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential curl libglib2.0-0 libgl1 \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py challenge_state.py ./

ARG FACE_LANDMARKER_URL=https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task
ARG FACE_LANDMARKER_SHA256=64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff
RUN mkdir -p /app/models \
    && curl --fail --location --silent --show-error "$FACE_LANDMARKER_URL" \
      --output /app/models/face_landmarker.task \
    && echo "$FACE_LANDMARKER_SHA256  /app/models/face_landmarker.task" \
      | sha256sum --check --strict

EXPOSE 8001
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8001"]
