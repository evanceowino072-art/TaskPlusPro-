
const express = require("express");
const path = require("path");
const fs = require("fs");
const { createClient } = require("@supabase/supabase-js");

const app = express();
const PORT = process.env.PORT || 3000;
const WEBSITE_FILE = path.join(
  __dirname,
  "taskpluspro_tpp_website.html"
);

app.disable("x-powered-by");
app.use(express.json({ limit: "100kb" }));

// Basic security headers
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader(
    "Referrer-Policy",
    "strict-origin-when-cross-origin"
  );
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  next();
});

// Server-only Supabase admin client.
// Never expose SUPABASE_SERVICE_ROLE_KEY to the browser.
function getAdminClient() {
  const url = process.env.TPP_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error("Server Supabase configuration is missing.");
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

  if (error || !data || !data.user) {
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
    throw new Error(
      "Enter a valid Kenyan mobile number, e.g. 0712345678."
    );
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

  return values.year + values.month + values.day +
    values.hour + values.minute + values.second;
}

function darajaPassword(shortcode, passkey, timestamp) {
  return Buffer.from(shortcode + passkey + timestamp).toString("base64");
}

async function getDarajaToken() {
  const key = process.env.MPESA_CONSUMER_KEY;
  const secret = process.env.MPESA_CONSUMER_SECRET;

  if (!key || !secret) {
    throw new Error("Daraja sandbox credentials are not configured.");
  }

  const response = await fetch(
    "https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials",
    {
      headers: {
        Authorization:
          "Basic " + Buffer.from(key + ":" + secret).toString("base64")
      }
    }
  );

  const data = await response.json();

  if (!response.ok || !data.access_token) {
    throw new Error("Could not authenticate with Daraja sandbox.");
  }

  return data.access_token;
}

function requireSandboxConfig() {
  if (process.env.MPESA_ENV !== "sandbox") {
    throw new Error("Membership payments are restricted to sandbox.");
  }

  const shortcode = process.env.MPESA_SHORTCODE;
  const passkey = process.env.MPESA_PASSKEY;
  const callbackUrl = process.env.MPESA_CALLBACK_URL;

  if (!shortcode || !passkey || !callbackUrl) {
    throw new Error("Daraja sandbox configuration is incomplete.");
  }

  const parsedUrl = new URL(callbackUrl);
  if (parsedUrl.protocol !== "https:") {
    throw new Error("The M-Pesa callback URL must use HTTPS.");
  }

  return { shortcode, passkey, callbackUrl };
}

// Health check
app.get("/api/health", (_req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({
    ok: true,
    service: "TaskPlusPro",
    status: "online",
    timestamp: new Date().toISOString()
  });
});

// Public Supabase browser configuration
app.get("/api/config", (_req, res) => {
  const url = process.env.TPP_SUPABASE_URL;
  const key = process.env.TPP_SUPABASE_ANON_KEY;

  res.set("Cache-Control", "no-store");

  if (!url || !key) {
    return res.status(503).json({
      ok: false,
      message: "Supabase browser configuration is missing."
    });
  }

  res.json({ supabaseUrl: url, supabaseKey: key });
});

// Diagnostics: presence only, never returns secret values
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
      mpesaEnvironment: process.env.MPESA_ENV || "not-set"
    },
    note: "Presence checks do not prove credentials or payments work."
  });
});

