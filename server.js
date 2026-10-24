const express = require("express");
const path = require("path");
const fs = require("fs");
const { createClient } = require("@supabase/supabase-js");

const app = express();
const PORT = process.env.PORT || 3000;
const WEBSITE_FILE = path.join(__dirname, "taskpluspro_tpp_website.html");

const PAYMENT_AMOUNT_KES = 1;
const PAYMENT_ENVIRONMENT = "sandbox";
const DARAJA_BASE_URL = "https://sandbox.safaricom.co.ke";

app.disable("x-powered-by");
app.use(express.json({ limit: "100kb" }));

// Basic security headers
app.use((_req, res, next) => {
res.setHeader("X-Content-Type-Options", "nosniff");
res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
res.setHeader("X-Frame-Options", "SAMEORIGIN");
next();
});

// Server-only Supabase admin client.
// NEVER send SUPABASE_SERVICE_ROLE_KEY to the browser.
function getAdminClient() {
const url = process.env.TPP_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key) {
const error = new Error("Server Supabase configuration is missing.");
error.status = 503;
throw error;
}

return createClient(url, key, {
auth: {
persistSession: false,
autoRefreshToken: false
}
});
}

// Validate the member's Supabase access token.
async function getAuthenticatedUser(req) {
const header = req.get("Authorization") || "";
const match = header.match(/^Bearer\s+(.+)$/i);

if (!match) {
const error = new Error("Please sign in first.");
error.status = 401;
throw error;
}

const admin = getAdminClient();
const { data, error } = await admin.auth.getUser(match[1]);

if (error || !data?.user) {
const authError = new Error("Your session is invalid. Sign in again.");
authError.status = 401;
throw authError;
}

return { admin, user: data.user };
}

function normalizeKenyanPhone(value) {
let phone = String(value || "").replace(/[\s()-]/g, "");

if (phone.startsWith("+")) phone = phone.slice(1);
if (phone.startsWith("0")) phone = "254" + phone.slice(1);

if (!/^254[17]\d{8}$/.test(phone)) {
const error = new Error(
"Enter a valid Kenyan mobile number, e.g. 0712345678."
);
error.status = 400;
throw error;
}

return phone;
}

function darajaTimestamp() {
const parts = new Intl.DateTimeFormat("en-GB", {
timeZone: "Africa/Nairobi",
year: "numeric",
month: "2-digit",
day: "2-digit",
hour: "2-digit",
minute: "2-digit",
second: "2-digit",
hourCycle: "h23"
}).formatToParts(new Date());

const values = {};

for (const part of parts) {
if (part.type !== "literal") values[part.type] = part.value;
}

return (
values.year +
values.month +
values.day +
values.hour +
values.minute +
values.second
);
}

function darajaPassword(shortcode, passkey, timestamp) {
return Buffer.from(shortcode + passkey + timestamp).toString("base64");
}

function requireSandboxConfig() {
if (process.env.MPESA_ENV !== "sandbox") {
const error = new Error("Membership payments are restricted to sandbox.");
error.status = 503;
throw error;
}

const shortcode = process.env.MPESA_SHORTCODE;
const passkey = process.env.MPESA_PASSKEY;
const callbackUrl = process.env.MPESA_CALLBACK_URL;

if (!shortcode || !passkey || !callbackUrl) {
const error = new Error("Daraja sandbox configuration is incomplete.");
error.status = 503;
throw error;
}

let parsedUrl;

try {
parsedUrl = new URL(callbackUrl);
} catch {
const error = new Error("The M-Pesa callback URL is invalid.");
error.status = 503;
throw error;
}

if (
parsedUrl.protocol !== "https:" ||
parsedUrl.hostname !== "taskpluspro.onrender.com" ||
parsedUrl.pathname !== "/api/mpesa/callback"
) {
const error = new Error(
"The sandbox callback must use the approved TaskPlusPro HTTPS callback URL."
);
error.status = 503;
throw error;
}

return { shortcode, passkey, callbackUrl };
}


