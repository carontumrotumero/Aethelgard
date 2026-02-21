# Aethelgard Web

Web para venta de rangos de Minecraft con:
- Login con cuenta de Minecraft (Microsoft OAuth + Xbox + Minecraft Services)
- Base de datos SQLite para registrar usuarios y pagos
- Historial de compras por jugador

## 1) Instalar

```bash
npm install
```

## 2) Configurar entorno

```bash
cp .env.example .env
```

Rellena en `.env`:
- `MS_CLIENT_ID`
- `MS_CLIENT_SECRET`
- `SESSION_SECRET`
- `ADMIN_TOKEN`

## 3) Configurar app de Microsoft

En Azure App Registration:
- Redirect URI web: `http://localhost:3000/auth/microsoft/callback`
- Scope solicitado por la app: `XboxLive.signin offline_access openid profile email`

## 4) Ejecutar

```bash
npm run dev
```

Abrir: `http://localhost:3000`

## Endpoints clave

- `GET /auth/microsoft` inicia login
- `GET /api/session` estado de sesión
- `POST /api/payments` crea pago pendiente para el usuario logeado
- `GET /api/payments/me` lista pagos del usuario
- `GET /api/admin/payments` (header `x-admin-token`)
- `POST /api/admin/payments/:id/mark-paid` (header `x-admin-token`)

## Nota de pasarela de pago

Actualmente el botón registra una compra en estado `pending`.
Para marcar pago real debes conectar Stripe/Tebex/PayPal por webhook y actualizar el pago a `paid`.
