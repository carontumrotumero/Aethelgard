# Aethelgard Web (Vercel + Supabase)

Web para venta de rangos de Minecraft con:
- Login con cuenta de Minecraft (Microsoft OAuth + Xbox + Minecraft Services)
- Base de datos remota en Supabase
- Backend serverless compatible con Vercel

## 1) Instalar

```bash
npm install
```

## 2) Configurar entorno local

```bash
cp .env.example .env
```

Completa en `.env`:
- `MS_CLIENT_ID`
- `MS_CLIENT_SECRET`
- `SESSION_SECRET`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `ADMIN_TOKEN`

## 3) Crear tablas en Supabase

En Supabase SQL Editor, ejecuta el contenido de:
- `supabase-schema.sql`

## 4) Configurar OAuth de Microsoft

En Azure App Registration:
- Redirect URI (local): `http://localhost:3000/auth/microsoft/callback`
- Redirect URI (producción): `https://TU_DOMINIO_VERCEL/auth/microsoft/callback`
- Scope: `XboxLive.signin offline_access openid profile email`

## 5) Ejecutar local

```bash
npm run dev
```

Abrir: `http://localhost:3000`

## 6) Deploy en Vercel

Sube el repo a GitHub y conecta el proyecto en Vercel.

En Vercel -> Project Settings -> Environment Variables, define:
- `BASE_URL` = `https://TU_DOMINIO_VERCEL`
- `MS_CLIENT_ID`
- `MS_CLIENT_SECRET`
- `MS_REDIRECT_URI` = `https://TU_DOMINIO_VERCEL/auth/microsoft/callback`
- `SESSION_SECRET`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `ADMIN_TOKEN`

El archivo `vercel.json` ya enruta todas las requests al backend serverless.

## Endpoints clave

- `GET /auth/microsoft` inicia login
- `GET /auth/microsoft/callback` callback OAuth
- `GET /auth/logout` cierra sesión
- `GET /api/session` estado de sesión
- `POST /api/payments` crea pago pendiente para el usuario logeado
- `GET /api/payments/me` lista pagos del usuario
- `GET /api/admin/payments` (header `x-admin-token`)
- `POST /api/admin/payments/:id/mark-paid` (header `x-admin-token`)

## Nota de pagos

Ahora se registra en Supabase con estado `pending`.
Para confirmación automática de pago real, conecta Stripe/Tebex/PayPal por webhook y actualiza a `paid`.
