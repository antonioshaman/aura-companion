# Signing shim image. secp256k1 (a gonka-openai dep) builds from source, so the
# build stage needs C toolchain + libsecp256k1 headers.
FROM python:3.12-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential pkg-config libsecp256k1-dev automake libtool \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir --prefix=/install -r requirements.txt

FROM python:3.12-slim
# libsecp256k1 runtime lib only (no compiler in the final image).
RUN apt-get update && apt-get install -y --no-install-recommends libsecp256k1-1 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /install /usr/local
WORKDIR /app
COPY gonka_shim.py .
# Non-root.
RUN useradd -r -u 10001 gonka && chown -R gonka /app
USER gonka
EXPOSE 8080
# Secrets come from env at runtime (never ENV/ARG). Bind loopback inside the
# container; compose maps it to 127.0.0.1 on the host only.
CMD ["uvicorn", "gonka_shim:app", "--host", "0.0.0.0", "--port", "8080"]
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8080/health').status==200 else 1)"
