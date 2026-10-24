'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const WEBSITE_FILE = path.join(
  __dirname,
  'taskpluspro_tpp_website.html'
);

const PAYMENT_AMOUNT_KES = 1; // Sandbox test only, NOT the $5 membership price.
const PAYMENT_ENVIRONMENT = 'sandbox';
const DARAJA_BASE_URL = 'https://sandbox.safaricom.co.ke';

const STK_PUSH_ENABLED =
  process.env.TPP_ENABLE_SANDBOX_STK_PUSH === 'true';

app.disable('x-powered-by');

app.use(express.json({
  limit: '100kb',
  strict: true
}));

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Cache-Control', 'no-store');
  next();
});

// --------------------------------------------------
// COMMON HELPERS
// --------------------------------------------------

function httpError(message, status = 500) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function getAdminClient() {
  const url = process.env.TPP_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw httpError(
      'Server Supabase configuration is missing.',
      503
    );
  }

  return createClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    }
  });
}

async function getAuthenticatedUser(req) {
  const match = String(
    req.get('Authorization') || ''
  ).match(/^Bearer\s+(.+)$/i);

  if (!match) {
    throw httpError('Please sign in first.', 401);
  }

  const admin = getAdminClient();

  const { data, error } = await admin.auth.getUser(match[1]);

  if (error || !data || !data.user) {
    throw httpError(
      'Your session is invalid. Sign in again.',
      401
    );
  }

  return {
    admin,
    user: data.user
  };
}

function normalizeKenyanPhone(value) {
  let phone = String(value || '')
    .replace(/[\s()-]/g, '');

  if (phone.startsWith('+')) {
    phone = phone.slice(1);
  }

  if (phone.startsWith('0')) {
    phone = '254' + phone.slice(1);
  }

  if (!/^254[17]\d{8}$/.test(phone)) {
    throw httpError(
      'Enter a valid Kenyan mobile number, e.g. 0712345678.',
      400
    );
  }

  return phone;
}

function darajaTimestamp() {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Nairobi',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(new Date());

  const values = {};

  for (const part of parts) {
    if (part.type !== 'literal') {
      values[part.type] = part.value;
    }
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
  return Buffer.from(
    shortcode + passkey + timestamp
  ).toString('base64');
}

function requireSandboxConfig() {
  if (process.env.MPESA_ENV !== 'sandbox') {
    throw httpError(
      'Membership payments are restricted to sandbox.',
      503
    );
  }

  const shortcode = process.env.MPESA_SHORTCODE;
  const passkey = process.env.MPESA_PASSKEY;
  const callbackUrl = process.env.MPESA_CALLBACK_URL;

  if (!shortcode || !passkey || !callbackUrl) {
    throw httpError(
      'Daraja sandbox configuration is incomplete.',
      503
    );
  }

  let parsedUrl;

  try {
    parsedUrl = new URL(callbackUrl);
  } catch {
    throw httpError(
      'The M-Pesa callback URL is invalid.',
      503
    );
  }

  if (
    parsedUrl.protocol !== 'https:' ||
    parsedUrl.hostname !== 'taskpluspro.onrender.com' ||
    parsedUrl.pathname !== '/api/mpesa/callback'
  ) {
    throw httpError(
      'The sandbox callback must use the approved TaskPlusPro HTTPS callback URL.',
      503
    );
  }

  return {
    shortcode,
    passkey,
    callbackUrl
  };
}

// --------------------------------------------------
// SAFARICOM DARAJA OAUTH HELPER
// --------------------------------------------------

async function getDarajaToken() {
  const key = process.env.MPESA_CONSUMER_KEY;
  const secret = process.env.MPESA_CONSUMER_SECRET;

  if (!key || !secret) {
    throw httpError(
      'Daraja sandbox credentials are not configured.',
      503
    );
  }

  const response = await fetch(
    `${DARAJA_BASE_URL}/oauth/v1/generate?grant_type=client_credentials`,
    {
      headers: {
        Authorization:
          'Basic ' +
          Buffer.from(`${key}:${secret}`).toString('base64')
      },
      signal: AbortSignal.timeout(15000)
    }
  );

  const data = await response.json().catch(() => ({}));

  if (!response.ok || !data.access_token) {
    console.error(
      'Daraja OAuth failed with HTTP status:',
      response.status
    );

    throw httpError(
      'Daraja sandbox authentication failed.',
      502
    );
  }

  return data.access_token;
}

// --------------------------------------------------
// BASIC RATE LIMITING
// For production, replace with a shared rate-limit store.
// --------------------------------------------------

const requestBuckets = new Map();

function limitRequests({
  windowMs = 60000,
  max = 8
} = {}) {
  return (req, res, next) => {
    const key = `${req.ip}:${req.path}`;
    const now = Date.now();
    const bucket = requestBuckets.get(key);

    if (!bucket || now - bucket.start >= windowMs) {
      requestBuckets.set(key, {
        start: now,
        count: 1
      });

      return next();
    }

    bucket.count += 1;

    if (bucket.count > max) {
      return res.status(429).json({
        ok: false,
        message: 'Too many requests. Please wait and try again.'
      });
    }

    return next();
  };
}

// --------------------------------------------------
// HEALTH CHECK
// --------------------------------------------------

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'TaskPlusPro',
    status: 'online',
    timestamp: new Date().toISOString()
  });
});