async function getDarajaToken() {
  const key = process.env.MPESA_CONSUMER_KEY;
  const secret = process.env.MPESA_CONSUMER_SECRET;

  if (!key || !secret) {
    const error = new Error(
      "Daraja sandbox credentials are not configured."
    );
    error.status = 503;
    throw error;
  }

  const response = await fetch(
    `${DARAJA_BASE_URL}/oauth/v1/generate?grant_type=client_credentials`,
    {
      headers: {
        Authorization:
          "Basic " + Buffer.from(`${key}:${secret}`).toString("base64")
      },
      signal: AbortSignal.timeout(15000)
    }
  );

  const data = await response.json().catch(() => ({}));

  if (!response.ok || !data.access_token) {
    throw new Error("Daraja sandbox authentication failed.");
  }

  return data.access_token;
}
{
const key = process.env.MPESA_CONSUMER_KEY;
const secret = process.env.MPESA_CONSUMER_SECRET;

if (!key || !secret) {
const error = new Error("Daraja sandbox credentials are not configured.");
error.status = 503;
throw error;
}

const response = await fetch(
"${DARAJA_BASE_URL}/oauth/v1/generate?grant_type=client_credentials",
{
headers: {
Authorization:
"Basic " + Buffer.from("${key}:${secret}").toString("base64")
},
signal: AbortSignal.timeout(15000)
}
);

const data = await response.json().catch(() => ({}));

if (!response.ok || !data.access_token) {
throw new Error("Daraja sandbox authentication failed.");
}

return data.access_token;
}

// -----------------------------------------------------
// HEALTH, DIAGNOSTICS AND SAFE ROUTE CHECKS
// -----------------------------------------------------

app.get("/api/health", (_req, res) => {
res.set("Cache-Control", "no-store");
res.json({
ok: true,
service: "TaskPlusPro",
status: "online",
timestamp: new Date().toISOString()
});
});

// Safe test: GET only; this never sends an STK Push.
app.get("/api/payment-route-check", (_req, res) => {
res.set("Cache-Control", "no-store");
res.json({
ok: true,
service: "TaskPlusPro",
paymentRouteRegistered: true,
paymentMode: "sandbox",
stkPushEnabled:
process.env.TPP_ENABLE_SANDBOX_STK_PUSH === "true",
note: "Diagnostic only. No payment was initiated."
});
});

// Public browser configuration: publishable/anon key only.
app.get("/api/config", (_req, res) => {
res.set("Cache-Control", "no-store");

const url = process.env.TPP_SUPABASE_URL;
const key = process.env.TPP_SUPABASE_ANON_KEY;

if (!url || !key) {
return res.status(503).json({
ok: false,
message: "Supabase browser configuration is missing."
});
}

res.json({ supabaseUrl: url, supabaseKey: key });
});

// Report whether required variables exist, never their values.
app.get("/api/diagnostics", (_req, res) => {
res.set("Cache-Control", "no-store");

res.json({
ok: true,
service: "TaskPlusPro",
checks: {
websiteFileExists: fs.existsSync(WEBSITE_FILE),
supabaseUrlConfigured: Boolean(process.env.TPP_SUPABASE_URL),
supabaseAnonKeyConfigured: Boolean(process.env.TPP_SUPABASE_ANON_KEY),
serviceRoleConfigured: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
darajaConsumerKeyConfigured: Boolean(process.env.MPESA_CONSUMER_KEY),
darajaConsumerSecretConfigured: Boolean(process.env.MPESA_CONSUMER_SECRET),
darajaPasskeyConfigured: Boolean(process.env.MPESA_PASSKEY),
darajaShortcodeConfigured: Boolean(process.env.MPESA_SHORTCODE),
darajaCallbackConfigured: Boolean(process.env.MPESA_CALLBACK_URL),
mpesaEnvironment: process.env.MPESA_ENV || "not-set",
sandboxStkPushEnabled:
process.env.TPP_ENABLE_SANDBOX_STK_PUSH === "true"
},
note: "These checks confirm presence only, not that credentials or payments work."
});
});

// -----------------------------------------------------
// MEMBERSHIP PAYMENT ROUTE
// DISABLED unless TPP_ENABLE_SANDBOX_STK_PUSH=true.
// The only permitted test amount is KSh 1.
// -----------------------------------------------------