// SANDBOX ONLY: initiate a fixed KSh 1 membership test payment.
app.post("/api/membership/pay", async (req, res) => {
  res.set("Cache-Control", "no-store");

  let admin;
  let attemptId;

  try {
    const auth = await getAuthenticatedUser(req);
    admin = auth.admin;
    const user = auth.user;

    const { shortcode, passkey, callbackUrl } = requireSandboxConfig();
    const phone = normalizeKenyanPhone(req.body.phone);

    // Confirm the member has a profile and is not already active.
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

    // Never accept an amount or user ID from the browser.
    const amountKes = 1;

    const { data: attempt, error: insertError } = await admin
      .from("membership_payment_attempts")
      .insert({
        user_id: user.id,
        amount_kes: amountKes,
        environment: "sandbox",
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
      Amount: amountKes,
      PartyA: phone,
      PartyB: shortcode,
      PhoneNumber: phone,
      CallBackURL: callbackUrl,
      AccountReference: "TPP-MEMBER",
      TransactionDesc: "TPP Sandbox"
    };

    const response = await fetch(
      "https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer " + token,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
      }
    );

    const result = await response.json();

    if (
      !response.ok ||
      result.ResponseCode !== "0" ||
      !result.CheckoutRequestID ||
      !result.MerchantRequestID
    ) {
      await admin
        .from("membership_payment_attempts")
        .update({
          status: "failed",
          callback_result_description: "STK request was rejected."
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
      console.error("Could not save checkout ID for attempt:", attemptId);
      // Do not report a completed payment.
      return res.status(500).json({
        ok: false,
        message: "The request was sent, but its status could not be saved. Do not retry repeatedly; contact support."
      });
    }

    return res.status(202).json({
      ok: true,
      message: "Sandbox STK request accepted. Complete the prompt if one appears; membership is not active yet.",
      paymentStatus: "pending"
    });
  } catch (error) {
    if (attemptId && admin) {
      await admin
        .from("membership_payment_attempts")
        .update({
          status: "failed",
          callback_result_description: "Payment initiation error."
        })
        .eq("id", attemptId);
    }

    console.error("TPP sandbox payment initiation failed:", error.message);

    return res.status(error.status || 500).json({
      ok: false,
      message: error.status
        ? error.message
        : "Could not initiate the sandbox payment. Check server configuration and logs."
    });
  }
});

// Daraja callback: match the stored checkout request and verify via STK Query.
app.post("/api/mpesa/callback", async (req, res) => {
  // Respond safely even if a callback is malformed. Never trust it alone.
  try {
    const callback = req.body?.Body?.stkCallback;

    if (!callback?.CheckoutRequestID) {
      return res.status(200).json({ ResultCode: 0, ResultDesc: "Received" });
    }

    const admin = getAdminClient();

    const { data: attempt, error: findError } = await admin
      .from("membership_payment_attempts")
      .select("*")
      .eq("checkout_request_id", callback.CheckoutRequestID)
      .maybeSingle();

    if (findError) throw findError;

    if (!attempt || attempt.environment !== "sandbox") {
      return res.status(200).json({ ResultCode: 0, ResultDesc: "Received" });
    }

    // Idempotency: do not process a completed attempt again.
    if (attempt.status === "verified" || attempt.status === "failed") {
      return res.status(200).json({ ResultCode: 0, ResultDesc: "Received" });
    }

    if (Number(callback.ResultCode) !== 0) {
      await admin
        .from("membership_payment_attempts")
        .update({
          status: "failed",
          callback_result_code: Number(callback.ResultCode),
          callback_result_description: String(callback.ResultDesc || "Payment failed").slice(0, 500)
        })
        .eq("id", attempt.id);

      return res.status(200).json({ ResultCode: 0, ResultDesc: "Received" });
    }

    await admin
      .from("membership_payment_attempts")
      .update({
        status: "callback_received",
        callback_result_code: 0,
        callback_result_description: String(callback.ResultDesc || "").slice(0, 500)
      })
      .eq("id", attempt.id);

    const items = callback.CallbackMetadata?.Item || [];
    const metadata = Object.fromEntries(
      items.map(item => [item.Name, item.Value])
    );

    const amount = Number(metadata.Amount);
    const receipt = String(metadata.MpesaReceiptNumber || "");
    const phone = String(metadata.PhoneNumber || "");

    // Verify against our fixed test amount and original member phone.
    if (
      amount !== 1 ||
      attempt.amount_kes !== 1 ||
      !receipt ||
      phone !== attempt.phone_number
    ) {
      console.error("TPP callback metadata mismatch for attempt:", attempt.id);
      return res.status(200).json({ ResultCode: 0, ResultDesc: "Received" });
    }

    const { shortcode, passkey } = requireSandboxConfig();
    const token = await getDarajaToken();
    const timestamp = darajaTimestamp();

    const queryResponse = await fetch(
      "https://sandbox.safaricom.co.ke/mpesa/stkpushquery/v1/query",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer " + token,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          BusinessShortCode: shortcode,
          Password: darajaPassword(shortcode, passkey, timestamp),
          Timestamp: timestamp,
          CheckoutRequestID: attempt.checkout_request_id
        })
      }
    );

    const queryResult = await queryResponse.json();

    // A successful HTTP response alone is not proof of a completed payment.
    if (
      !queryResponse.ok ||
      String(queryResult.ResultCode) !== "0" ||
      queryResult.CheckoutRequestID !== attempt.checkout_request_id
    ) {
      console.warn("TPP payment awaits successful STK Query verification:", attempt.id);
      return res.status(200).json({ ResultCode: 0, ResultDesc: "Received" });
    }

    // Store verified payment before activating the matching profile.
    const { data: updated, error: paymentUpdateError } = await admin
      .from("membership_payment_attempts")
      .update({
        status: "verified",
        mpesa_receipt_number: receipt,
        verified_at: new Date().toISOString(),
        callback_result_code: 0,
        callback_result_description: "STK Query verification succeeded."
      })
      .eq("id", attempt.id)
      .eq("status", "callback_received")
      .select("id")
      .maybeSingle();

    if (paymentUpdateError) throw paymentUpdateError;

    if (updated) {
      const { error: profileUpdateError } = await admin
        .from("profiles")
        .update({
          membership_paid: true,
          account_status: "active",
          updated_at: new Date().toISOString()
        })
        .eq("id", attempt.user_id);

      if (profileUpdateError) {
        // Payment stays verified; investigate and repair profile activation.
        console.error("Verified payment but profile activation failed:", attempt.id);
      }
    }
  } catch (error) {
    console.error("TPP callback processing error:", error.message);
  }

  return res.status(200).json({ ResultCode: 0, ResultDesc: "Received" });
});

// Signed-in member can check their own latest payment status.
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
      message: error.status ? error.message : "Could not load payment status."
    });
  }
});

// Homepage
app.get("/", (_req, res) => {
  res.sendFile(WEBSITE_FILE, err => {
    if (err && !res.headersSent) {
      console.error("Homepage error:", err.message);
      res.status(500).send(
        "Homepage missing. Check taskpluspro_tpp_website.html."
      );
    }
  });
});

// Explicit homepage file route
app.get("/taskpluspro_tpp_website.html", (_req, res) => {
  res.sendFile(WEBSITE_FILE);
});

// Unknown API routes
app.use("/api", (_req, res) => {
  res.status(404).json({
    ok: false,
    message: "API route not found."
  });
});

// Other unknown routes
app.use((_req, res) => {
  res.status(404).send("Page not found.");
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`TaskPlusPro listening on port ${PORT}`);
});
