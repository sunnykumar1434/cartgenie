require("dotenv").config();

const express = require("express");
const cors = require("cors");

// Import your pipeline
const { processQuery } = require("./app");

const app = express();

// =========================
// MIDDLEWARE
// =========================
app.use(cors());
app.use(express.json());

// =========================
// HEALTH CHECK
// =========================
app.get("/", (req, res) => {
  res.json({
    status: "CartGenie AI is running 🚀"
  });
});

// ✅ ADD THIS (for deployment health checks)
app.get("/health", (req, res) => {
  res.send("OK");
});

// =========================
// TEST ROUTE (DEV ONLY)
// =========================
if (process.env.NODE_ENV !== "production") {
  app.get("/test", async (req, res) => {
    try {
      const message = req.query.message || "Hello";

      const response = await processQuery(message);

      res.json({
        user_message: message,
        bot_response: response
      });

    } catch (error) {
      console.log("TEST ERROR:", error);

      res.status(500).json({
        error: "Something went wrong"
      });
    }
  });
}

// =========================
// CHAT ENDPOINT
// =========================
app.post("/chat", async (req, res) => {

  try {

    const { message } = req.body;

    if (!message) {
      return res.status(400).json({
        error: "Message is required"
      });
    }

    const response = await processQuery(message);

    return res.json({
      success: true,
      user_message: message,
      bot_response: response
    });

  } catch (error) {

    console.log("API ERROR:", error);

    return res.status(500).json({
      success: false,
      error: "Internal server error"
    });
  }
});

// =========================
// START SERVER (UPDATED)
// =========================
const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running on port ${PORT}`);
});