app.post("/api/membership/pay", async (req, res) => {
res.set("Cache-Control", "no-store");

// Important: testing this route while disabled cannot send an STK Push.
if (process.env.TPP_ENABLE_SANDBOX_STK_PUSH !== "true") {
return res.status(503).json({
ok: false,
paymentStatus: "disabled",
message: "Sandbox payment initiation is currently disabled."
});
}

let admin;
let attemptId;

try {
const auth = await getAuthenticatedUser(req);
admin = auth.admin;
const user = auth.user;

const { shortcode, passkey, callbackUrl } = requireSandboxConfig();
const phone = normalizeKenyanPhone(req.body?.phone);

const { data: profile, error: profileError } = await admin
  .from("profiles")
  .select("id, membership_paid, account_status")
  .eq("id", user.id)
  .maybeSingle();

if (profileError) throw profileError;

if (!profile) {
  return res.status(409).json({
    ok: false,
    message: "Your member profile was not found."
  });
}

if (profile.membership_paid === true) {
  return res.status(409).json({
    ok: false,
    message: "Membership is already marked as paid."
  });
}

// Do not create repeated simultaneous pending requests.
const { data: pending, error: pendingError } = await admin
  .from("membership_payment_attempts")
  .select("id")
  .eq("user_id", user.id)
  .eq("environment", PAYMENT_ENVIRONMENT)
  .eq("status", "pending")
  .limit(1);

if (pendingError) throw pendingError;

if (pending?.length) {
  return res.status(409).json({
    ok: false,
    message:
      "A sandbox payment request is already pending. Check its status before trying again."
  });
}

// Never accept the amount or user ID from the browser.
const { data: attempt, error: insertError } = await admin
  .from("membership_payment_attempts")
  .insert({
    user_id: user.id,
    amount_kes: PAYMENT_AMOUNT_KES,
    environment: PAYMENT_ENVIRONMENT,
    status: "pending",
    phone_number: phone
  })
  .select("id")
  .single();

if (insertError) throw insertError;
attemptId = attempt.id;

const token = await getDarajaToken();
const timestamp = darajaTimestamp();

const payload = {
  BusinessShortCode: shortcode,
  Password: darajaPassword(shortcode, passkey, timestamp),
  Timestamp: timestamp,
  TransactionType:
    process.env.MPESA_TRANSACTION_TYPE || "CustomerPayBillOnline",
  Amount: PAYMENT_AMOUNT_KES,
  PartyA: phone,
  PartyB: shortcode,
  PhoneNumber: phone,
  CallBackURL: callbackUrl,
  AccountReference: "TPP-MEMBER",
  TransactionDesc: "TPP Sandbox Test"
};

const response = await fetch(
  `${DARAJA_BASE_URL}/mpesa/stkpush/v1/processrequest`,
  {
    method: "POST",
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(20000)
  }
);

const result = await response.json().catch(() => ({}));

if (
  !response.ok ||
  String(result.ResponseCode) !== "0" ||
  !result.CheckoutRequestID ||
  !result.MerchantRequestID
) {
  await admin
    .from("membership_payment_attempts")
    .update({
      status: "failed",
      callback_result_description: "Daraja did not accept the request."
    })
    .eq("id", attemptId);

  return res.status(502).json({
    ok: false,
    message: "Daraja did not accept the sandbox payment request."
  });
}

const { error: updateError } = await admin
  .from("membership_payment_attempts")
  .update({
    merchant_request_id: result.MerchantRequestID,
    checkout_request_id: result.CheckoutRequestID,
    stk_timestamp: timestamp
  })
  .eq("id", attemptId);

if (updateError) {
  console.error("Checkout ID save failed for attempt:", attemptId);

  return res.status(500).json({
    ok: false,
    message:
      "The request may have reached Daraja, but its status could not be saved. Do not retry repeatedly; check server logs."
  });
}

return res.status(202).json({
  ok: true,
  message:
    "Sandbox request accepted. Membership remains inactive until payment is independently verified.",
  paymentStatus: "pending"
});

} catch (error) {
if (attemptId && admin) {
const { error: updateError } = await admin
.from("membership_payment_attempts")
.update({
status: "failed",
callback_result_description: "Payment initiation error."
})
.eq("id", attemptId);

  if (updateError) {
    console.error("Could not update failed attempt:", attemptId);
  }
}

console.error("TPP sandbox payment initiation error:", error.message);

return res.status(error.status || 500).json({
  ok: false,
  message: error.status
    ? error.message
    : "Could not initiate the sandbox request. Check server logs."
});

}
});

// -----------------------------------------------------
// M-PESA CALLBACK
// Records callback results but DOES NOT activate membership.
// A callback alone is not independent proof of payment.
// -----------------------------------------------------