// --------------------------------------------------
// PAYMENT ROUTE DIAGNOSTIC
// Does not initiate a payment.
// --------------------------------------------------

app.get('/api/payment-route-check', (_req, res) => {
  res.json({
    ok: true,
    service: 'TaskPlusPro',
    paymentRouteRegistered: true,
    paymentMode: PAYMENT_ENVIRONMENT,
    stkPushEnabled: STK_PUSH_ENABLED,
    note: 'Diagnostic only. No payment was initiated.'
  });
});

// --------------------------------------------------
// PUBLIC SUPABASE BROWSER CONFIGURATION
// Never expose the service-role key.
// --------------------------------------------------

app.get('/api/config', (_req, res) => {
  const supabaseUrl = process.env.TPP_SUPABASE_URL;
  const supabaseKey = process.env.TPP_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseKey) {
    return res.status(503).json({
      ok: false,
      message: 'Supabase browser configuration is missing.'
    });
  }

  return res.json({
    supabaseUrl,
    supabaseKey
  });
});

// --------------------------------------------------
// ENVIRONMENT DIAGNOSTICS
// Shows whether variables exist, never their values.
// --------------------------------------------------

app.get('/api/diagnostics', (_req, res) => {
  res.json({
    ok: true,
    service: 'TaskPlusPro',

    checks: {
      websiteFileExists: fs.existsSync(WEBSITE_FILE),

      supabaseUrlConfigured:
        Boolean(process.env.TPP_SUPABASE_URL),

      supabaseAnonKeyConfigured:
        Boolean(process.env.TPP_SUPABASE_ANON_KEY),

      serviceRoleConfigured:
        Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),

      darajaConsumerKeyConfigured:
        Boolean(process.env.MPESA_CONSUMER_KEY),

      darajaConsumerSecretConfigured:
        Boolean(process.env.MPESA_CONSUMER_SECRET),

      darajaPasskeyConfigured:
        Boolean(process.env.MPESA_PASSKEY),

      darajaShortcodeConfigured:
        Boolean(process.env.MPESA_SHORTCODE),

      darajaCallbackConfigured:
        Boolean(process.env.MPESA_CALLBACK_URL),

      mpesaEnvironment:
        process.env.MPESA_ENV || 'not-set',

      sandboxStkPushEnabled:
        STK_PUSH_ENABLED
    },

    note:
      'Presence checks only; they do not prove credentials or payments work.'
  });
});

// --------------------------------------------------
// MEMBERSHIP PAYMENT INITIATION
//
// KSh 1 sandbox test amount.
// Leave TPP_ENABLE_SANDBOX_STK_PUSH=false in Render.
// The endpoint returns "disabled" unless explicitly enabled.
// --------------------------------------------------

