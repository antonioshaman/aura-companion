"""
Gonka signing shim — a localhost OpenAI-compatible endpoint that forwards
chat/completions to the Gonka decentralized network, signing each request with
an ECDSA key via the `gonka-openai` SDK.

Why this exists (Option D, PLAN-aura-gonka-option-d.md, Task 12):
  Claude CLI  ->  LiteLLM (Anthropic<->OpenAI)  ->  THIS SHIM (signs)  ->  Gonka
LiteLLM's generic openai provider authenticates with a static bearer key; Gonka
needs a per-request ECDSA signature. This shim is the one custom piece: it accepts
plain OpenAI requests on 127.0.0.1 and does the signing internally.

Security contract (do NOT weaken):
  - GONKA_PRIVATE_KEY lives ONLY in this process's env. It is never logged,
    never returned, never placed in a response.
  - Binds 127.0.0.1 by default. Never expose off-box (see systemd/compose).
  - An optional SHIM_API_KEY gates callers (LiteLLM presents it as a bearer token)
    so nothing else on the host can drive the signing key.

This is an operator-run sidecar, deliberately OUTSIDE the Aura Bun/Hono stack and
outside Aura's systemd KillMode=process cgroup.
"""

from __future__ import annotations

import json
import os
from typing import Any, Iterator

from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse
from starlette.concurrency import run_in_threadpool

# gonka-openai==0.2.6 : `GonkaOpenAI` subclasses the OpenAI client and installs a
# signing fetch. It reads GONKA_* from the environment; we pass the ones we hold
# explicitly so construction is unambiguous.
from gonka_openai import GonkaOpenAI  # type: ignore

DEFAULT_MODEL = os.environ.get("GONKA_MODEL", "Qwen/Qwen3-235B-A22B-Instruct-2507-FP8")
SHIM_API_KEY = os.environ.get("SHIM_API_KEY")  # optional shared secret with LiteLLM

app = FastAPI(title="gonka-signing-shim", docs_url=None, redoc_url=None)

_client: GonkaOpenAI | None = None


def _build_client() -> GonkaOpenAI:
    """Construct the signing client from env. Fail loudly if the key is absent."""
    private_key = os.environ.get("GONKA_PRIVATE_KEY")
    if not private_key:
        raise RuntimeError("GONKA_PRIVATE_KEY is not set — the shim cannot sign requests")
    source_url = os.environ.get("GONKA_SOURCE_URL")
    endpoints = os.environ.get("GONKA_ENDPOINTS")
    if not source_url and not endpoints:
        raise RuntimeError("Set GONKA_SOURCE_URL or GONKA_ENDPOINTS so endpoints can be resolved")
    kwargs: dict[str, Any] = {"api_key": "mock-api-key", "gonka_private_key": private_key}
    if source_url:
        kwargs["source_url"] = source_url
    # GONKA_ENDPOINTS / GONKA_ADDRESS / GONKA_VERIFY_PROOF are read from env by the SDK.
    return GonkaOpenAI(**kwargs)


def _client_or_503() -> GonkaOpenAI:
    global _client
    if _client is None:
        _client = _build_client()
    return _client


def _check_auth(authorization: str | None) -> None:
    """If a shared secret is configured, require it. Never echo it."""
    if not SHIM_API_KEY:
        return
    expected = f"Bearer {SHIM_API_KEY}"
    if authorization != expected:
        raise HTTPException(status_code=401, detail="unauthorized")


@app.get("/health")
async def health() -> JSONResponse:
    """Liveness + reachability. Building the client resolves endpoints from GONKA_SOURCE_URL."""
    try:
        await run_in_threadpool(_client_or_503)
        return JSONResponse({"status": "ok", "model": DEFAULT_MODEL})
    except Exception as exc:  # noqa: BLE001 - operational error, report cleanly, no secret
        return JSONResponse({"status": "error", "reason": type(exc).__name__}, status_code=503)


@app.get("/v1/models")
async def list_models(authorization: str | None = Header(default=None)) -> JSONResponse:
    _check_auth(authorization)
    return JSONResponse(
        {"object": "list", "data": [{"id": DEFAULT_MODEL, "object": "model", "owned_by": "gonka"}]}
    )


@app.post("/v1/chat/completions")
async def chat_completions(
    request: Request, authorization: str | None = Header(default=None)
) -> Any:
    _check_auth(authorization)
    try:
        body: dict[str, Any] = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="invalid JSON body")
    if not isinstance(body, dict) or "messages" not in body:
        raise HTTPException(status_code=400, detail="missing 'messages'")
    body.setdefault("model", DEFAULT_MODEL)
    stream = bool(body.get("stream", False))

    try:
        client = _client_or_503()
    except Exception as exc:  # noqa: BLE001
        return JSONResponse(
            {"error": {"message": f"shim not ready: {type(exc).__name__}", "type": "shim_unavailable"}},
            status_code=503,
        )

    if not stream:
        try:
            resp = await run_in_threadpool(lambda: client.chat.completions.create(**body))
        except Exception as exc:  # noqa: BLE001 - upstream/operational error
            return JSONResponse(
                {"error": {"message": f"upstream error: {type(exc).__name__}", "type": "upstream_error"}},
                status_code=502,
            )
        return JSONResponse(json.loads(resp.model_dump_json()))

    def event_stream() -> Iterator[bytes]:
        # Starlette runs this sync generator in a threadpool; the openai stream is a sync iterator.
        try:
            gonka_stream = client.chat.completions.create(**body)
            for chunk in gonka_stream:
                yield f"data: {chunk.model_dump_json()}\n\n".encode()
        except Exception as exc:  # noqa: BLE001 - surface mid-stream failure, never fake completion
            err = {"error": {"message": f"stream error: {type(exc).__name__}", "type": "upstream_error"}}
            yield f"data: {json.dumps(err)}\n\n".encode()
        finally:
            yield b"data: [DONE]\n\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream")
