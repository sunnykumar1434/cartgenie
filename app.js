require("dotenv").config();

const express = require("express");
const cors = require("cors");

const orders = require("./orders.json");
const { detectIntentAndEntities } = require("./intentAgent");
const { evaluateConfidence } = require("./confidenceAgent");
const { applyRules } = require("./ruleEngine");
const { generateResponse } = require("./responseAgent");
const { handleEscalation } = require("./escalationAgent");

const {
  generateFallbackResponse,
  buildFallbackEscalation,
  isGreetingQuery,
} = require("./fallbackAgent");

const {
  logAuditEvent,
  logErrorEvent,
  readRecentAuditLogs,
  readRecentErrorLogs,
} = require("./auditLogger");

const app = express();
const PORT = process.env.PORT || 5001;

app.use(cors());
app.use(express.json());

// =====================================================
// SESSION STORE
// =====================================================

const sessionStore = {};
const REPEATED_FAILURE_LIMIT = 3;

const ORDER_REQUIRED_INTENTS = new Set([
  "cancel_order",
  "return_order",
  "replace_order",
  "refund_status",
  "exchange_order",
  "reorder_order",
  "track_order",
  "delivery_issue",
  "payment_issue",
  "missing_item",
  "wrong_item",
  "damaged_item",
]);

