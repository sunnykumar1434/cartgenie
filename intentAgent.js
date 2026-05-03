require("dotenv").config();

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL = process.env.GROQ_MODEL || "llama-3.1-8b-instant";

// ===============================
// LOCAL HELPER FUNCTIONS
// ===============================

function normalizeText(text = "") {
  return String(text).trim().toLowerCase();
}

function extractOrderId(text = "") {
  const match = text.match(/\bORD\d+\b/i);
  return match ? match[0].toUpperCase() : null;
}

function includesAny(text, keywords = []) {
  return keywords.some((keyword) => text.includes(keyword));
}

// ===============================
// LOCAL FALLBACK ISSUE DETECTION
// ===============================

function detectIssueTypeLocal(cleanText) {
  if (
    includesAny(cleanText, [
      "dead on arrival",
      "doa",
      "not turning on",
      "phone is dead",
      "device is dead",
      "not powering on"
    ])
  ) {
    return "dead_on_arrival";
  }

  if (
    includesAny(cleanText, [
      "defective",
      "faulty",
      "not working",
      "stopped working",
      "malfunction",
      "technical issue",
      "technical problem"
    ])
  ) {
    return "defective_product";
  }

  if (
    includesAny(cleanText, [
      "damaged",
      "broken",
      "cracked",
      "scratch",
      "scratched",
      "torn",
      "leaked",
      "leakage"
    ])
  ) {
    return "damaged_product";
  }

  if (
    includesAny(cleanText, [
      "wrong item",
      "wrong product",
      "different item",
      "different product",
      "not what i ordered"
    ])
  ) {
    return "wrong_product";
  }

  if (
    includesAny(cleanText, [
      "missing item",
      "item missing",
      "missing product",
      "part missing",
      "accessory missing",
      "incomplete product",
      "incomplete order"
    ])
  ) {
    return "missing_item";
  }

  if (
    includesAny(cleanText, [
      "double charged",
      "amount deducted",
      "money deducted",
      "payment failed",
      "payment pending",
      "debited",
      "refund not received",
      "refund failed",
      "payment issue",
      "payment problem",
      "transaction failed"
    ])
  ) {
    return "payment_conflict";
  }

  if (
    includesAny(cleanText, [
      "refund",
      "refund status",
      "money back",
      "cashback"
    ])
  ) {
    return "refund_dispute";
  }

  return "general";
}

// ===============================
// LOCAL FALLBACK INTENT DETECTION
// ===============================

function detectIntentLocal(cleanText, issueType) {
  if (
    includesAny(cleanText, [
      "cancel",
      "cancellation",
      "cancel my order",
      "cancel order"
    ])
  ) {
    return {
      intent: "cancel_order",
      confidence: 0.94
    };
  }

  if (
    includesAny(cleanText, [
      "return",
      "return my order",
      "return product",
      "send back",
      "take back"
    ])
  ) {
    return {
      intent: "return_order",
      confidence: 0.93
    };
  }

  if (
    includesAny(cleanText, [
      "replace",
      "replacement",
      "exchange with new",
      "send replacement",
      "replace my product"
    ])
  ) {
    return {
      intent: "replace_order",
      confidence: 0.92
    };
  }

  if (
    includesAny(cleanText, [
      "exchange",
      "change size",
      "change color",
      "size issue",
      "wrong size",
      "want another size",
      "want another color"
    ])
  ) {
    return {
      intent: "exchange_order",
      confidence: 0.9
    };
  }

  if (
    includesAny(cleanText, [
      "track",
      "tracking",
      "where is my order",
      "order status",
      "delivery status",
      "when will it arrive",
      "arrive",
      "delivered when"
    ])
  ) {
    return {
      intent: "track_order",
      confidence: 0.91
    };
  }

  if (
    includesAny(cleanText, [
      "delivery failed",
      "not delivered",
      "delivery issue",
      "delivery problem",
      "late delivery",
      "delayed",
      "lost in transit",
      "shipment lost"
    ])
  ) {
    return {
      intent: "delivery_issue",
      confidence: 0.9
    };
  }

  if (
    includesAny(cleanText, [
      "refund status",
      "where is my refund",
      "refund not received",
      "refund delayed",
      "money back",
      "refund"
    ])
  ) {
    return {
      intent: "refund_status",
      confidence: issueType === "payment_conflict" ? 0.88 : 0.91
    };
  }

  if (
    includesAny(cleanText, [
      "payment",
      "double charged",
      "amount deducted",
      "money deducted",
      "payment failed",
      "payment pending",
      "debited",
      "transaction"
    ])
  ) {
    return {
      intent: "payment_issue",
      confidence: 0.92
    };
  }

  if (issueType === "damaged_product") {
    return {
      intent: "damaged_item",
      confidence: 0.86
    };
  }

  if (issueType === "wrong_product") {
    return {
      intent: "wrong_item",
      confidence: 0.86
    };
  }

  if (issueType === "missing_item") {
    return {
      intent: "missing_item",
      confidence: 0.86
    };
  }

  if (
    issueType === "defective_product" ||
    issueType === "dead_on_arrival"
  ) {
    return {
      intent: "replace_order",
      confidence: 0.82
    };
  }

  return {
    intent: "general_support",
    confidence: 0.42
  };
}

