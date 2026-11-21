require("dotenv").config();

const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const app = express();

app.use(express.json({ limit: "30kb" }));
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;

const UPESIPAY_URL =
  "https://upesipay.com/api/v2/collections/initiate/";

const AUTH_TOKEN = process.env.UPESIPAY_AUTH_TOKEN;
const CHANNEL_ID = process.env.UPESIPAY_CHANNEL_ID || "wallet";
const BASE_URL = process.env.PUBLIC_BASE_URL || "";

const ordersFile = path.join(__dirname, "orders.json");

const catalog = {
  1: { name: "Satin Evening Dress", price: 3200 },
  2: { name: "Casual Fashion Top", price: 1450 },
  3: { name: "Two Piece Outfit", price: 3800 },
  4: { name: "Denim Jeans", price: 2800 },
  5: { name: "Fashion Heels", price: 3500 },
  6: { name: "Bikini Set", price: 2400 },
  7: { name: "Ladies Handbag", price: 2600 },
  8: { name: "Floral Summer Dress", price: 3300 },
  9: { name: "Casual Sneakers", price: 4200 },
  10: { name: "Fashion Sunglasses", price: 1100 },
  11: { name: "Wide Leg Trousers", price: 3000 },
  12: { name: "Beach Cover Up", price: 2200 },
  13: { name: "Elegant Blouse", price: 1900 },
  14: { name: "Ladies Sandals", price: 2400 },
  15: { name: "Crossbody Bag", price: 2100 },
  16: { name: "Fashion Accessories", price: 900 }
};

function readOrders() {
  try {
    return JSON.parse(fs.readFileSync(ordersFile, "utf8"));
  } catch {
    return [];
  }
}

function saveOrders(orders) {
  fs.writeFileSync(ordersFile, JSON.stringify(orders, null, 2));
}

function normalizePhone(input) {
  let phone = String(input || "").replace(/[\s()+-]/g, "");

  if (phone.startsWith("+")) {
    phone = phone.slice(1);
  }

  if (phone.startsWith("0")) {
    phone = "254" + phone.slice(1);
  }

  if (/^[17]\d{8}$/.test(phone)) {
    phone = "254" + phone;
  }

  return /^254[17]\d{8}$/.test(phone) ? phone : null;
}

// Health check
app.get("/api/health", (req, res) => {
  res.json({
    success: true,
    service: "Madam Joy Boutique Shop",
    payment: "UpesiPay STK Push"
  });
});

// Checkout
app.post("/api/checkout", async (req, res) => {
  try {
    if (!AUTH_TOKEN) {
      return res.status(503).json({
        success: false,
        message: "Payments are not configured yet."
      });
    }

    const {
      items,
      name,
      phone,
      notes,
      delivery,
      payment_mode
    } = req.body || {};

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Your shopping bag is empty."
      });
    }

    if (!name || name.trim().length < 2) {
      return res.status(400).json({
        success: false,
        message: "Please enter your full name."
      });
    }

    const customerPhone = normalizePhone(phone);

    if (!customerPhone) {
      return res.status(400).json({
        success: false,
        message: "Enter a valid Kenyan M-PESA phone number."
      });
    }

    let total = 0;
    const checkedItems = [];

    // Validate products and prices on the server
    for (const item of items) {
      const product = catalog[Number(item.product_id)];
      const quantity = Number(item.quantity);

      if (!product || !Number.isInteger(quantity) || quantity < 1 || quantity > 30) {
        return res.status(400).json({
          success: false,
          message: "Invalid shopping cart item."
        });
      }

      const lineTotal = product.price * quantity;
      total += lineTotal;

      checkedItems.push({
        product_id: Number(item.product_id),
        name: product.name,
        quantity,
        unit_price: product.price,
        line_total: lineTotal
      });
    }

    const mode = payment_mode === "deposit" ? "deposit" : "full";

    // Deposit is 30%, full payment is 100%
    const amount = mode === "deposit"
      ? Math.ceil(total * 0.30)
      : total;

    if (amount < 1 || amount > 500000) {
      return res.status(400).json({
        success: false,
        message: "Invalid payment amount."
      });
    }

    const orderId =
      "MJB-" +
      Date.now().toString(36).toUpperCase() +
      "-" +
      crypto.randomBytes(3).toString("hex").toUpperCase();

    const callbackUrl = BASE_URL
      ? BASE_URL.replace(/\/$/, "") + "/api/upesipay/callback"
      : undefined;

    const authorization = AUTH_TOKEN.startsWith("Basic ")
      ? AUTH_TOKEN
      : "Basic " + AUTH_TOKEN;

    const payload = {
      channel_id: CHANNEL_ID === "wallet"
        ? "wallet"
        : Number(CHANNEL_ID),

      phone_number: customerPhone,
      amount,

      ...(callbackUrl ? { callback_url: callbackUrl } : {})
    };

    // Initiate UpesiPay STK Push
    const response = await fetch(UPESIPAY_URL, {
      method: "POST",
      headers: {
        Authorization: authorization,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    let result = {};

    try {
      result = await response.json();
    } catch {}

    if (!response.ok || result.success === false) {
      return res.status(502).json({
        success: false,
        message: result.message || "Payment request failed."
      });
    }

    const order = {
      order_id: orderId,
      created_at: new Date().toISOString(),

      customer_name: name.trim(),
      phone: customerPhone,

      notes: String(notes || "").slice(0, 500),

      delivery: delivery === "pickup"
        ? "pickup"
        : "delivery",

      payment_mode: mode,

      total,
      amount_due_now: amount,

      items: checkedItems,

      payment_status: "pending",

      upesipay_checkout_id:
        result?.data?.checkout_request_id || null,

      upesipay_merchant_id:
        result?.data?.merchant_request_id || null
    };

    const orders = readOrders();
    orders.push(order);
    saveOrders(orders);

    return res.json({
      success: true,
      message: "STK Push sent. Check your phone.",
      order_id: orderId,
      total,
      amount_due_now: amount,
      payment_status: "pending"
    });

  } catch (error) {
    console.error("Checkout error:", error);

    return res.status(500).json({
      success: false,
      message: "Unable to process checkout. Try again."
    });
  }
});

// Payment callback
app.post("/api/upesipay/callback", (req, res) => {
  try {
    const data = req.body || {};
    const orders = readOrders();

    const order = orders.find(o =>
      o.upesipay_merchant_id === data.merchant_request_id ||
      o.upesipay_checkout_id === data.checkout_request_id
    );

    if (order) {
      order.payment_status =
        String(data.status || "unknown").toLowerCase();

      order.callback_received_at =
        new Date().toISOString();

      order.callback_reference =
        data.reference_id || null;

      saveOrders(orders);
    }

    res.status(200).send("OK");

  } catch (error) {
    console.error("Callback error:", error);
    res.status(500).send("Callback error");
  }
});

app.listen(PORT, () => {
  console.log(
    `Madam Joy Boutique Shop running on port ${PORT}`
  );
});