app.post(
  '/api/membership/pay',
  limitRequests({
    windowMs: 60000,
    max: 3
  }),
  async (req, res) => {
    if (!STK_PUSH_ENABLED) {
      return res.status(503).json({
        ok: false,
        paymentStatus: 'disabled',
        message:
          'Sandbox payment initiation is disabled. No payment was sent.'
      });
    }

    let admin;
    let attemptId;

    try {
      const auth = await getAuthenticatedUser(req);

      admin = auth.admin;
      const user = auth.user;

      const {
        shortcode,
        passkey,
        callbackUrl
      } = requireSandboxConfig();

      const phone = normalizeKenyanPhone(
        req.body && req.body.phone
      );

      const {
        data: profile,
        error: profileError
      } = await admin
        .from('profiles')
        .select('id, membership_paid, account_status')
        .eq('id', user.id)
        .maybeSingle();

      if (profileError) {
        throw profileError;
      }

      if (!profile) {
        return res.status(409).json({
          ok: false,
          message: 'Your member profile was not found.'
        });
      }

      if (profile.membership_paid === true) {
        return res.status(409).json({
          ok: false,
          message: 'Membership is already marked as paid.'
        });
      }

      const {
        data: pending,
        error: pendingError
      } = await admin
        .from('membership_payment_attempts')
        .select('id')
        .eq('user_id', user.id)
        .eq('environment', PAYMENT_ENVIRONMENT)
        .in('status', [
          'pending',
          'callback_received'
        ])
        .limit(1);

      if (pendingError) {
        throw pendingError;
      }

      if (pending && pending.length) {
        return res.status(409).json({
          ok: false,
          message:
            'A sandbox payment attempt is already in progress. Check its status before trying again.'
        });
      }

      const {
        data: attempt,
        error: insertError
      } = await admin
        .from('membership_payment_attempts')
        .insert({
          user_id: user.id,
          amount_kes: PAYMENT_AMOUNT_KES,
          environment: PAYMENT_ENVIRONMENT,
          status: 'pending',
          phone_number: phone
        })
        .select('id')
        .single();

      if (insertError) {
        throw insertError;
      }

      attemptId = attempt.id;

      const token = await getDarajaToken();
      const timestamp = darajaTimestamp();

      const payload = {
        BusinessShortCode: shortcode,

        Password: darajaPassword(
          shortcode,
          passkey,
          timestamp
        ),

        Timestamp: timestamp,

        TransactionType:
          process.env.MPESA_TRANSACTION_TYPE ||
          'CustomerPayBillOnline',

        Amount: PAYMENT_AMOUNT_KES,
        PartyA: phone,
        PartyB: shortcode,
        PhoneNumber: phone,
        CallBackURL: callbackUrl,
        AccountReference: 'TPP-MEMBER',
        TransactionDesc: 'TPP Sandbox Test'
      };

      const response = await fetch(
        `${DARAJA_BASE_URL}/mpesa/stkpush/v1/processrequest`,
        {
          method: 'POST',

          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json'
          },

          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(20000)
        }
      );

      const result = await response.json().catch(() => ({}));

      if (
        !response.ok ||
        String(result.ResponseCode) !== '0' ||
        !result.CheckoutRequestID ||
        !result.MerchantRequestID
      ) {
        await admin
          .from('membership_payment_attempts')
          .update({
            status: 'failed',
            callback_result_description:
              'Daraja did not accept the request.'
          })
          .eq('id', attemptId);

        return res.status(502).json({
          ok: false,
          message:
            'Daraja did not accept the sandbox payment request.'
        });
      }

      const {
        error: updateError
      } = await admin
        .from('membership_payment_attempts')
        .update({
          merchant_request_id:
            result.MerchantRequestID,

          checkout_request_id:
            result.CheckoutRequestID,

          stk_timestamp: timestamp
        })
        .eq('id', attemptId);

      if (updateError) {
        console.error(
          'Checkout ID save failed for attempt:',
          attemptId
        );

        return res.status(500).json({
          ok: false,
          message:
            'The request may have reached Daraja, but its status could not be saved. Do not retry repeatedly.'
        });
      }

      return res.status(202).json({
        ok: true,
        paymentStatus: 'pending',
        message:
          'Sandbox request accepted. Membership remains inactive until payment is independently verified.'
      });

    } catch (error) {
      if (attemptId && admin) {
        const {
          error: updateError
        } = await admin
          .from('membership_payment_attempts')
          .update({
            status: 'failed',
            callback_result_description:
              'Payment initiation error.'
          })
          .eq('id', attemptId);

        if (updateError) {
          console.error(
            'Could not update failed attempt:',
            attemptId
          );
        }
      }

      console.error(
        'TPP sandbox payment initiation error:',
        error.message
      );

      return res.status(error.status || 500).json({
        ok: false,
        message: error.status
          ? error.message
          : 'Could not initiate the sandbox request. Check server logs.'
      });
    }
  }
);

// --------------------------------------------------
// M-PESA CALLBACK
//
// Records callback information only.
// Does NOT verify the actual payment independently.
// Does NOT activate membership.
// --------------------------------------------------