function reduceConfidenceForWeakQuery(query, currentConfidence) {
  const cleanText = normalizeText(query);

  if (!cleanText) return 0;
  if (cleanText.length <= 3) return 0.1;
  if (/^[^a-z0-9]+$/i.test(cleanText)) return 0.05;

  const garbagePatterns = [
    "asdasd",
    "qwerty",
    "blah",
    "random",
    "test test",
    "aaaa",
    "????"
  ];

  if (garbagePatterns.some((pattern) => cleanText.includes(pattern))) {
    return Math.min(currentConfidence, 0.2);
  }

  return currentConfidence;
}

function localIntentFallback(userQuery = "") {
  const cleanText = normalizeText(userQuery);
  const orderId = extractOrderId(userQuery);
  const issueType = detectIssueTypeLocal(cleanText);
  const intentResult = detectIntentLocal(cleanText, issueType);

  const finalConfidence = reduceConfidenceForWeakQuery(
    userQuery,
    intentResult.confidence
  );

  return {
    intent: intentResult.intent,
    confidence: finalConfidence,
    orderId,
    issueType,
    rawText: userQuery,
    source: "local_fallback_intent_agent"
  };
}

// ===============================
// GROQ HELPERS
// ===============================

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch (error) {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw error;
    return JSON.parse(match[0]);
  }
}

