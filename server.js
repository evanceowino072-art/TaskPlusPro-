const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.json({ limit: "10kb" }));
// Health check
app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    service: "TaskPlusPro",
    status: "online"
  });
});

app.get("/api/auth-check", async (req, res) => {
  try {
const { createClient } = require("@supabase/supabase-js");

const supabaseAdmin = createClient(
  process.env.TPP_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    }
  }
);

app.post("/api/mpesa/stk-push", async (req, res) => {
  try {
app.post("/api/mpesa/callback", async (req, res) => {
  // Acknowledge the callback, but do not trust it as proof of payment.
  try {
    const callback = req.body?.Body?.stkCallback;

    if (!callback?.CheckoutRequestID) {
      return res.status(400).json({
        ResultCode: 1,
        ResultDesc: "Invalid callback payload"
      });
    }

    const resultCode = Number(callback.ResultCode);
    const description = String(
      callback.ResultDesc || "M-Pesa callback received"
    ).slice(0, 250);

    const metadata = callback.CallbackMetadata?.Item || [];
    const receipt = metadata.find(
      (item) => item.Name === "MpesaReceiptNumber"
    )?.Value;

    const { data: attempt, error: lookupError } =
      await supabaseAdmin
        .from("membership_payment_attempts")
        .select("id, status")
        .eq("checkout_request_id", callback.CheckoutRequestID)
        .eq("environment", "sandbox")
        .maybeSingle();

    if (lookupError) {
      console.error("Could not look up payment attempt.");
      return res.status(500).json({
        ResultCode: 1,
        ResultDesc: "Payment lookup failed"
      });
    }

    if (!attempt) {
      console.warn("Callback received for an unknown checkout.");
      return res.json({
        ResultCode: 0,
        ResultDesc: "Callback received"
      });
    }

    // Store the callback result only. Verification is a separate step.
    const { error: updateError } = await supabaseAdmin
      .from("membership_payment_attempts")
      .update({
        status: resultCode === 0 ? "callback_received" : "failed",
        callback_result_code: resultCode,
        callback_result_description: description,
        mpesa_receipt_number:
          resultCode === 0 && typeof receipt === "string"
            ? receipt
            : null,
        updated_at: new Date().toISOString()
      })
      .eq("id", attempt.id)
      .eq("environment", "sandbox")
      .in("status", ["pending", "callback_received"]);

    if (updateError) {
      console.error("Could not save callback result.");
      return res.status(500).json({
        ResultCode: 1,
        ResultDesc: "Callback could not be saved"
      });
    }

    return res.json({
      ResultCode: 0,
      ResultDesc: "Callback received"
    });
  } catch {
    console.error("M-Pesa callback processing failed.");
    return res.status(500).json({
      ResultCode: 1,
      ResultDesc: "Callback processing failed"
    })
      ;
  }
});
    // Enforce Sandbox mode and a fixed KES 1 test amount.
    if (process.env.MPESA_ENV !== "sandbox") {
      return res.status(503).json({
        ok: false,
        message: "Sandbox payments are not enabled."
      });
    }

    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ")
      ? authHeader.slice(7)
      : "";

    if (!token) {
      return res.status(401).json({
        ok: false,
        message: "Sign in first."
      });
    }

    const { data: authData, error: authError } =
      await supabaseAdmin.auth.getUser(token);

    if (authError || !authData.user) {
      return res.status(401).json({
        ok: false,
        message: "Your session is invalid or expired."
      });
    }

    const rawPhone = String(req.body?.phone || "").replace(/[\s+-]/g, "");
    let phone = rawPhone;

    if (/^0[17]\d{8}$/.test(phone)) {
      phone = "254" + phone.slice(1);
    } else if (/^[17]\d{8}$/.test(phone)) {
      phone = "254" + phone;
    }

    if (!/^254[17]\d{8}$/.test(phone)) {
      return res.status(400).json({
        ok: false,
        message: "Enter a valid Kenyan mobile number."
      });
    }

    const required = [
      "MPESA_CONSUMER_KEY",
      "MPESA_CONSUMER_SECRET",
      "MPESA_SHORTCODE",
      "MPESA_PASSKEY",
      "MPESA_CALLBACK_URL"
    ];

    if (required.some((name) => !process.env[name])) {
      return res.status(503).json({
        ok: false,
        message: "M-Pesa Sandbox configuration is incomplete."
      });
    }

    const timestamp = new Date()
      .toLocaleString("en-GB", {
        timeZone: "Africa/Nairobi",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false
      })
      .replace(/\D/g, "");

    // en-GB gives DDMMYYYY; Daraja requires YYYYMMDDHHmmss.
    const parts = timestamp.match(
      /^(\d{2})(\d{2})(\d{4})(\d{2})(\d{2})(\d{2})$/
    );

    if (!parts) {
      throw new Error("Could not create payment timestamp.");
    }

    const stkTimestamp =
      parts[3] + parts[2] + parts[1] +
      parts[4] + parts[5] + parts[6];

    const shortcode = process.env.MPESA_SHORTCODE;
    const password = Buffer.from(
      shortcode + process.env.MPESA_PASSKEY + stkTimestamp
    ).toString("base64");

    const basic = Buffer.from(
      process.env.MPESA_CONSUMER_KEY + ":" +
      process.env.MPESA_CONSUMER_SECRET
    ).toString("base64");

    const tokenResponse = await fetch(
      "https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials",
      {
        headers: { Authorization: "Basic " + basic }
      }
    );

    const tokenData = await tokenResponse.json();

    if (!tokenResponse.ok || !tokenData.access_token) {
      return res.status(502).json({
        ok: false,
        message: "Could not authenticate with M-Pesa Sandbox."
      });
    }

    // Save the attempt before sending the payment prompt.
    const { data: attempt, error: insertError } =
      await supabaseAdmin
        .from("membership_payment_attempts")
        .insert({
          user_id: authData.user.id,
          amount_kes: 1,
          environment: "sandbox",
          status: "pending",
          phone_number: phone,
          stk_timestamp: stkTimestamp
        })
        .select("id")
        .single();

    if (insertError) {
      console.error("Payment attempt could not be saved.");
      return res.status(500).json({
        ok: false,
        message: "Could not create a payment attempt."
      });
    }

    const stkResponse = await fetch(
      "https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer " + tokenData.access_token,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          BusinessShortCode: shortcode,
          Password: password,
          Timestamp: stkTimestamp,
          TransactionType: "CustomerPayBillOnline",
          Amount: 1,
          PartyA: phone,
          PartyB: shortcode,
          PhoneNumber: phone,
          CallBackURL: process.env.MPESA_CALLBACK_URL,
          AccountReference: "TPP-" + attempt.id.slice(0, 10),
          TransactionDesc: "TPP Sandbox test"
        })
      }
    );

    const stkData = await stkResponse.json();

    if (
      !stkResponse.ok ||
      !stkData.CheckoutRequestID ||
      !stkData.MerchantRequestID
    ) {
      await supabaseAdmin
        .from("membership_payment_attempts")
        .update({
          status: "failed",
          callback_result_description: "STK request was rejected."
        })
        .eq("id", attempt.id);

      return res.status(502).json({
        ok: false,
        message: "M-Pesa did not accept the Sandbox request."
      });
    }

    const { error: updateError } = await supabaseAdmin
      .from("membership_payment_attempts")
      .update({
        checkout_request_id: stkData.CheckoutRequestID,
        merchant_request_id: stkData.MerchantRequestID
      })
      .eq("id", attempt.id);

    if (updateError) {
      console.error("Could not save M-Pesa request identifiers.");
      return res.status(500).json({
        ok: false,
        message: "Request was sent, but tracking needs attention."
      });
    }

    return res.json({
      ok: true,
      message: "Sandbox request sent. Complete the phone prompt if one appears.",
      attemptId: attempt.id
    });
  } catch (error) {
    console.error("STK Push route failed:", error.message);
    return res.status(500).json({
      ok: false,
      message: "Could not start the Sandbox payment."
    });
  }
});
    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ")
      ? authHeader.slice(7)
      : "";

    if (!token) {
      return res.status(401).json({
        ok: false,
        message: "Sign in first."
      });
    }

    const { createClient } = require("@supabase/supabase-js");
    const supabase = createClient(
      process.env.TPP_SUPABASE_URL,
      process.env.TPP_SUPABASE_ANON_KEY,
      {
        auth: {
          persistSession: false,
          autoRefreshToken: false
        }
      }
    );

    const { data, error } = await supabase.auth.getUser(token);

    if (error || !data.user) {
      return res.status(401).json({
        ok: false,
        message: "Your session is invalid or expired."
      });
    }

    return res.json({
      ok: true,
      authenticated: true
    });
  } catch {
    return res.status(500).json({
      ok: false,
      message: "Authentication check failed."
    });
 
  }
});
// Public Supabase configuration
// Only expose the project URL and publishable/anon key.
app.get("/api/config", (_req, res) => {
  const url = process.env.TPP_SUPABASE_URL;
  const key = process.env.TPP_SUPABASE_ANON_KEY;

  if (!url || !key) {
    return res.status(503).json({
      ok: false,
      message: "Supabase configuration is missing"
    });
  }

  res.set("Cache-Control", "no-store");

  res.json({
    supabaseUrl: url,
    supabaseKey: key
  });
});

// Homepage
app.get("/", (_req, res) => {
  res.sendFile(
    path.join(__dirname, "taskpluspro_tpp_website.html")
  );
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`TaskPlusPro listening on port ${PORT}`);
});

        