function getSession(sessionId = "default_session") {
  if (!sessionStore[sessionId]) {
    sessionStore[sessionId] = {
      sessionId,

      fallbackCount: 0,
      clarificationCount: 0,
      totalFailureCount: 0,

      lastIntent: null,
      lastOrderId: null,
      lastTrackingId: null,
      lastIssueType: null,
      lastStage: null,
      lastQuery: null,

      pendingIntent: null,
      pendingMissingEntity: null,
      pendingIssueType: null,

      // Multi-turn memory
      pendingAction: null,
      pendingHumanSupport: false,
      pendingHumanSupportStage: null,
      lastHumanTicketId: null,
      orderOverrides: {},

      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  return sessionStore[sessionId];
}

function updateSession(sessionId, updates = {}) {
  const session = getSession(sessionId);

  Object.assign(session, updates, {
    updatedAt: new Date().toISOString(),
  });

  return session;
}

function clearOrderContext(sessionId, stage, query) {
  return updateSession(sessionId, {
    fallbackCount: 0,
    clarificationCount: 0,
    totalFailureCount: 0,

    lastIntent: null,
    lastOrderId: null,
    lastTrackingId: null,
    lastIssueType: null,
    lastStage: stage,
    lastQuery: query,

    pendingIntent: null,
    pendingMissingEntity: null,
    pendingIssueType: null,
    pendingAction: null,
    pendingHumanSupport: false,
    pendingHumanSupportStage: null,
    lastHumanTicketId: null,
  });
}

function resetFailures(sessionId, intentResult, query) {
  return updateSession(sessionId, {
    fallbackCount: 0,
    clarificationCount: 0,
    totalFailureCount: 0,

    lastIntent: intentResult?.intent || null,
    lastOrderId: intentResult?.orderId || null,
    lastTrackingId: intentResult?.trackingId || null,
    lastIssueType: intentResult?.issueType || "general",
    lastStage: "completed",
    lastQuery: query,

    pendingIntent: null,
    pendingMissingEntity: null,
    pendingIssueType: null,
    pendingAction: null,
  });
}

function registerFailure(sessionId, type, intentResult, query) {
  const session = getSession(sessionId);

  if (type === "fallback") session.fallbackCount += 1;
  if (type === "clarification") session.clarificationCount += 1;

  session.totalFailureCount =
    session.fallbackCount + session.clarificationCount;

  session.lastIntent = intentResult?.intent || session.lastIntent;
  session.lastOrderId = intentResult?.orderId || session.lastOrderId;
  session.lastTrackingId =
    intentResult?.trackingId || session.lastTrackingId;
  session.lastIssueType =
    intentResult?.issueType || session.lastIssueType || "general";
  session.lastStage = type;
  session.lastQuery = query;
  session.updatedAt = new Date().toISOString();

  return session;
}

// =====================================================
// BASIC HELPERS
// =====================================================

function normalizeText(text = "") {
  return String(text || "")
    .toLowerCase()
    .trim()
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, " ");
}

function normalizeForMatching(text = "") {
  return normalizeText(text)
    .replace(/[-_]/g, " ")
    .replace(/[^\w\s']/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function includesAny(text = "", patterns = []) {
  const clean = normalizeForMatching(text);
  return patterns.some((p) => clean.includes(normalizeForMatching(p)));
}

function extractOrderId(text = "") {
  const raw = String(text || "");

  let match = raw.match(/\b(?:ORD|ODR)\s*-?\s*(\d+)\b/i);
  if (match) return `ORD${match[1]}`.toUpperCase();

  match = raw.match(
    /\border\s*(?:id|number|no|#)?\s*(?:is|:|=)?\s*-?\s*(\d+)\b/i
  );
  if (match) return `ORD${match[1]}`.toUpperCase();

  return null;
}

function extractTrackingId(text = "") {
  const raw = String(text || "");
  const match = raw.match(/\b(TRK|AWB)\s*-?\s*(\d+)\b/i);

  if (!match) return null;

  return `${match[1].toUpperCase()}${match[2]}`;
}

function findOrder(orderId) {
  if (!orderId) return null;

  const id = String(orderId).trim().toUpperCase();

  return (
    orders.find(
      (order) => String(order.orderId).trim().toUpperCase() === id
    ) || null
  );
}

function findOrderByTrackingId(trackingId) {
  if (!trackingId) return null;

  const id = String(trackingId).trim().toUpperCase();

  return (
    orders.find((order) =>
      [
        order.trackingId,
        order.awb,
        order.shipmentId,
        order.courierTrackingId,
      ]
        .filter(Boolean)
        .map((v) => String(v).trim().toUpperCase())
        .includes(id)
    ) || null
  );
}

function applyOrderOverride(order, session = {}) {
  if (!order) return null;

  const key = String(order.orderId || "").trim().toUpperCase();
  const override = session.orderOverrides?.[key];

  if (!override) return order;

  return {
    ...order,
    ...override,
    orderId: order.orderId,
  };
}

function findOrderForSession(orderId, session = {}) {
  return applyOrderOverride(findOrder(orderId), session);
}

function findOrderByTrackingIdForSession(trackingId, session = {}) {
  return applyOrderOverride(findOrderByTrackingId(trackingId), session);
}

function getOrderSummary(order) {
  if (!order) return null;

  return {
    orderId: order.orderId,
    status: order.status,
    category: order.category,
    subcategory: order.subcategory,
    paymentMethod: order.paymentMethod,
    paymentStatus: order.paymentStatus,
    orderValue: order.orderValue,
    trackingId: order.trackingId || order.awb || null,
    currentLocation:
      order.currentLocation ||
      order.lastKnownLocation ||
      order.location ||
      order.hub ||
      order.city ||
      null,
  };
}

function intentFriendlyName(intent) {
  const map = {
    cancel_order: "cancellation",
    return_order: "return",
    replace_order: "replacement",
    exchange_order: "exchange",
    reorder_order: "reorder",
    refund_status: "refund",
    payment_issue: "payment",
    track_order: "tracking/status",
    delivery_issue: "delivery",
    missing_item: "missing item",
    wrong_item: "wrong item",
    damaged_item: "damaged item",
    human_support: "human support",
  };

  return map[intent] || "order support";
}

function statusText(status = "") {
  return String(status || "Unknown")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (m) => m.toUpperCase());
}

function normalizeStatus(status = "") {
  return normalizeForMatching(status).replace(/\s+/g, "_");
}

function isCancellableStatus(status = "") {
  const s = normalizeStatus(status);

  return ["placed", "confirmed", "processing", "pending", "created"].includes(
    s
  );
}

function isGreeting(text) {
  const q = normalizeForMatching(text);

  return (
    [
      "hi",
      "hii",
      "hiii",
      "hello",
      "helo",
      "helloo",
      "hey",
      "heyy",
      "he",
      "hy",
      "hlw",
      "good morning",
      "good afternoon",
      "good evening",
      "namaste",
    ].includes(q) || isGreetingQuery(text)
  );
}

function isThanks(text) {
  const q = normalizeForMatching(text);

  return [
    "thanks",
    "thank you",
    "thankyou",
    "thanks a lot",
    "thank you so much",
    "ok thanks",
    "okay thanks",
    "got it",
    "done",
    "okay",
    "ok",
    "cool",
    "great",
    "perfect",
  ].includes(q);
}

function isResetContext(text) {
  const q = normalizeForMatching(text);

  return [
    "new query",
    "it's a new query",
    "its a new query",
    "start new query",
    "start over",
    "reset",
    "clear context",
    "forget previous",
    "forget old order",
  ].some(
    (p) =>
      q === normalizeForMatching(p) ||
      q.includes(normalizeForMatching(p))
  );
}

function isOrderIdFaq(text) {
  const q = normalizeForMatching(text);

  return includesAny(q, [
    "where is order id",
    "where can i find my order id",
    "where can i see my order id",
    "how can i check order id",
    "how to check order id",
    "how do i find order id",
    "how can fond ord id",
    "find ord id",
    "fond ord id",
    "what is order id",
    "i don't know my order id",
    "i dont know my order id",

    // New real-world order-number variants
    "i don't know my order number",
    "i dont know my order number",
    "i do not know my order number",
    "don't know my order number",
    "dont know my order number",
    "do not know my order number",
    "where is my order number",
    "where can i find my order number",
    "how can i find my order number",
    "how do i find my order number",
    "how to find order number",
    "how can i get order number",
    "where can i get order number",
    "what is my order number",
  ]);
}

function isUnsafeRequestQuery(text) {
  return includesAny(text, [
    "ignore previous instructions",
    "ignore all instructions",
    "bypass policy",
    "bypass rules",
    "delete logs",
    "delete all logs",
    "remove logs",
    "clear logs",
    "give me admin access",
    "admin access",
    "system prompt",
    "developer message",
    "api key",
    "secret",
    "jailbreak",

    // New security/privacy guardrails
    "give me database access",
    "database access",
    "db access",
    "backend access",
    "internal database",
    "customer database",
    "private customer data",
    "private customer details",
    "show me customer data",
    "show customer data",
    "show me another customer's order",
    "another customer's order",
    "another customer order",
    "other customer's order",
    "other customer order",
    "someone else's order",
    "someone else order",
    "show me another customer's order details",
    "show another customer's order details",
    "show me other user's data",
    "show other user data",
    "customer details",
    "private order details",
  ]);
}

function isHumanSupportRequestQuery(text) {
  return includesAny(text, [
    "connect me to human",
    "connect to human",
    "human support",
    "human agent",
    "support agent",
    "talk to human",
    "speak to human",
    "real person",
    "live agent",
    "customer care",
    "talk to customer care",
    "customer support",
    "connect me to support",
    "connect to support",
    "support executive",
    "customer executive",
    "senior support",
    "talk to senior support",
    "supervisor",
    "manager",
    "escalate to human",
    "need human",
    "i want human",
    "call me",
    "file complaint",
    "raise complaint",
    "complaint",
  ]);
}

function isContextComplaintQuery(text) {
  return includesAny(text, [
    "forgetting previous context",
    "why are you forgetting the previous context",
    "you forgot context",
    "you are forgetting context",
    "previous context",
    "old context",
    "why did you forget",
    "you forgot my order",
    "you are not remembering",
    "remember previous",
  ]);
}

function isOffTopicQuery(text) {
  if (extractOrderId(text) || extractTrackingId(text)) return false;

  return includesAny(text, [
    "tell me a joke",
    "joke",
    "jokes",
    "make me laugh",
    "learn dsa",
    "teach me dsa",
    "write code",
    "solve coding",
    "make website",
    "weather",
    "movie",
    "song",
    "homework",
    "math problem",
  ]);
}

function isTrustQuestionQuery(text) {
  return includesAny(text, [
    "can you help",
    "can u help",
    "can you help me",
    "are you sure you can help me",
    "are sure you can help me",
    "can you really help",
    "what can you do",
    "how can you help",
  ]);
}

function isToneFeedbackQuery(text) {
  return includesAny(text, [
    "rigid bot",
    "you sound rigid",
    "you are robotic",
    "too robotic",
    "you sound like bot",
    "not polite",
    "your tone is bad",
    "same answer again",
    "you are repeating",
  ]);
}

function isFrustration(text) {
  return includesAny(text, [
    "angry",
    "frustrated",
    "upset",
    "annoyed",
    "bad experience",
    "get lost",
    "dumb",
    "stupid",
    "useless",
    "shit",
    "nothing but shit",
  ]);
}

function isNegativeCorrection(text) {
  const q = normalizeForMatching(text);

  if (
    includesAny(q, [
      "don't know",
      "dont know",
      "do not know",
      "not know",
      "order not placed",
      "not placed",
    ])
  ) {
    return false;
  }

  return (
    /\b(no|nope|nah|never)\s+(cancel|return|replace|replacement|exchange|refund|reorder)\b/.test(
      q
    ) ||
    /\bnot\s+(cancel|return|replace|replacement|exchange|refund|reorder)\b/.test(
      q
    ) ||
    /\b(do not|dont|don't)\s+(cancel|return|replace|replacement|exchange|refund|reorder)\b/.test(
      q
    ) ||
    /\bi\s+(do not|dont|don't)\s+want\s+(to\s+)?(cancel|return|replace|replacement|exchange|refund|reorder)\b/.test(
      q
    ) ||
    includesAny(q, [
      "not cancel",
      "not return",
      "not replace",
      "not replacement",
      "not exchange",
      "not refund",
      "not reorder",
      "no cancel",
      "no return",
      "no replacement",
      "no exchange",
      "do not cancel",
      "dont cancel",
      "don't cancel",
      "leave it",
      "changed my mind",
      "keep the order",
      "stop cancellation",
      "cancel the cancellation",
      "cancel this request",
      "cancel the request",
    ])
  );
}

function detectActionSwitchIntent(text = "") {
  const q = normalizeForMatching(text);

  if (
    includesAny(q, [
      "track",
      "tracking",
      "status",
      "staus",
      "where is",
      "details",
    ])
  ) {
    return "track_order";
  }

  if (includesAny(q, ["return"])) return "return_order";
  if (includesAny(q, ["replace", "replacement"])) return "replace_order";
  if (includesAny(q, ["exchange", "exchnage", "exchage"])) {
    return "exchange_order";
  }
  if (includesAny(q, ["refund", "money back"])) return "refund_status";
  if (includesAny(q, ["reorder", "order again", "buy again"])) {
    return "reorder_order";
  }
  if (
    includesAny(q, [
      "payment",
      "paid",
      "charged",
      "deducted",
      "debited",
    ])
  ) {
    return "payment_issue";
  }
  if (includesAny(q, ["cancel"])) return "cancel_order";

  return null;
}
function interpretPendingActionReply(text = "") {
  const q = normalizeForMatching(text);

  const explicitOrderId = extractOrderId(q);
  const explicitTrackingId = extractTrackingId(q);
  const actionSwitchIntent = detectActionSwitchIntent(q);

  if ((explicitOrderId || explicitTrackingId) && actionSwitchIntent) {
    return {
      type: "new_explicit_query",
      intent: actionSwitchIntent,
      orderId: explicitOrderId,
      trackingId: explicitTrackingId,
    };
  }

  const negative =
    /\b(no|nope|nah|never)\b/.test(q) ||
    /\b(do not|dont|don't)\b/.test(q) ||
    includesAny(q, [
      "not now",
      "not required",
      "leave it",
      "stop",
      "hold on",
      "wait",
      "changed my mind",
      "keep the order",
      "do nothing",
      "don't cancel",
      "dont cancel",
      "do not cancel",
      "cancel the request",
      "cancel this request",
    ]);

  const affirmative =
    /\b(yes|yeah|yep|sure|ok|okay|confirm|proceed|continue|fine)\b/.test(q) ||
    includesAny(q, [
      "go ahead",
      "do it",
      "please do",
      "please proceed",
      "sounds good",
      "that works",
      "cancel it",
      "yes cancel",
      "confirm cancellation",
      "go for it",

      // Added for return / replacement / exchange / refund confirmation
      "create request",
      "create it",
      "create return request",
      "raise return request",
      "start return",
      "confirm return",
      "create replacement request",
      "raise replacement request",
      "confirm replacement",
      "create exchange request",
      "raise exchange request",
      "confirm exchange",
      "raise refund issue",
      "raise refund concern",
      "payment support review",
    ]);

  if (negative && !affirmative) return { type: "negative" };
  if (affirmative && !negative) return { type: "affirmative" };

  if (actionSwitchIntent) {
    return {
      type: "action_switch",
      intent: actionSwitchIntent,
    };
  }

  return { type: "unclear" };
}

function generateTicketId(prefix = "CG-SUP") {
  return `${prefix}-${Date.now()
    .toString(36)
    .toUpperCase()}-${Math.floor(100000 + Math.random() * 900000)}`;
}

// =====================================================
// GENERAL POLICY / FAQ RESPONSE HELPERS
// =====================================================

function getPolicyTopicLabel(topic = "") {
  const labels = {
    cancel_order: "cancellation",
    return_order: "return",
    replace_order: "replacement",
    exchange_order: "exchange",
    refund_status: "refund",
    delivery_issue: "delivery",
    track_order: "tracking",
    payment_issue: "payment",
    order_id_help: "order ID",
  };

  return labels[topic] || "order support";
}

function scorePolicyKeywords(text = "", keywords = []) {
  const q = normalizeForMatching(text);

  return keywords.reduce((score, keyword) => {
    const k = normalizeForMatching(keyword);
    if (!k) return score;

    if (q === k) return score + 3;
    if (q.includes(k)) return score + 2;

    const words = k.split(" ").filter(Boolean);
    if (words.length === 1 && new RegExp(`\\b${words[0]}\\b`).test(q)) {
      return score + 1;
    }

    return score;
  }, 0);
}

function hasGeneralPolicyQuestionShape(text = "") {
  const q = normalizeForMatching(text);

  if (!q) return false;

  if (
    /^(can|could|should|would|will|do|does|did|is|are|am|was|were|what|when|where|why|how)\b/.test(
      q
    )
  ) {
    return true;
  }

  return includesAny(q, [
    "policy",
    "allowed",
    "possible",
    "eligible",
    "eligibility",
    "how long",
    "how many days",
    "time limit",
    "window",
    "fee",
    "charge",
    "penalty",
    "documents",
    "document",
    "proof",
    "packaging",
    "opened product",
    "after shipping",
    "after delivery",
    "before delivery",
    "without",
    "timeline",
    "process",
    "procedure",
    "steps",
    "what if",
    "need to",
    "required",
  ]);
}

function detectGeneralPolicyTopic(text = "") {
  const topicScores = [
    {
      topic: "cancel_order",
      issueType: "cancellation",
      score: scorePolicyKeywords(text, [
        "cancel",
        "cancellation",
        "cancelled",
        "canceled",
        "after shipping",
        "before shipping",
      ]),
    },
    {
      topic: "return_order",
      issueType: "return",
      score: scorePolicyKeywords(text, [
        "return",
        "return policy",
        "return window",
        "opened product",
        "packaging",
        "pickup",
        "send back",
      ]),
    },
    {
      topic: "replace_order",
      issueType: "replacement",
      score: scorePolicyKeywords(text, [
        "replace",
        "replacement",
        "defective",
        "not working",
        "damaged product",
        "broken product",
      ]),
    },
    {
      topic: "exchange_order",
      issueType: "exchange",
      score: scorePolicyKeywords(text, [
        "exchange",
        "size change",
        "change size",
        "color change",
        "change color",
        "different size",
      ]),
    },
    {
      topic: "refund_status",
      issueType: "refund",
      score: scorePolicyKeywords(text, [
        "refund",
        "money back",
        "refund timeline",
        "refund pending",
        "bank",
      ]),
    },
    {
      topic: "delivery_issue",
      issueType: "delivery",
      score: scorePolicyKeywords(text, [
        "delivery",
        "delivered",
        "shipping",
        "shipped",
        "courier",
        "delivery agent",
        "address",
        "delay",
        "late",
        "lost",
        "package",
        "parcel",
      ]),
    },
    {
      topic: "track_order",
      issueType: "tracking",
      score: scorePolicyKeywords(text, [
        "track",
        "tracking",
        "tracking id",
        "shipment status",
        "delivery status",
        "latest status",
      ]),
    },
    {
      topic: "payment_issue",
      issueType: "payment",
      score: scorePolicyKeywords(text, [
        "payment",
        "paid",
        "charged",
        "deducted",
        "debited",
        "transaction",
        "upi",
        "card",
      ]),
    },
    {
      topic: "order_id_help",
      issueType: "order_id_help",
      score: scorePolicyKeywords(text, [
        "order id",
        "order number",
        "order no",
        "what does an order id look like",
      ]),
    },
  ];

  const best = topicScores.sort((a, b) => b.score - a.score)[0];

  if (!best || best.score <= 0) return null;

  return best;
}

function detectGeneralPolicyCondition(text = "", topic = "") {
  const q = normalizeForMatching(text);

  if (
    includesAny(q, [
      "after shipping",
      "already shipped",
      "once shipped",
      "after dispatch",
      "dispatched",
    ])
  ) {
    return "after_shipping";
  }

  if (
    includesAny(q, [
      "before delivery",
      "not delivered",
      "not received yet",
      "before receiving",
    ])
  ) {
    return "before_delivery";
  }

  if (includesAny(q, ["after delivery", "after delivered", "delivered"])) {
    return "after_delivery";
  }

  if (
    includesAny(q, ["opened", "open product", "opened product", "used product"])
  ) {
    return "opened_product";
  }

  if (
    includesAny(q, [
      "without packaging",
      "original packaging",
      "box",
      "package missing",
      "packaging",
    ])
  ) {
    return "packaging";
  }

  if (
    includesAny(q, [
      "how many days",
      "how long",
      "return window",
      "time limit",
      "window",
    ])
  ) {
    if (topic === "refund_status") return "refund_timeline";
    return "time_window";
  }

  if (
    includesAny(q, [
      "document",
      "documents",
      "proof",
      "photo",
      "video",
      "invoice",
    ])
  ) {
    return "documents_required";
  }

  if (includesAny(q, ["fee", "charge", "penalty", "cost"])) {
    return "fee";
  }

  if (
    includesAny(q, [
      "delivery agent",
      "courier contact",
      "contact courier",
      "delivery boy",
      "delivery partner",
    ])
  ) {
    return "delivery_contact";
  }

  if (
    includesAny(q, [
      "change delivery date",
      "reschedule",
      "delivery date",
      "change address",
      "address correct",
      "address",
    ])
  ) {
    return "delivery_change";
  }

  if (
    includesAny(q, [
      "delayed",
      "delay",
      "late",
      "lost",
      "frozen",
      "no movement",
    ])
  ) {
    return "delivery_delay";
  }

  if (
    includesAny(q, [
      "refund pending",
      "not received refund",
      "where is my refund",
      "when will i get refund",
    ])
  ) {
    return "refund_pending";
  }

  if (includesAny(q, ["look like", "format", "example"])) {
    return "format_example";
  }

  if (includesAny(q, ["policy", "allowed", "eligible", "eligibility"])) {
    return "policy";
  }

  return "general";
}

function detectGeneralPolicyQuery(text = "") {
  if (extractOrderId(text) || extractTrackingId(text)) return null;

  const q = normalizeForMatching(text);
  const topic = detectGeneralPolicyTopic(q);

  if (!topic) return null;

  const hasQuestionShape = hasGeneralPolicyQuestionShape(q);

  const directActionOnly =
    /^(cancel|return|replace|exchange|refund|track|reorder)(\s+(it|order|my order|this order))?$/.test(
      q
    ) ||
    /^i want to (cancel|return|replace|exchange|refund|track|reorder)\b/.test(
      q
    ) ||
    /^please (cancel|return|replace|exchange|refund|track|reorder)\b/.test(q);

  if (directActionOnly && !hasQuestionShape) return null;
  if (!hasQuestionShape) return null;

  return {
    intent: "general_policy_query",
    confidence: 0.88,
    policyTopic: topic.topic,
    policyCondition: detectGeneralPolicyCondition(q, topic.topic),
    issueType: topic.issueType,
  };
}

function buildGeneralPolicyMessage(policy = {}, session = {}) {
  const topic = policy.policyTopic;
  const condition = policy.policyCondition;

  const currentOrderText = session.lastOrderId
    ? ` If you want, I can also check this against your current order ${session.lastOrderId}.`
    : " If you share your order ID, I can check the exact eligibility for your order.";

  if (topic === "order_id_help") {
    if (condition === "format_example") {
      return "An order ID usually looks like ORD101 or ORD102. You can find it in your order confirmation message, invoice, email, SMS, or order history section.";
    }

    return "Your order ID or order number is usually available in your order confirmation email/SMS, invoice, or order history section. It usually looks like ORD101. Once you share it here, I can check the order for you.";
  }

  if (topic === "cancel_order") {
    if (condition === "after_shipping") {
      return `Usually, once an order has already been shipped or dispatched, cancellation may not be available from the app. You may still be able to reject the delivery if that option is available, or check return/replacement eligibility after delivery.${currentOrderText}`;
    }

    if (condition === "fee") {
      return `Cancellation charges depend on the store policy, product type, and shipment stage. In many cases, cancellation before dispatch does not carry a fee, but after shipping it may not be allowed.${currentOrderText}`;
    }

    return `Cancellation depends mainly on the current order status. Orders are usually easier to cancel before dispatch, while shipped or delivered orders may need return/replacement handling instead.${currentOrderText}`;
  }

  if (topic === "return_order") {
    if (condition === "opened_product") {
      return `Return eligibility for an opened product depends on the product category and condition. Some items can be returned if unused with original accessories, while hygiene, personal-care, or restricted items may not be eligible.${currentOrderText}`;
    }

    if (condition === "packaging") {
      return `Original packaging usually helps during return pickup and quality check. Some products may still be accepted without full packaging, but missing tags, accessories, or damaged packaging can affect approval.${currentOrderText}`;
    }

    if (condition === "time_window") {
      return `The return window depends on the product category and seller policy. Returns are usually allowed only after delivery and within the allowed return period.${currentOrderText}`;
    }

    if (condition === "documents_required") {
      return `For return-related checks, it is useful to keep the invoice, product photos, packaging/accessory details, and a short issue description ready. For damaged or wrong items, photos or videos may be needed.${currentOrderText}`;
    }

    return `Return eligibility depends on the product category, delivery status, condition, and return window. Usually, returns can be requested after delivery within the allowed policy period.${currentOrderText}`;
  }

  if (topic === "replace_order") {
    if (condition === "documents_required") {
      return `For replacement, you may need the invoice, product photos/videos, and a clear description of the issue, especially for damaged, defective, or wrong items.${currentOrderText}`;
    }

    return `Replacement eligibility depends on the product category, delivery status, issue type, and replacement window. It is usually checked after delivery for defective, damaged, or wrong products.${currentOrderText}`;
  }

  if (topic === "exchange_order") {
    return `Exchange depends on product category, availability of the requested size/color/variant, delivery status, and exchange window. If the item is eligible and the new variant is available, an exchange request can usually be raised.${currentOrderText}`;
  }

  if (topic === "refund_status") {
    if (condition === "refund_pending" || condition === "refund_timeline") {
      return `Refund timelines usually depend on the payment method and when the refund was triggered. Refunds are commonly processed after cancellation approval, return pickup/quality check, or payment failure verification.${currentOrderText}`;
    }

    return `Refunds are usually linked to cancellation, return, or payment-failure verification. The exact status depends on the order and payment state.${currentOrderText}`;
  }

  if (topic === "delivery_issue" || topic === "track_order") {
    if (condition === "delivery_contact") {
      return `Courier contact details are usually available only when the shipment is out for delivery and the courier partner shares them. Tracking details are generally the safest way to check movement.${currentOrderText}`;
    }

    if (condition === "delivery_change") {
      return `Changing the delivery date or address depends on the courier partner and shipment stage. It is easier before the package reaches the final delivery stage; once out for delivery, options may be limited.${currentOrderText}`;
    }

    if (condition === "delivery_delay") {
      return `Delivery delays can happen because of courier movement, hub delays, address issues, or manual review. If tracking has no movement for a long time, it should be checked by support.${currentOrderText}`;
    }

    return `Delivery and tracking updates depend on the shipment stage and courier partner. Tracking details usually become available after dispatch and update as the package moves through courier hubs.${currentOrderText}`;
  }

  if (topic === "payment_issue") {
    return "Payment issues such as failed payment, amount deducted, or double charge usually need transaction verification. Keep your payment reference/transaction ID ready, and share the order ID if an order was created.";
  }

  return `This depends on the order status and store policy.${currentOrderText}`;
}

// =====================================================
// RESPONSE HELPERS
// =====================================================

function buildDirectResult(sessionId, query, stage, intent, message, extra = {}) {
  const session = updateSession(sessionId, {
    fallbackCount: 0,
    clarificationCount: 0,
    totalFailureCount: 0,

    lastIntent: extra.lastIntent === undefined ? intent : extra.lastIntent,
    lastOrderId: extra.lastOrderId === undefined ? null : extra.lastOrderId,
    lastTrackingId:
      extra.lastTrackingId === undefined ? null : extra.lastTrackingId,
    lastIssueType: extra.issueType || "general",
    lastStage: stage,
    lastQuery: query,

    pendingIntent: extra.pendingIntent || null,
    pendingMissingEntity: extra.pendingMissingEntity || null,
    pendingIssueType: extra.pendingIssueType || null,
  });

  return {
    success: true,
    stage,
    query,
    sessionId,
    sessionState: session,

    intentResult: {
      intent,
      confidence: extra.confidence || 0.95,
      orderId: extra.lastOrderId || null,
      trackingId: extra.lastTrackingId || null,
      issueType: extra.issueType || "general",
      rawText: query,
      source: extra.source || "app_direct_handler",
    },

    confidenceResult: {
      route: extra.route || "direct_response",
      decision: extra.status || stage,
      requiresEscalation: Boolean(extra.requiresEscalation),
      riskSignals: extra.riskSignals || [],
    },

    orderFound: Boolean(extra.orderSummary),
    orderSummary: extra.orderSummary || null,
    ruleResult: extra.ruleResult || null,

    response: {
      success: true,
      status: extra.status || "OK",
      message,
      customerMessage: message,
    },

    escalation: extra.escalation || {
      ticketRequired: false,
      ticketId: null,
      assignedTeam: null,
      priority: null,
      sla: null,
    },
  };
}

function buildClarification(sessionId, query, intent, message) {
  registerFailure(sessionId, "clarification", { intent }, query);

  updateSession(sessionId, {
    pendingIntent: intent,
    pendingMissingEntity: "orderId",
    pendingIssueType: "general",
  });

  return {
    success: true,
    stage: "clarification",
    query,
    sessionId,
    sessionState: getSession(sessionId),

    intentResult: {
      intent,
      confidence: 0.75,
      orderId: null,
      trackingId: null,
      issueType: "general",
      rawText: query,
      source: "clarification",
    },

    confidenceResult: {
      route: "clarification",
      decision: "missing_order_id",
      requiresEscalation: false,
      riskSignals: [],
    },

    orderFound: false,
    orderSummary: null,
    ruleResult: null,

    response: {
      success: true,
      status: "CLARIFICATION_REQUIRED",
      message,
      customerMessage: message,
    },

    escalation: buildFallbackEscalation({ route: "clarification" }),
  };
}

function buildRepeatedFailureEscalation(
  sessionId,
  session,
  query,
  intentResult,
  confidenceResult
) {
  const ticketId = generateTicketId("CG-REP");

  return {
    success: true,
    stage: "repeated_failure_escalation",
    query,
    sessionId,
    sessionState: session,
    intentResult,
    confidenceResult,
    orderFound: false,
    orderSummary: null,
    ruleResult: null,

    response: {
      success: true,
      status: "ESCALATION_REQUIRED",
      message: `I’m sorry, I’m still not fully understanding this. I’ll mark this conversation for support review. Ticket ID: ${ticketId}.`,
      customerMessage: `I’m sorry, I’m still not fully understanding this. I’ll mark this conversation for support review. Ticket ID: ${ticketId}.`,
    },

    escalation: {
      ticketRequired: true,
      ticketId,
      priority: "MEDIUM",
      assignedTeam: "General Support",
      sla: "1 business day",
      reason: "Repeated clarification/fallback failures.",
      escalationTriggers: ["repeated_failures"],
    },
  };
}

function buildTrackingMessage(order) {
  const status = normalizeStatus(order.status);
  const prettyStatus = statusText(order.status);
  const trackingId =
    order.trackingId ||
    order.awb ||
    order.shipmentId ||
    order.courierTrackingId ||
    null;

  const courier = order.courierPartner || order.courier || null;
  const location =
    order.currentLocation || order.lastKnownLocation || order.location || null;

  const eta =
    order.estimatedDelivery ||
    order.estimatedDeliveryDate ||
    order.expectedDeliveryDate ||
    order.promisedDeliveryDate ||
    null;

  const update = order.lastTrackingUpdate || order.shipmentStatusNote || null;

  if (status === "cancelled") {
    return `I checked order ${order.orderId}. Current status: Cancelled. Delivery tracking is no longer available for this order.${
      order.refundStatus ? ` Refund status: ${order.refundStatus}.` : ""
    }`;
  }

  if (
    status === "processing" ||
    status === "placed" ||
    status === "confirmed" ||
    status === "pending"
  ) {
    return `I checked order ${order.orderId}. Current status: ${prettyStatus}. It has not been dispatched yet. Tracking details usually become available once the order is dispatched.${
      eta ? ` Estimated delivery: ${eta}.` : ""
    }`;
  }

  if (!trackingId) {
    const review = [
      "pending_review",
      "manual_review",
      "status_manual_review",
    ].includes(status)
      ? " This should be reviewed by the support team before moving ahead."
      : "";

    return `I checked order ${order.orderId}. Current status: ${prettyStatus}. Tracking is not available yet. It usually becomes available after dispatch.${review}`;
  }

  let msg = `I checked order ${order.orderId}. Current status: ${prettyStatus}. Tracking ID: ${trackingId}.`;

  if (courier) msg += ` Courier partner: ${courier}.`;
  if (location) msg += ` Current location: ${location}.`;
  if (eta) msg += ` Estimated delivery: ${eta}.`;
  if (update) msg += ` Latest update: ${update}.`;

  if (["lost_in_transit", "delayed", "pending_review"].includes(status)) {
    msg +=
      " I’ll mark this for support review because the current order status may need manual checking.";
  }

  return msg;
}

function buildCancellationAction(sessionId, query, order) {
  const refundNeeded =
    ["upi", "card", "wallet", "netbanking"].includes(
      normalizeStatus(order.paymentMethod)
    ) || ["paid", "captured"].includes(normalizeStatus(order.paymentStatus));

  const current = getSession(sessionId);

  const updatedSession = updateSession(sessionId, {
    pendingAction: null,

    orderOverrides: {
      ...(current.orderOverrides || {}),
      [String(order.orderId).toUpperCase()]: {
        status: "cancelled",
        cancellationStatus: "Cancellation request submitted",
        shipmentStatusNote:
          "Order was cancelled after customer confirmation.",
        currentLocation: null,
        refundStatus: refundNeeded
          ? "Refund initiated"
          : order.refundStatus || null,
      },
    },

    lastIntent: "cancel_order",
    lastOrderId: order.orderId,
    lastTrackingId: order.trackingId || null,
    lastStage: "cancellation_confirmed",
    lastQuery: query,
  });

  const message = refundNeeded
    ? `Your cancellation request for order ${order.orderId} has been confirmed successfully. Since this looks like a prepaid order, the refund has been initiated and will be processed as per the payment method timeline.`
    : `Your cancellation request for order ${order.orderId} has been confirmed successfully. No refund is needed for this payment state.`;

  return {
    success: true,
    stage: "cancellation_confirmed",
    query,
    sessionId,
    sessionState: updatedSession,

    intentResult: {
      intent: "cancel_order",
      confidence: 0.99,
      orderId: order.orderId,
      trackingId: order.trackingId || null,
      issueType: "general",
      rawText: query,
      source: "pending_action_confirmation",
    },

    confidenceResult: {
      route: "rule_engine",
      decision: "cancellation_confirmed",
      requiresEscalation: false,
      riskSignals: [],
    },

    orderFound: true,
    orderSummary: getOrderSummary({ ...order, status: "cancelled" }),

    ruleResult: {
      intent: "cancel_order",
      orderId: order.orderId,
      decision: "cancellation_confirmed",
      allowed: true,
      refundRequired: refundNeeded,
      requiresEscalation: false,
      escalationTriggers: [],
    },

    response: {
      success: true,
      status: "ACTION_COMPLETED",
      message,
      customerMessage: message,
    },

    escalation: {
      ticketRequired: false,
      ticketId: null,
      assignedTeam: null,
      priority: null,
      sla: null,
    },
  };
}

function buildOrderRequestAction(sessionId, query, order, actionType) {
  const configMap = {
    return_order: {
      stage: "return_request_created",
      status: "RETURN_REQUEST_CREATED",
      overrideStatus: "return_requested",
      overrideFields: {
        returnStatus: "Return request created",
        shipmentStatusNote:
          "Return request created after customer confirmation.",
      },
      message: (orderId) =>
        `Your return request for order ${orderId} has been created successfully. We’ll notify you once pickup is scheduled.`,
    },
    replace_order: {
      stage: "replacement_request_created",
      status: "REPLACEMENT_REQUEST_CREATED",
      overrideStatus: "replacement_requested",
      overrideFields: {
        replacementStatus: "Replacement request created",
        shipmentStatusNote:
          "Replacement request created after customer confirmation.",
      },
      message: (orderId) =>
        `Your replacement request for order ${orderId} has been created successfully. We’ll share the next update shortly.`,
    },
    exchange_order: {
      stage: "exchange_request_created",
      status: "EXCHANGE_REQUEST_CREATED",
      overrideStatus: "exchange_requested",
      overrideFields: {
        exchangeStatus: "Exchange request created",
        shipmentStatusNote:
          "Exchange request created after customer confirmation.",
      },
      message: (orderId) =>
        `Your exchange request for order ${orderId} has been created successfully. We’ll notify you about the next step shortly.`,
    },
  };

  const config = configMap[actionType] || configMap.return_order;
  const current = getSession(sessionId);
  const orderKey = String(order.orderId).toUpperCase();

  const updatedSession = updateSession(sessionId, {
    pendingAction: null,

    orderOverrides: {
      ...(current.orderOverrides || {}),
      [orderKey]: {
        status: config.overrideStatus,
        ...config.overrideFields,
      },
    },

    fallbackCount: 0,
    clarificationCount: 0,
    totalFailureCount: 0,

    lastIntent: actionType,
    lastOrderId: order.orderId,
    lastTrackingId: order.trackingId || null,
    lastStage: config.stage,
    lastQuery: query,
  });

  const message = config.message(order.orderId);

  return {
    success: true,
    stage: config.stage,
    query,
    sessionId,
    sessionState: updatedSession,

    intentResult: {
      intent: actionType,
      confidence: 0.99,
      orderId: order.orderId,
      trackingId: order.trackingId || null,
      issueType: getPolicyTopicLabel(actionType),
      rawText: query,
      source: "pending_action_confirmation",
    },

    confidenceResult: {
      route: "rule_engine",
      decision: config.stage,
      requiresEscalation: false,
      riskSignals: [],
    },

    orderFound: true,
    orderSummary: getOrderSummary({
      ...order,
      status: config.overrideStatus,
      ...config.overrideFields,
    }),

    ruleResult: {
      intent: actionType,
      orderId: order.orderId,
      decision: config.stage,
      allowed: true,
      requiresEscalation: false,
      escalationTriggers: [],
    },

    response: {
      success: true,
      status: "ACTION_COMPLETED",
      message,
      customerMessage: message,
    },

    escalation: {
      ticketRequired: false,
      ticketId: null,
      assignedTeam: null,
      priority: null,
      sla: null,
    },
  };
}

function buildRefundSupportAction(sessionId, query, order) {
  const ticketId = generateTicketId("CG-PAY");

  const updatedSession = updateSession(sessionId, {
    pendingAction: null,

    fallbackCount: 0,
    clarificationCount: 0,
    totalFailureCount: 0,

    lastIntent: "refund_status",
    lastOrderId: order.orderId,
    lastTrackingId: order.trackingId || null,
    lastStage: "refund_support_requested",
    lastQuery: query,
    lastHumanTicketId: ticketId,
  });

  const message = `I’ve raised your refund concern for order ${order.orderId}. Our payment support team will review the refund/payment status and update you shortly. Ticket ID: ${ticketId}.`;

  return {
    success: true,
    stage: "refund_support_requested",
    query,
    sessionId,
    sessionState: updatedSession,

    intentResult: {
      intent: "refund_status",
      confidence: 0.99,
      orderId: order.orderId,
      trackingId: order.trackingId || null,
      issueType: "refund",
      rawText: query,
      source: "pending_action_confirmation",
    },

    confidenceResult: {
      route: "support_review",
      decision: "refund_support_requested",
      requiresEscalation: true,
      riskSignals: ["payment_issue"],
    },

    orderFound: true,
    orderSummary: getOrderSummary(order),

    ruleResult: {
      intent: "refund_status",
      orderId: order.orderId,
      decision: "refund_support_requested",
      allowed: true,
      requiresEscalation: true,
      escalationTriggers: ["payment_issue"],
    },

    response: {
      success: true,
      status: "SUPPORT_REVIEW_RAISED",
      message,
      customerMessage: message,
    },

    escalation: {
      ticketRequired: true,
      ticketId,
      assignedTeam: "Payments Support Team",
      priority: "HIGH",
      sla: "1 business day",
      reason: "Refund/payment status needs support review.",
      escalationTriggers: ["payment_issue"],
    },
  };
}

function pendingActionLabel(type = "") {
  const map = {
    confirm_cancel_order: "cancellation",
    confirm_return_order: "return",
    confirm_replace_order: "replacement",
    confirm_exchange_order: "exchange",
    confirm_refund_support: "refund support review",
  };

  return map[type] || "request";
}

function pendingActionIntent(type = "") {
  const map = {
    confirm_cancel_order: "cancel_order",
    confirm_return_order: "return_order",
    confirm_replace_order: "replace_order",
    confirm_exchange_order: "exchange_order",
    confirm_refund_support: "refund_status",
  };

  return map[type] || "general_support";
}

function pendingActionQuestion(type = "", orderId = "") {
  const label = pendingActionLabel(type);

  if (type === "confirm_refund_support") {
    return `Just to confirm, should I raise this refund concern for order ${orderId} with support? Please reply with confirm/proceed, or say no.`;
  }

  return `Just to confirm, should I create the ${label} request for order ${orderId}? Please reply with confirm/proceed, or say no.`;
}

function buildReorderResponse(sessionId, query, order) {
  const status = statusText(order.status);

  const message = `I checked order ${order.orderId}. Current status: ${status}. Reorder means placing a fresh order for the same or similar item; it does not cancel, return, or modify this existing order. You can reorder from your order history/product page. If you want, I can also help track this current order or check cancellation/return eligibility.`;

  return buildDirectResult(
    sessionId,
    query,
    "reorder_guidance",
    "reorder_order",
    message,
    {
      lastIntent: "reorder_order",
      lastOrderId: order.orderId,
      lastTrackingId: order.trackingId || null,
      status: "REORDER_GUIDANCE",
      orderSummary: getOrderSummary(order),
    }
  );
}

// =====================================================
// MAIN PIPELINE
// =====================================================

async function runCartGeniePipeline(userQuery, options = {}) {
  const query = String(userQuery || "").trim();
  const sessionId = options.sessionId || "default_session";
  const session = getSession(sessionId);

  const explicitOrderIdAtStart = extractOrderId(query);
  const explicitTrackingIdAtStart = extractTrackingId(query);
  const earlyActionIntent = detectActionSwitchIntent(query);
    if (!query) {
    return buildDirectResult(
      sessionId,
      query,
      "empty_query",
      "general_support",
      "I didn’t receive a message. Please type your order-related question, for example: track ORD102 or cancel ORD120.",
      {
        status: "CLARIFICATION_REQUIRED",
      }
    );
  }

  if (isResetContext(query)) {
    clearOrderContext(sessionId, "context_reset", query);

    return buildDirectResult(
      sessionId,
      query,
      "context_reset",
      "context_reset",
      "Sure — I’ve cleared the previous context. How can I help you with your new order-related query?",
      {
        lastIntent: null,
        status: "CONTEXT_RESET",
      }
    );
  }

  if (isThanks(query)) {
    clearOrderContext(sessionId, "conversation_end", query);

    return buildDirectResult(
      sessionId,
      query,
      "conversation_end",
      "conversation_end",
      "You’re welcome. I’m here if you need help with another order.",
      {
        lastIntent: null,
        status: "CONVERSATION_END",
      }
    );
  }

  if (isGreeting(query)) {
    updateSession(sessionId, {
      lastIntent: "greeting",
      lastStage: "greeting",
      lastQuery: query,
    });

    return buildDirectResult(
      sessionId,
      query,
      "greeting",
      "greeting",
      "Hi, welcome to CartGenie AI. How can I help you today? If your request is related to an order, you can share an order ID like ORD101.",
      {
        status: "GREETING",
      }
    );
  }

  if (isUnsafeRequestQuery(query)) {
    clearOrderContext(sessionId, "unsafe_request", query);

    return buildDirectResult(
      sessionId,
      query,
      "unsafe_request",
      "unsafe_request",
      "I can’t help with requests that involve private customer data, internal access, logs, secrets, or bypassing system rules. I can still help with order tracking, cancellation, return, replacement, refund, or delivery support.",
      {
        status: "UNSAFE_REQUEST_BLOCKED",
        requiresEscalation: true,
        riskSignals: ["unsafe_request"],
      }
    );
  }

  if (isOffTopicQuery(query)) {
    return buildDirectResult(
      sessionId,
      query,
      "off_topic",
      "off_topic",
      "I’m focused on CartGenie order support. I can help with tracking, cancellation, return, replacement, exchange, refund, payment, or delivery issues.",
      {
        status: "OFF_TOPIC_REDIRECT",
      }
    );
  }

  if (isOrderIdFaq(query)) {
    return buildDirectResult(
      sessionId,
      query,
      "order_id_help",
      "order_id_help",
      "Your order ID or order number is usually available in your order confirmation email/SMS, invoice, or order history section. It usually looks like ORD101. Once you share it here, I can check the order for you.",
      {
        status: "ORDER_ID_HELP",
      }
    );
  }

  if (isTrustQuestionQuery(query)) {
    return buildDirectResult(
      sessionId,
      query,
      "trust_question",
      "trust_question",
      "Yes, I can help you step by step with order-related issues like tracking, cancellation, return, replacement, exchange, refund, payment, and delivery concerns.",
      {
        status: "TRUST_RESPONSE",
      }
    );
  }

  if (isToneFeedbackQuery(query)) {
    return buildDirectResult(
      sessionId,
      query,
      "tone_feedback",
      "tone_feedback",
      "You’re right — I’ll keep it clearer and more helpful. Please tell me your order issue, and I’ll guide you step by step.",
      {
        status: "TONE_ACKNOWLEDGED",
      }
    );
  }

  if (isNegativeCorrection(query)) {
    updateSession(sessionId, {
      pendingAction: null,
      pendingIntent: null,
      pendingMissingEntity: null,
      pendingIssueType: null,
      lastStage: "negative_correction",
      lastQuery: query,
    });

    return buildDirectResult(
      sessionId,
      query,
      "negative_correction",
      "negative_correction",
      session.lastOrderId
        ? `No problem — I won’t continue with that previous request for order ${session.lastOrderId}. Please tell me what you’d like to do instead.`
        : "No problem — I won’t continue with that previous request. Please tell me what you’d like to do instead.",
      {
        status: "NEGATIVE_CORRECTION",
        lastOrderId: session.lastOrderId,
      }
    );
  }

  if (isContextComplaintQuery(query)) {
    const orderText = explicitOrderIdAtStart
      ? ` I have ${explicitOrderIdAtStart} from your message.`
      : session.lastOrderId
      ? ` I still have your previous order context as ${session.lastOrderId}.`
      : " I don’t have a clear order context right now.";

    return buildDirectResult(
      sessionId,
      query,
      "context_complaint",
      "context_complaint",
      `I understand. I’ll use the available context more carefully.${orderText} Please tell me what you want to do next, and I’ll continue from there.`,
      {
        status: "CONTEXT_ACKNOWLEDGED",
        lastOrderId: explicitOrderIdAtStart || session.lastOrderId || null,
      }
    );
  }

  if (isFrustration(query) && !earlyActionIntent && !explicitOrderIdAtStart) {
    return buildDirectResult(
      sessionId,
      query,
      "customer_frustration",
      "customer_frustration",
      "I’m sorry this has been frustrating. I’ll help you fix it step by step. Please share your order ID and the issue, and I’ll check the right next action.",
      {
        status: "FRUSTRATION_ACKNOWLEDGED",
        requiresEscalation: true,
        riskSignals: ["angry_customer"],
      }
    );
  }

  // -----------------------------------------------------
  // Pending return / replacement / exchange / refund action
  // -----------------------------------------------------
  if (
    session.pendingAction &&
    [
      "confirm_return_order",
      "confirm_replace_order",
      "confirm_exchange_order",
      "confirm_refund_support",
    ].includes(session.pendingAction.type)
  ) {
    const interpretation = interpretPendingActionReply(query);
    const pendingAction = session.pendingAction;
    const pendingOrderId = pendingAction?.orderId || session.lastOrderId || null;
    const pendingIntent = pendingActionIntent(pendingAction?.type);

    if (interpretation.type === "negative") {
      updateSession(sessionId, {
        pendingAction: null,
        lastIntent: pendingIntent,
        lastOrderId: pendingOrderId,
        lastStage: "action_cancelled_by_user",
        lastQuery: query,
      });

      return buildDirectResult(
        sessionId,
        query,
        "action_cancelled_by_user",
        pendingIntent,
        pendingOrderId
          ? `No problem — I won’t continue with the ${pendingActionLabel(
              pendingAction.type
            )} request for order ${pendingOrderId}.`
          : "No problem — I won’t continue with that request.",
        {
          lastIntent: pendingIntent,
          lastOrderId: pendingOrderId,
          status: "ACTION_NOT_CONFIRMED",
        }
      );
    }

    if (interpretation.type === "affirmative") {
      const order = findOrderForSession(pendingOrderId, session);

      if (order && pendingAction.type === "confirm_refund_support") {
        return buildRefundSupportAction(sessionId, query, order);
      }

      if (order) {
        return buildOrderRequestAction(sessionId, query, order, pendingIntent);
      }

      updateSession(sessionId, {
        pendingAction: null,
      });
    }

    if (
      interpretation.type === "unclear" &&
      !explicitOrderIdAtStart &&
      !explicitTrackingIdAtStart
    ) {
      return buildDirectResult(
        sessionId,
        query,
        "action_confirmation_needed",
        pendingIntent,
        pendingActionQuestion(pendingAction.type, pendingOrderId),
        {
          lastIntent: pendingIntent,
          lastOrderId: pendingOrderId,
          status: "CONFIRMATION_REQUIRED",
          pendingIntent,
        }
      );
    }

    if (
      interpretation.type === "action_switch" ||
      interpretation.type === "new_explicit_query"
    ) {
      updateSession(sessionId, {
        pendingAction: null,
      });
    }
  }

  // -----------------------------------------------------
  // Existing cancellation pending action
  // -----------------------------------------------------
  if (
    session.pendingAction &&
    session.pendingAction.type === "confirm_cancel_order"
  ) {
    const interpretation = interpretPendingActionReply(query);

    if (interpretation.type === "negative") {
      const pendingAction = session.pendingAction;
      const pendingOrderId =
        pendingAction?.orderId || session.lastOrderId || null;

      updateSession(sessionId, {
        pendingAction: null,
        lastIntent: "cancel_order",
        lastOrderId: pendingOrderId,
        lastStage: "action_cancelled_by_user",
        lastQuery: query,
      });

      return buildDirectResult(
        sessionId,
        query,
        "action_cancelled_by_user",
        "cancel_order",
        pendingOrderId
          ? `No problem — I won’t continue with cancellation for order ${pendingOrderId}. The order has not been cancelled.`
          : "No problem — I won’t continue with that cancellation request. The order has not been cancelled.",
        {
          lastIntent: "cancel_order",
          lastOrderId: pendingOrderId,
          status: "ACTION_NOT_CONFIRMED",
        }
      );
    }

    if (interpretation.type === "affirmative") {
      const order = findOrderForSession(session.pendingAction.orderId, session);

      if (order && isCancellableStatus(order.status)) {
        return buildCancellationAction(sessionId, query, order);
      }

      updateSession(sessionId, {
        pendingAction: null,
      });
    }

    if (
      interpretation.type === "unclear" &&
      !explicitOrderIdAtStart &&
      !explicitTrackingIdAtStart
    ) {
      return buildDirectResult(
        sessionId,
        query,
        "action_confirmation_needed",
        "cancel_order",
        `Just to confirm, should I cancel order ${session.pendingAction.orderId}? Please reply with confirm/proceed, or say no/keep the order.`,
        {
          lastIntent: "cancel_order",
          lastOrderId: session.pendingAction.orderId,
          status: "CONFIRMATION_REQUIRED",
          pendingIntent: "cancel_order",
        }
      );
    }

    if (
      interpretation.type === "action_switch" ||
      interpretation.type === "new_explicit_query"
    ) {
      updateSession(sessionId, {
        pendingAction: null,
      });
    }
  }

  // -----------------------------------------------------
  // General policy / FAQ detection before forcing order ID
  // -----------------------------------------------------
  const generalPolicy = detectGeneralPolicyQuery(query);

  if (generalPolicy) {
    return buildDirectResult(
      sessionId,
      query,
      "general_policy_response",
      generalPolicy.intent,
      buildGeneralPolicyMessage(generalPolicy, session),
      {
        confidence: generalPolicy.confidence,
        issueType: generalPolicy.issueType,
        source: "general_policy_detector",
        status: "GENERAL_POLICY_RESPONSE",
      }
    );
  }

  // -----------------------------------------------------
  // Resolve follow-up intent using previous order context
  // -----------------------------------------------------
  let rawIntentResult = detectIntentAndEntities(query, { session });

  const actionIntent = earlyActionIntent;

  if (
    actionIntent &&
    !rawIntentResult.orderId &&
    !rawIntentResult.trackingId &&
    session.lastOrderId
  ) {
    rawIntentResult = {
      ...rawIntentResult,
      intent: actionIntent,
      confidence: Math.max(rawIntentResult.confidence || 0, 0.9),
      orderId: session.lastOrderId,
      trackingId: session.lastTrackingId || null,
      issueType: intentFriendlyName(actionIntent),
      source: "session_context_action_switch",
    };
  }

  let intentResult = rawIntentResult;

  if (
    intentResult.intent === "order_reference_only" &&
    session.pendingIntent &&
    ORDER_REQUIRED_INTENTS.has(session.pendingIntent)
  ) {
    intentResult = {
      ...intentResult,
      intent: session.pendingIntent,
      confidence: Math.max(intentResult.confidence || 0, 0.9),
      issueType: session.pendingIssueType || intentFriendlyName(session.pendingIntent),
      source: "pending_intent_order_resolution",
    };
  }

  if (intentResult.intent === "human_support") {
    updateSession(sessionId, {
      pendingHumanSupport: true,
      pendingHumanSupportStage: intentResult.orderId
        ? "awaiting_issue_description"
        : "awaiting_order_and_issue",
      pendingIntent: "human_support",
      lastIntent: "human_support",
      lastOrderId: intentResult.orderId || session.lastOrderId || null,
      lastStage: "human_support_requested_info_needed",
      lastQuery: query,
    });

    const message = intentResult.orderId
      ? `I can connect you to support if needed. I have order ${intentResult.orderId}. Please briefly tell me the issue first — tracking, cancellation, return, refund, payment, delivery, replacement, or exchange. I’ll check it here, and if it needs manual review, I’ll route it to the right support team.`
      : "I can connect you to support if needed. Before I do that, please share your order ID and briefly tell me the issue. I’ll first check if I can resolve it here, and if it needs manual review, I’ll route it to the right support team.";

    return buildDirectResult(
      sessionId,
      query,
      "human_support_requested_info_needed",
      "human_support",
      message,
      {
        lastIntent: "human_support",
        lastOrderId: intentResult.orderId || session.lastOrderId || null,
        status: "INFO_NEEDED_BEFORE_ESCALATION",
        requiresEscalation: false,
        riskSignals: ["customer_requested_human_support"],
      }
    );
  }

  if (intentResult.intent === "order_reference_only") {
    const order = findOrderForSession(
      intentResult.orderId,
      getSession(sessionId)
    );

    updateSession(sessionId, {
      lastIntent: "order_reference_only",
      lastOrderId: intentResult.orderId,
      lastTrackingId: order?.trackingId || null,
      lastStage: "context_resolution",
      lastQuery: query,
    });

    const message = order
      ? `Thanks for sharing order ${intentResult.orderId}. I found this order. Please tell me what you’d like to do next: track it, cancel it, return it, replace it, exchange it, reorder it, or check refund/payment status.`
      : `I’m sorry, I could not find order ${intentResult.orderId} in our records. Please check the order ID once and share it again.`;

    return buildDirectResult(
      sessionId,
      query,
      "context_resolution",
      "order_reference_only",
      message,
      {
        lastOrderId: intentResult.orderId,
        lastTrackingId: order?.trackingId || null,
        status: "CLARIFICATION_REQUIRED",
        orderSummary: order ? getOrderSummary(order) : null,
      }
    );
  }

  if (
    ORDER_REQUIRED_INTENTS.has(intentResult.intent) &&
    !intentResult.orderId &&
    !intentResult.trackingId
  ) {
    return buildClarification(
      sessionId,
      query,
      intentResult.intent,
      `Sure, I can help with your ${intentFriendlyName(
        intentResult.intent
      )} request. Please share your order ID, like ORD101, so I can check the latest status and guide you with the correct next step.`
    );
  }

  const confidenceResult = evaluateConfidence(intentResult, { query });

  if (
    confidenceResult.route === "clarification" &&
    !intentResult.orderId &&
    !intentResult.trackingId
  ) {
    return buildClarification(
      sessionId,
      query,
      intentResult.intent,
      `Sure, I can help with your ${intentFriendlyName(
        intentResult.intent
      )} request. Please share your order ID, like ORD101, so I can check the latest status and guide you with the correct next step.`
    );
  }

  if (confidenceResult.route === "fallback_llm" && !actionIntent) {
    const failureSession = registerFailure(
      sessionId,
      "fallback",
      intentResult,
      query
    );

    if (failureSession.totalFailureCount >= REPEATED_FAILURE_LIMIT) {
      return buildRepeatedFailureEscalation(
        sessionId,
        failureSession,
        query,
        intentResult,
        confidenceResult
      );
    }

    return {
      success: true,
      stage: "fallback",
      query,
      sessionId,
      sessionState: failureSession,
      intentResult,
      confidenceResult,
      orderFound: false,
      orderSummary: null,
      ruleResult: null,
      response: generateFallbackResponse(
        confidenceResult,
        intentResult,
        failureSession
      ),
      escalation: buildFallbackEscalation(confidenceResult),
    };
  }

  const order =
    findOrderForSession(intentResult.orderId, getSession(sessionId)) ||
    findOrderByTrackingIdForSession(
      intentResult.trackingId,
      getSession(sessionId)
    );

  if (ORDER_REQUIRED_INTENTS.has(intentResult.intent) && !order) {
    return buildDirectResult(
      sessionId,
      query,
      "order_not_found",
      intentResult.intent,
      `I’m sorry, I could not find order ${
        intentResult.orderId || intentResult.trackingId || "provided"
      } in our records. Please check the ID once and share it again.`,
      {
        status: "ORDER_NOT_FOUND",
      }
    );
  }

  if (intentResult.intent === "track_order" && order) {
    resetFailures(
      sessionId,
      {
        ...intentResult,
        orderId: order.orderId,
        trackingId: order.trackingId || intentResult.trackingId,
      },
      query
    );

    return buildDirectResult(
      sessionId,
      query,
      "completed",
      "track_order",
      buildTrackingMessage(order),
      {
        lastIntent: "track_order",
        lastOrderId: order.orderId,
        lastTrackingId: order.trackingId || null,
        status: "TRACKING_STATUS",
        orderSummary: getOrderSummary(order),
      }
    );
  }

  if (intentResult.intent === "reorder_order" && order) {
    return buildReorderResponse(sessionId, query, order);
  }

  const ruleResult = applyRules({
    intent: intentResult.intent,
    order,
    issueType: intentResult.issueType || "general",
  });

  if (confidenceResult.requiresEscalation) {
    ruleResult.requiresEscalation = true;
    ruleResult.escalationTriggers = [
      ...new Set([
        ...(ruleResult.escalationTriggers || []),
        ...(confidenceResult.riskSignals || []),
      ]),
    ];
  }

  let response = generateResponse(ruleResult);

  if (
    intentResult.intent === "cancel_order" &&
    order &&
    isCancellableStatus(order.status) &&
    ruleResult &&
    ruleResult.allowed === true
  ) {
    updateSession(sessionId, {
      pendingAction: {
        type: "confirm_cancel_order",
        orderId: order.orderId,
        intent: "cancel_order",
        createdAt: Date.now(),
      },

      fallbackCount: 0,
      clarificationCount: 0,
      totalFailureCount: 0,

      lastIntent: "cancel_order",
      lastOrderId: order.orderId,
      lastTrackingId: order.trackingId || null,
      lastIssueType: intentResult.issueType || "general",
      lastStage: "awaiting_action_confirmation",
      lastQuery: query,
    });

    const confirmMsg = `Sure, I checked this for you. Order ${order.orderId} is eligible for cancellation because it has not been dispatched yet. Would you like me to confirm the cancellation request now?`;

    response = {
      success: true,
      status: "CONFIRMATION_REQUIRED",
      message: confirmMsg,
      customerMessage: confirmMsg,
      suggestedActions: ["Yes, cancel it", "No, do not cancel"],
      metadata: {
        pendingAction: "confirm_cancel_order",
        orderId: order.orderId,
      },
    };
  } else if (response?.metadata?.pendingAction && order) {
    updateSession(sessionId, {
      pendingAction: {
        type: response.metadata.pendingAction,
        orderId: order.orderId,
        intent: intentResult.intent,
        createdAt: Date.now(),
      },

      fallbackCount: 0,
      clarificationCount: 0,
      totalFailureCount: 0,

      lastIntent: intentResult.intent,
      lastOrderId: order.orderId,
      lastTrackingId: order.trackingId || null,
      lastIssueType: intentResult.issueType || "general",
      lastStage: "awaiting_action_confirmation",
      lastQuery: query,
    });
  } else {
    resetFailures(
      sessionId,
      {
        ...intentResult,
        orderId: order?.orderId || intentResult.orderId,
        trackingId: order?.trackingId || intentResult.trackingId,
      },
      query
    );
  }

  const escalation = handleEscalation(ruleResult, {
    query,
    customerTone: (confidenceResult.riskSignals || []).includes(
      "angry_customer"
    )
      ? "angry"
      : "neutral",
    source: "api",
  });

  return {
    success: true,
    stage: "completed",
    query,
    sessionId,
    sessionState: getSession(sessionId),

    intentResult: {
      ...intentResult,
      orderId: order?.orderId || intentResult.orderId,
      trackingId: order?.trackingId || intentResult.trackingId,
    },

    confidenceResult,
    orderFound: Boolean(order),
    orderSummary: getOrderSummary(order),
    ruleResult,
    response,
    escalation,
  };
}

// =====================================================
// ROUTES
// =====================================================

app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "CartGenie Multi-Agent Customer Support API is running.",
    endpoints: {
      health: "GET /health",
      support: "POST /api/support",
      orders: "GET /api/orders",
      orderById: "GET /api/orders/:orderId",
      sessions: "GET /api/sessions",
      sessionById: "GET /api/sessions/:sessionId",
      resetSession: "DELETE /api/sessions/:sessionId",
      auditLogs: "GET /api/audit-logs",
      errorLogs: "GET /api/error-logs",
    },
  });
});