app.post("/api/mpesa/callback", async (req, res) => {
// Acknowledge callbacks safely; do not reveal internal details.
try {
const callback = req.body?.Body?.stkCallback;

if (!callback?.CheckoutRequestID) {
  return res.status(200).json({
    ResultCode: 0,
    ResultDesc: "Received"
  });
}

const admin = getAdminClient();

const { data: attempt, error: findError } = await admin
  .from("membership_payment_attempts")
  .select("*")
  .eq("checkout_request_id", callback.CheckoutRequestID)
  .maybeSingle();

if (findError) throw findError;

if (!attempt || attempt.environment !== PAYMENT_ENVIRONMENT) {
  return res.status(200).json({
    ResultCode: 0,
    ResultDesc: "Received"
  });
}

if (attempt.status === "verified" || attempt.status === "failed") {
  return res.status(200).json({
    ResultCode: 0,
    ResultDesc: "Received"
  });
}

if (Number(callback.ResultCode) !== 0) {
  await admin
    .from("membership_payment_attempts")
    .update({
      status: "failed",
      callback_result_code: Number(callback.ResultCode),
      callback_result_description:
        String(callback.ResultDesc || "Payment failed").slice(0, 500)
    })
    .eq("id", attempt.id)
    .eq("status", "pending");

  return res.status(200).json({
    ResultCode: 0,
    ResultDesc: "Received"
  });
}

const items = callback.CallbackMetadata?.Item || [];
const metadata = Object.fromEntries(
  items.map(item => [item.Name, item.Value])
);

const amount = Number(metadata.Amount);
const receipt = String(metadata.MpesaReceiptNumber || "");
const phone = String(metadata.PhoneNumber || "");

// Check callback details against the original server-side attempt.
if (
  amount !== PAYMENT_AMOUNT_KES ||
  attempt.amount_kes !== PAYMENT_AMOUNT_KES ||
  !receipt ||
  phone !== attempt.phone_number
) {
  console.error("TPP callback metadata mismatch for attempt:", attempt.id);

  await admin
    .from("membership_payment_attempts")
    .update({
      callback_result_description:
        "Callback received; metadata requires independent reconciliation."
    })
    .eq("id", attempt.id);

  return res.status(200).json({
    ResultCode: 0,
    ResultDesc: "Received"
  });
}

// Record callback details only. Do not mark verified or activate a profile.
const { error: updateError } = await admin
  .from("membership_payment_attempts")
  .update({
    status: "callback_received",
    mpesa_receipt_number: receipt,
    callback_result_code: 0,
    callback_result_description:
      "Success callback received; independent payment verification is still required."
  })
  .eq("id", attempt.id)
  .eq("status", "pending");

if (updateError) throw updateError;

console.log(
  "TPP callback recorded; manual/independent reconciliation required for attempt:",
  attempt.id
);

} catch (error) {
console.error("TPP callback processing error:", error.message);
}

return res.status(200).json({
ResultCode: 0,
ResultDesc: "Received"
});
});

// -----------------------------------------------------
// SIGNED-IN MEMBER: VIEW THEIR OWN LATEST PAYMENT STATUS
// -----------------------------------------------------

app.get("/api/membership/payment-status", async (req, res) => {
res.set("Cache-Control", "no-store");

try {
const { admin, user } = await getAuthenticatedUser(req);

const { data, error } = await admin
  .from("membership_payment_attempts")
  .select("amount_kes, status, created_at, mpesa_receipt_number")
  .eq("user_id", user.id)
  .order("created_at", { ascending: false })
  .limit(1)
  .maybeSingle();

if (error) throw error;

return res.json({
  ok: true,
  payment: data || null
});

} catch (error) {
return res.status(error.status || 500).json({
ok: false,
message: error.status
? error.message
: "Could not load payment status."
});
}
});

// -----------------------------------------------------
// WEBSITE ROUTES
// -----------------------------------------------------

app.get("/", (_req, res) => {
res.sendFile(WEBSITE_FILE, error => {
if (error && !res.headersSent) {
console.error("Homepage error:", error.message);
res.status(500).send(
"Homepage missing. Check taskpluspro_tpp_website.html."
);
}
});
});

app.get("/taskpluspro_tpp_website.html", (_req, res) => {
res.sendFile(WEBSITE_FILE);
});

// IMPORTANT: keep these 404 handlers AFTER all API routes.
app.use("/api", (_req, res) => {
res.status(404).json({
ok: false,
message: "API route not found."
});
});

app.use((_req, res) => {
res.status(404).send("Page not found.");
});

app.listen(PORT, "0.0.0.0", () => {
console.log("TaskPlusPro listening on port ${PORT}");
});
