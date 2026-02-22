# Aethelgard Web (Vercel + Supabase)

Web para venta de rangos de Minecraft con:
- Registro/Login por usuario y contraseña
- El usuario debe ser un nombre válido de Minecraft (3-16, letras/números/_)
- Enlace de pago externo configurable (PayPal/Tebex/etc.)
- Usuarios admin con activación gratis de rangos
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
- `SESSION_SECRET`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `ADMIN_TOKEN`
- `ADMIN_MINECRAFT_USERS` (lista separada por comas)
- `PAYMENT_LINK_TEMPLATE` (opcional)

## 3) Crear tablas en Supabase

En Supabase SQL Editor, ejecuta:
- `supabase-schema.sql`

## 4) Ejecutar local

```bash
npm run dev
```

Abrir: `http://localhost:3000`

## 5) Deploy en Vercel

En Vercel -> Project Settings -> Environment Variables, define:
- `BASE_URL`
- `SESSION_SECRET`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `ADMIN_TOKEN`
- `ADMIN_MINECRAFT_USERS`
- `PAYMENT_LINK_TEMPLATE` (opcional)

Luego redeploy.

## Endpoints clave

- `POST /auth/register` crea cuenta
- `POST /auth/login` inicia sesión
- `GET /auth/logout` cierra sesión
- `GET /api/session` estado de sesión
- `POST /api/payments` crea pago pendiente para usuario logeado
- `GET /api/payments/me` lista pagos del usuario
- `POST /api/admin/grant-rank` activa rango gratis para admins logeados
- `GET /api/admin/payments` (header `x-admin-token`)
- `POST /api/admin/payments/:id/mark-paid` (header `x-admin-token`)