app.get("/health", (req, res) => {
  res.json({
    success: true,
    status: "OK",
    service: "cartgenie-backend",
    port: PORT,
    timestamp: new Date().toISOString(),
  });
});

app.get("/api/orders", (req, res) => {
  res.json({
    success: true,
    count: orders.length,
    orders,
  });
});

app.get("/api/orders/:orderId", (req, res) => {
  const orderId = String(req.params.orderId || "").toUpperCase();
  const order = findOrder(orderId);

  if (!order) {
    return res.status(404).json({
      success: false,
      message: `Order ${orderId} not found.`,
    });
  }

  return res.json({
    success: true,
    order,
  });
});

app.get("/api/sessions", (req, res) => {
  res.json({
    success: true,
    count: Object.keys(sessionStore).length,
    sessions: sessionStore,
  });
});

app.get("/api/sessions/:sessionId", (req, res) => {
  const sessionId = req.params.sessionId;

  res.json({
    success: true,
    session: getSession(sessionId),
  });
});

app.delete("/api/sessions/:sessionId", (req, res) => {
  const sessionId = req.params.sessionId;

  delete sessionStore[sessionId];

  res.json({
    success: true,
    message: `Session ${sessionId} cleared.`,
  });
});

app.get("/api/audit-logs", (req, res) => {
  const limit = Number(req.query.limit) || 20;

  res.json({
    success: true,
    count: limit,
    logs: readRecentAuditLogs(limit),
  });
});

