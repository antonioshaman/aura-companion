# Spec: RU-хостинг пользовательского трафика (ТСПУ-обрыв ~16KB) — aura-companion

**Date:** 2026-10-16
**Status:** Done 2026-10-17 (auraco.space перенесён на Timeweb)
**Priority:** P1 — auraco.space (лендинг для русскоязычной аудитории) был на Cloudflare
**Source:** инцидент Rapesha_shop_bot 2026-10-14/15 (memory `feedback_miniapp_mounted_but_unstyled_css_link_failed`)

## Objective

Все поверхности, которые открывают пользователи из РФ, отдаются только с российского хоста;
регрессия ловится автоматически на деплое.

## Находки по этому проекту

Аудит 2026-10-16: nginx-конфиги обоих хостов + Bunny API (все A-записи) + резолв через Яндекс (77.88.8.8) и Google (8.8.8.8) + `curl --resolve` на Timeweb.

Первый аудит (2026-10-16) проверял только nginx и Bunny и ПРОПУСТИЛ главный RU-facing хост: **auraco.space** —
русскоязычный лендинг, отдавался Cloudflare Worker'ом (`landing-legacy/`, AAAA 100:: proxied). Урок: аудит RU-facing
хостов должен идти от списка доменов проекта (Cloudflare-зоны тоже), а не от nginx-конфигов.

**Сделано 2026-10-17:** сайт отдаётся с Timeweb `91.222.236.11` (nginx `/etc/nginx/sites-available/auraco.space.conf`,
`/var/www/auraco.space`, LE-сертификат через DNS-01 Cloudflare), DNS в CF-зоне — A-записи DNS-only (без orange), без AAAA.
Worker `auraco` оставлен только для превью (`wrangler versions upload`). Деплой — `landing-legacy/deploy-timeweb.sh`
с DNS-гейтом.

## Задачи

1. [x] Перенести auraco.space на Timeweb + DNS-гейт в деплое (`landing-legacy/deploy-timeweb.sh`).
2. [x] Добавить в CLAUDE.md проекта короткое правило: если появится сайт/Mini App/API для
   пользователей из РФ — только RU-хост (Timeweb или reverse-proxy через него), без geo-split и CF orange.

## Acceptance

- RU-facing хосты в авторитетном DNS резолвятся только в RU-IP (`91.222.236.11`), geo-split с
  зарубежной ногой выключен.
- [ ] Проверено с реального устройства в РФ (не с сервера) — владелец.
- Деплой падает при регрессии DNS (если у проекта есть RU-facing хосты).

---

## Письмо: что выяснили на Rapesha 2026-10-15 и почему это касается всех проектов

**Коротко:** российские пользователи **не могут нормально загрузить сайт/Mini App с зарубежного IP**
(Hetzner, Cloudflare, Vercel, Railway, GitHub Pages и т.п.). Всё, что открывают люди из РФ, должно
отдаваться с российского хоста (у нас — Timeweb `91.222.236.11`).

**Что происходит технически.** ТСПУ замораживает TCP-соединение из РФ к зарубежному IP после ~16KB
данных. Маленькое (HTML ~10KB, beacon'ы) проходит, CSS и JS-чанки — нет. Пользователь видит голую
страницу без стилей или бесконечный лоадер. Сервер при этом пишет в nginx `200` и полный размер —
по логам «всё отдано». Подпись на origin: `ss -tin dst <ip-клиента>` → `bytes_acked`≈16KB, дальше
`lost:N cwnd:1 backoff:N`.

**Замер (5 человек, iPhone/Mac/Android, с VPN и без), почти несжимаемые файлы:**

| origin | 16KB | 64KB | 256KB | 512KB |
|---|---|---|---|---|
| Timeweb (RU) | ✅ | ✅ | ✅ | ✅ — 40/40, 0.1–1.6с |
| Hetzner (DE) | ⚠️ первый файл | ❌ | ❌ | ❌ — у всех, чей трафик идёт напрямую из РФ |

**Ловушка geo-DNS.** Bunny Smart Records выбирают ногу по стране **DNS-резолвера**. У людей в РФ DNS
часто идёт через VPN → «иностранец» → зарубежная нога, а трафик Telegram/браузера идёт напрямую из РФ
мимо VPN → обрыв. Именно так 2026-10-15 упал Rapesha Mini App у владельца и клиентов. Geo-split с
зарубежной ногой для RU-аудитории **не использовать**.

**Что можно и что нельзя:**
- ✅ RU-хост (Timeweb) отдаёт всё сам или **reverse-proxy на зарубежный backend** (RU-сервер → зарубеж
  проходит; рабочий пример — Timeweb `course.rapesha.ru` → Hetzner).
- ✅ Зарубежные серверы, которые зовут нас сами (вебхуки Telegram, OpenAI-плагины), — не затронуты.
- ❌ Прямой зарубежный IP для пользовательского трафика из РФ, Cloudflare orange-cloud, geo-split.
- ⚠️ Проверки с нашего сервера/headless **этот баг не видят** — сервер не за ТСПУ. Проверять с
  реального устройства в РФ (см. ниже).

**Инструменты (готовые, брать из Rapesha_shop_bot):**
- Гейт в деплое: `Rapesha_shop_bot/deploy/deploy-spa-app.sh` §2.05 — деплой падает, если RU-facing
  хост в авторитетном DNS ведёт не на RU-IP. Скопировать с заменой списка хостов.
- Тест доставки с устройства: `deploy/sizetest/gen.py` + `https://app.rapesha.ru/sizetest.html`
  (результаты — в nginx access-log по `diag=sizetest`).
- DNS: Bunny API, ключ `/etc/bunny/api.key` на Hetzner; включить/выключить ногу —
  `POST https://api.bunny.net/dnszone/<zone>/records/<id>` body `{"Disabled":true|false}`.
- Правило «JS-чанк ≤12KB» было ложной атрибуцией этого же обрыва — режется сумма байт на соединение,
  мелкая нарезка не спасает. Достаточно разумного бюджета (Rapesha: ≤64KB).

Глобальное правило: `/root/.claude/CLAUDE.md` → «RU payment paths…» + «Extended 2026-10-15».

