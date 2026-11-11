FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY marketlab_web ./marketlab_web
COPY tests ./tests
COPY pytest.ini ./

EXPOSE 8010
CMD ["python", "-m", "uvicorn", "marketlab_web.api:app", "--host", "0.0.0.0", "--port", "8010"]