function normalizeGroqResult(parsed, userQuery) {
  const explicitOrderId = extractOrderId(userQuery);
  const cleanText = normalizeText(userQuery);

  const allowedIntents = [
    "cancel_order",
    "return_order",
    "replace_order",
    "refund_status",
    "exchange_order",
    "track_order",
    "delivery_issue",
    "payment_issue",
    "missing_item",
    "wrong_item",
    "damaged_item",
    "general_support"
  ];

  const allowedIssueTypes = [
    "general",
    "defective_product",
    "damaged_product",
    "wrong_product",
    "missing_item",
    "incomplete_product",
    "technical_issue",
    "dead_on_arrival",
    "payment_conflict",
    "refund_dispute"
  ];

  let intent = parsed.intent || "general_support";
  let issueType = parsed.issueType || parsed.issue_type || "general";
  let confidence = Number(parsed.confidence);

  if (!allowedIntents.includes(intent)) {
    intent = "general_support";
    confidence = 0.35;
  }

  if (!allowedIssueTypes.includes(issueType)) {
    issueType = "general";
  }

  if (Number.isNaN(confidence)) {
    confidence = 0.5;
  }

  if (confidence > 1) {
    confidence = confidence / 100;
  }

  confidence = Math.max(0, Math.min(confidence, 1));

  // ===============================
  // DETERMINISTIC CORRECTION LAYER
  // ===============================
  // This protects the pipeline when Groq returns generic/weak intent
  // for obvious queries such as "I want to return ORD103".

  const localIssueType = detectIssueTypeLocal(cleanText);
  const localIntentResult = detectIntentLocal(cleanText, localIssueType);

  const groqWeakOrGeneric =
    intent === "general_support" ||
    confidence < 0.75;

  const localStrongIntent =
    localIntentResult.intent !== "general_support" &&
    localIntentResult.confidence >= 0.82;

  if (groqWeakOrGeneric && localStrongIntent) {
    intent = localIntentResult.intent;
    confidence = Math.max(confidence, localIntentResult.confidence);
    issueType = localIssueType;
  }

  if (
    intent === "exchange_order" &&
    includesAny(cleanText, [
      "size issue",
      "wrong size",
      "change size",
      "another size",
      "want another size"
    ])
  ) {
    issueType = "general";
  }

  return {
    intent,
    confidence,

    // IMPORTANT:
    // Trust only order IDs explicitly present in the user query.
    // Never accept hallucinated order IDs from Groq.
    orderId: explicitOrderId,

    issueType,
    rawText: userQuery,
    source: "groq_intent_agent"
  };
}

async function callGroqIntentAgent(userQuery = "") {
  if (!GROQ_API_KEY) {
    throw new Error("Missing GROQ_API_KEY in .env");
  }

  const systemPrompt = `
You are the Intent + Entity Agent for CartGenie, a multi-agent AI customer support system for Indian e-commerce.

Your job:
Extract intent, confidence, orderId, and issueType from the user's query.

Return ONLY valid JSON.
No explanation.
No markdown.
No extra text.

Allowed intents:
- cancel_order
- return_order
- replace_order
- refund_status
- exchange_order
- track_order
- delivery_issue
- payment_issue
- missing_item
- wrong_item
- damaged_item
- general_support

Allowed issueType values:
- general
- defective_product
- damaged_product
- wrong_product
- missing_item
- incomplete_product
- technical_issue
- dead_on_arrival
- payment_conflict
- refund_dispute

Rules:
- Extract orderId only if explicitly present in the user query, like ORD101, ORD102, ORD103.
- Do not invent or assume an orderId.
- If no orderId is present, return null for orderId.
- Confidence must be between 0 and 1.
- If user wants cancellation, intent is cancel_order.
- If user wants return, intent is return_order.
- If user wants replacement or product is defective/DOA, intent is replace_order.
- If user asks about refund status, intent is refund_status.
- If user has double charge/payment deducted/payment failed, intent is payment_issue.
- If user asks where the order is, intent is track_order.
- If user reports wrong item, use wrong_item.
- If user reports missing item, use missing_item.
- If user reports damaged item, use damaged_item.
- If unclear, use general_support with low confidence.

JSON format:
{
  "intent": "cancel_order",
  "confidence": 0.94,
  "orderId": "ORD101",
  "issueType": "general"
}
`;

  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${GROQ_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      temperature: 0,
      messages: [
        {
          role: "system",
          content: systemPrompt
        },
        {
          role: "user",
          content: userQuery
        }
      ]
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Groq API error: ${response.status} ${errorText}`);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content;

  if (!content) {
    throw new Error("Groq returned empty content");
  }

  const parsed = safeJsonParse(content);
  return normalizeGroqResult(parsed, userQuery);
}

// ===============================
// MAIN EXPORTED FUNCTION
// ===============================

async function detectIntentAndEntities(userQuery = "") {
  try {
    return await callGroqIntentAgent(userQuery);
  } catch (error) {
    const fallback = localIntentFallback(userQuery);

    return {
      ...fallback,
      groqError: error.message,
      source: "local_fallback_after_groq_error"
    };
  }
}

module.exports = {
  detectIntentAndEntities
};