app.get("/api/error-logs", (req, res) => {
  const limit = Number(req.query.limit) || 20;

  res.json({
    success: true,
    count: limit,
    logs: readRecentErrorLogs(limit),
  });
});

app.post("/api/support", async (req, res) => {
  try {
    const { query, sessionId } = req.body || {};

    if (!query || typeof query !== "string" || query.trim().length === 0) {
      return res.status(200).json({
        success: true,
        status: "CLARIFICATION_REQUIRED",
        message:
          "I didn’t receive a message. Please type your order-related question, for example: track ORD102 or cancel ORD120.",
        customerMessage:
          "I didn’t receive a message. Please type your order-related question, for example: track ORD102 or cancel ORD120.",
      });
    }

    const safeSessionId =
      typeof sessionId === "string" && sessionId.trim()
        ? sessionId.trim()
        : "default_session";

    const result = await runCartGeniePipeline(query.trim(), {
      sessionId: safeSessionId,
    });

    logAuditEvent({
      ...result,
      requestId: req.headers["x-request-id"] || null,
      sessionId: safeSessionId,
    });

    return res.json(result);
  } catch (error) {
    console.error("CartGenie API Error:", error);

    logErrorEvent({
      requestId: req.headers["x-request-id"] || null,
      sessionId: req.body?.sessionId || null,
      query: req.body?.query || null,
      message: error.message,
      stack: error.stack,
      source: "POST /api/support",
    });

    return res.status(500).json({
      success: false,
      status: "SERVER_ERROR",
      message:
        "Sorry, something went wrong while processing your request. Please try again in a moment.",
      customerMessage:
        "Sorry, something went wrong while processing your request. Please try again in a moment.",
      error:
        process.env.NODE_ENV === "production" ? undefined : error.message,
    });
  }
});

// =====================================================
// SERVER START
// =====================================================

app.listen(PORT, () => {
  console.log(`✅ CartGenie API running on http://localhost:${PORT}`);
  console.log(`🚀 POST endpoint: http://localhost:${PORT}/api/support`);
  console.log(`🧾 Audit logs: http://localhost:${PORT}/api/audit-logs`);
});

module.exports = {
  app,
  runCartGeniePipeline,
  sessionStore,
};