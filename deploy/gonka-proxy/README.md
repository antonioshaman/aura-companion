# Gonka proxy — operator companion stack (Option D)

This directory is the **operator-run** half of Option D: it lets Aura's Claude CLI
sessions talk to open-weight models on the **Gonka** decentralized network instead
of Anthropic, while keeping the CLI's tool loop, context, permission UX, and
Council observer exactly as they are.

```
Claude CLI ──Anthropic Messages──▶ LiteLLM ──OpenAI chat/completions──▶ gonka-shim ──signed──▶ Gonka
(Aura spawns it,                   (:4000, translates)                   (:8080, ECDSA-signs)   (Qwen/DeepSeek/Kimi)
 keeps tool loop)
```

**Design decisions baked in** (from the Council plan, `PLAN-aura-gonka-option-d.md`):
- **1i** — you (the operator) run this stack; Aura never holds `GONKA_PRIVATE_KEY`. The
  only secret Aura stores is `LITELLM_MASTER_KEY` (injected as `ANTHROPIC_AUTH_TOKEN`).
- Everything binds **127.0.0.1 only**. The signing wallet is never reachable off-box.
- This stack is **separate** from `aura-companion` — its own units, NOT inside Aura's
  `KillMode=process` cgroup.

## Contents

| Path | What |
|---|---|
| `shim/gonka_shim.py` | FastAPI OpenAI-compatible endpoint that signs via `gonka-openai` |
| `shim/requirements.txt` | Pinned deps (`gonka-openai==0.2.6` verified on PyPI) |
| `shim/Dockerfile` | Shim image (builds `secp256k1` from source) |
| `litellm/config.yaml` | Anthropic↔OpenAI translation, upstream = shim |
| `docker-compose.yml` | Both services, loopback-bound, healthchecked |
| `systemd/*.service` | Bare-metal/VPS units (loopback, hardened, TimeoutStopSec) |
| `.env.example` | Secret template (copy → `shim.env` / `litellm.env`, `chmod 600`) |
| `scripts/validate-task0.sh` | Go/no-go check of the whole chain |

## Quick start (Docker)

```bash
cd deploy/gonka-proxy
cp .env.example shim.env && cp .env.example litellm.env
chmod 600 shim.env litellm.env
# Edit both: put your Gonka key in shim.env (GONKA_PRIVATE_KEY + GONKA_SOURCE_URL),
# set the SAME random SHIM_API_KEY in both, and an sk- LITELLM_MASTER_KEY in litellm.env.
docker compose up -d
LITELLM_MASTER_KEY=sk-... ./scripts/validate-task0.sh
```

## Quick start (systemd / VPS)

See the install comments at the top of each unit file. In short: dedicated
`gonka-proxy` user, code in `/opt/gonka-proxy`, secrets in `/etc/gonka-proxy/*.env`
(mode 600), `pip install -r shim/requirements.txt 'litellm[proxy]'==<pin>` into a venv,
then `systemctl enable --now gonka-shim litellm-gonka`.

## Point Aura / the Claude CLI at it

For the spike, use an Aura **env profile** (`~/.companion/envs/`) or plain env when
launching `claude`:

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:4000
export ANTHROPIC_AUTH_TOKEN=$LITELLM_MASTER_KEY
claude --model gonka-qwen -p "Read package.json and tell me the version"
```

`--model` must equal a `model_name` in `litellm/config.yaml` (`gonka-qwen`).
Once first-class support lands (plan Tasks 1–8), this becomes a provider-profile
in the New Session picker instead of manual env.

## What is NOT here (by design)

- No `GONKA_PRIVATE_KEY` in Aura. It lives only in `shim.env`.
- No changes to Aura's app/image yet — that's the plan's Tasks 1–13.
- Multi-user distribution (per-user wallets) — deferred; if pursued, template the
  shim unit as `gonka-shim@<user>.service` (one key + loopback port per user).

## Safety checks before trusting it

- `ss -tlnp | grep -E ':8080|:4000'` → both MUST be `127.0.0.1` (not `0.0.0.0`).
- `grep -ri "$(cut -d= -f2 <<<"$(grep GONKA_PRIVATE_KEY shim.env)")" ~/.companion/recordings/` → MUST be empty.
- Rotate `LITELLM_MASTER_KEY` and `SHIM_API_KEY` if either ever appears in a log.

## Cost / reliability reality

Gonka broker prices are low but **subsidized and volatile** — re-measure, don't
assume the $10/mo target. Open-model **tool-calling reliability** over the
translation is the binding risk; the plan's Tasks 6/11 add detection + a success-rate
harness. Treat this as an experimental, cheaper line — not Claude parity.