app.post('/api/mpesa/callback', async (req, res) => {
  try {
    const callback =
      req.body &&
      req.body.Body &&
      req.body.Body.stkCallback;

    if (!callback || !callback.CheckoutRequestID) {
      return res.status(200).json({
        ResultCode: 0,
        ResultDesc: 'Received'
      });
    }

    const admin = getAdminClient();

    const {
      data: attempt,
      error: findError
    } = await admin
      .from('membership_payment_attempts')
      .select('*')
      .eq(
        'checkout_request_id',
        callback.CheckoutRequestID
      )
      .maybeSingle();

    if (findError) {
      throw findError;
    }

    if (
      !attempt ||
      attempt.environment !== PAYMENT_ENVIRONMENT ||
      ['verified', 'failed'].includes(attempt.status)
    ) {
      return res.status(200).json({
        ResultCode: 0,
        ResultDesc: 'Received'
      });
    }

    const resultCode = Number(callback.ResultCode);

    if (resultCode !== 0) {
      const {
        error: updateError
      } = await admin
        .from('membership_payment_attempts')
        .update({
          status: 'failed',

          callback_result_code:
            Number.isFinite(resultCode)
              ? resultCode
              : null,

          callback_result_description: String(
            callback.ResultDesc || 'Payment failed'
          ).slice(0, 500)
        })
        .eq('id', attempt.id)
        .eq('status', 'pending');

      if (updateError) {
        throw updateError;
      }

      return res.status(200).json({
        ResultCode: 0,
        ResultDesc: 'Received'
      });
    }

    const items =
      callback.CallbackMetadata &&
      Array.isArray(callback.CallbackMetadata.Item)
        ? callback.CallbackMetadata.Item
        : [];

    const metadata = Object.fromEntries(
      items.map(item => [
        item.Name,
        item.Value
      ])
    );

    const amount = Number(metadata.Amount);
    const receipt = String(
      metadata.MpesaReceiptNumber || ''
    );
    const phone = String(
      metadata.PhoneNumber || ''
    );

    if (
      amount !== PAYMENT_AMOUNT_KES ||
      Number(attempt.amount_kes) !== PAYMENT_AMOUNT_KES ||
      !receipt ||
      phone !== String(attempt.phone_number)
    ) {
      const {
        error: updateError
      } = await admin
        .from('membership_payment_attempts')
        .update({
          callback_result_code: 0,

          callback_result_description:
            'Callback received; metadata mismatch requires independent reconciliation.'
        })
        .eq('id', attempt.id);

      if (updateError) {
        throw updateError;
      }

      console.error(
        'TPP callback metadata mismatch for attempt:',
        attempt.id
      );

      return res.status(200).json({
        ResultCode: 0,
        ResultDesc: 'Received'
      });
    }

    const {
      error: updateError
    } = await admin
      .from('membership_payment_attempts')
      .update({
        status: 'callback_received',
        mpesa_receipt_number: receipt,
        callback_result_code: 0,

        callback_result_description:
          'Success callback received; independent payment verification is still required.'
      })
      .eq('id', attempt.id)
      .eq('status', 'pending');

    if (updateError) {
      throw updateError;
    }

    console.log(
      'TPP callback recorded; independent reconciliation required for attempt:',
      attempt.id
    );

  } catch (error) {
    console.error(
      'TPP callback processing error:',
      error.message
    );
  }

  // Return an acknowledgement without activating membership.
  return res.status(200).json({
    ResultCode: 0,
    ResultDesc: 'Received'
  });
});

// --------------------------------------------------
// SIGNED-IN MEMBER PAYMENT STATUS
// --------------------------------------------------

app.get(
  '/api/membership/payment-status',
  async (req, res) => {
    try {
      const {
        admin,
        user
      } = await getAuthenticatedUser(req);

      const {
        data,
        error
      } = await admin
        .from('membership_payment_attempts')
        .select(
          'amount_kes, status, created_at, mpesa_receipt_number'
        )
        .eq('user_id', user.id)
        .order('created_at', {
          ascending: false
        })
        .limit(1)
        .maybeSingle();

      if (error) {
        throw error;
      }

      return res.json({
        ok: true,
        payment: data || null
      });

    } catch (error) {
      return res.status(error.status || 500).json({
        ok: false,
        message: error.status
          ? error.message
          : 'Could not load payment status.'
      });
    }
  }
);

// --------------------------------------------------
// WEBSITE HOMEPAGE
// --------------------------------------------------

app.get('/', (_req, res) => {
  res.sendFile(WEBSITE_FILE, error => {
    if (error && !res.headersSent) {
      console.error(
        'Homepage error:',
        error.message
      );

      res.status(500).send(
        'Homepage missing. Check taskpluspro_tpp_website.html.'
      );
    }
  });
});

app.get(
  '/taskpluspro_tpp_website.html',
  (_req, res) => {
    res.sendFile(WEBSITE_FILE);
  }
);

// --------------------------------------------------
// FINAL ERROR HANDLERS
// These must remain after all routes.
// --------------------------------------------------

app.use('/api', (_req, res) => {
  res.status(404).json({
    ok: false,
    message: 'API route not found.'
  });
});

app.use((_req, res) => {
  res.status(404).send('Page not found.');
});

// --------------------------------------------------
// START SERVER
// --------------------------------------------------

app.listen(PORT, '0.0.0.0', () => {
  console.log(
    `TaskPlusPro listening on port ${PORT}`
  );
});
