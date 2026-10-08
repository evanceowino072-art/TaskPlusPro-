# TaskPlusPro connected package

This package connects the TPP v3 frontend to the TPP API and Supabase Auth/database foundation.

## Setup

1. Create a Supabase project.
1. Run `taskpluspro_backend_schema.sql` in the Supabase SQL editor.
1. Copy `.env`. phone number 0112159163 Id 871614681to `.env` and add server-side credentials.
1. Set `TPP_SUPABASE_URL`, `TPP_SUPABASE_ANON_KEY`, and optionally `TPP_API_BASE` as browser configuration when deploying the frontend, or inject them before serving the HTML.
1. Run `npm install` then `npm start`.
1. Open the server URL. The server serves `taskpluspro_tpp_v3.html` and `/api/*`.

## Important

* Never put `SUPABASE_SERVICE_ROLE_KEY`, payment secrets, M-Pesa passkey, SMTP password, or JWT secret in browser code.
* The $5 membership transaction endpoint is connected, but payment-provider webhook verification must be configured with real provider credentials before money is accepted or membership is activated.
* Test payments in sandbox before production.
