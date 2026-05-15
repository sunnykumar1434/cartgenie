"use strict";

/**
 * intentAgent.js
 *
 * Deterministic intent + entity detection for CartGenie.
 *
 * Goals:
 * - Keep business-critical ecommerce routing stable.
 * - Prevent reorder from becoming cancel/return.
 * - Detect tracking/status/details naturally.
 * - Detect off-topic, unsafe, context complaint, tone feedback, anger, trust questions.
 * - Avoid "order null" cases for order ID help queries.
 * - Keep this file synchronous so app.js can call it directly.
 */

const DEFAULT_MIN_CONFIDENCE = 0.5;

const INTENTS = {
  GREETING: "greeting",
  CONVERSATION_END: "conversation_end",
  CONTEXT_RESET: "context_reset",

  GENERAL_SUPPORT: "general_support",
  GENERAL_POLICY_QUERY: "general_policy_query",
  OFF_TOPIC: "off_topic",

  ORDER_REFERENCE_ONLY: "order_reference_only",
  ORDER_ID_HELP: "order_id_help",

  TRACK_ORDER: "track_order",
  CANCEL_ORDER: "cancel_order",
  RETURN_ORDER: "return_order",
  REPLACE_ORDER: "replace_order",
  EXCHANGE_ORDER: "exchange_order",
  REORDER_ORDER: "reorder_order",

  REFUND_STATUS: "refund_status",
  PAYMENT_ISSUE: "payment_issue",
  DELIVERY_ISSUE: "delivery_issue",

  MISSING_ITEM: "missing_item",
  WRONG_ITEM: "wrong_item",
  DAMAGED_ITEM: "damaged_item",

  HUMAN_SUPPORT: "human_support",
  NEGATIVE_CORRECTION: "negative_correction",

  CUSTOMER_FRUSTRATION: "customer_frustration",
  ABUSIVE_USER: "abusive_user",
  RUDE_USER: "rude_user",
  TONE_FEEDBACK: "tone_feedback",
  TRUST_QUESTION: "trust_question",
  CONTEXT_COMPLAINT: "context_complaint",

  UNSAFE_REQUEST: "unsafe_request"
};

const ORDER_REQUIRED_INTENTS = new Set([
  INTENTS.TRACK_ORDER,
  INTENTS.CANCEL_ORDER,
  INTENTS.RETURN_ORDER,
  INTENTS.REPLACE_ORDER,
  INTENTS.EXCHANGE_ORDER,
  INTENTS.REORDER_ORDER,
  INTENTS.REFUND_STATUS,
  INTENTS.PAYMENT_ISSUE,
  INTENTS.DELIVERY_ISSUE,
  INTENTS.MISSING_ITEM,
  INTENTS.WRONG_ITEM,
  INTENTS.DAMAGED_ITEM
]);

// =====================================================
// BASIC HELPERS
// =====================================================

function normalizeText(value = "") {
  return String(value || "")
    .toLowerCase()
    .trim()
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, " ");
}

function normalizeForMatching(value = "") {
  return normalizeText(value)
    .replace(/[-_]/g, " ")
    .replace(/[^\w\s']/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function includesAny(text = "", patterns = []) {
  const clean = normalizeForMatching(text);

  return patterns.some((pattern) =>
    clean.includes(normalizeForMatching(pattern))
  );
}

function matchesAny(text = "", regexList = []) {
  return regexList.some((regex) => regex.test(text));
}

function clampConfidence(value, fallback = DEFAULT_MIN_CONFIDENCE) {
  const parsed = Number(value);

  if (!Number.isFinite(parsed)) return fallback;
  if (parsed < 0) return 0;
  if (parsed > 1) return 1;

  return parsed;
}

function makeResult({
  intent,
  confidence = 0.8,
  orderId = null,
  trackingId = null,
  issueType = "general",
  rawText = "",
  source = "deterministic_intent_agent",
  entities = {},
  metadata = {}
}) {
  const normalizedOrderId = orderId ? normalizeOrderId(orderId) : null;
  const normalizedTrackingId = trackingId
    ? normalizeTrackingId(trackingId)
    : null;

  return {
    intent,
    confidence: clampConfidence(confidence),
    orderId: normalizedOrderId,
    trackingId: normalizedTrackingId,
    issueType,
    rawText,
    source,
    entities: {
      orderId: normalizedOrderId,
      trackingId: normalizedTrackingId,
      ...entities
    },
    metadata
  };
}

// =====================================================
// ENTITY EXTRACTION
// =====================================================

function normalizeOrderId(value = "") {
  const raw = String(value || "").toUpperCase().replace(/\s+/g, "");

  const direct = raw.match(/\bORD-?(\d+)\b/i);
  if (direct) return `ORD${direct[1]}`;

  const typo = raw.match(/\bODR-?(\d+)\b/i);
  if (typo) return `ORD${typo[1]}`;

  const digits = raw.match(/^(\d+)$/);
  if (digits) return `ORD${digits[1]}`;

  return raw.replace(/[^A-Z0-9]/g, "");
}

function normalizeTrackingId(value = "") {
  const raw = String(value || "").toUpperCase().replace(/\s+/g, "");

  const direct = raw.match(/\b(TRK|AWB)-?(\d+)\b/i);
  if (direct) return `${direct[1].toUpperCase()}${direct[2]}`;

  return raw.replace(/[^A-Z0-9]/g, "");
}

function extractOrderId(text = "") {
  const raw = String(text || "");

  let match = raw.match(/\bORD\s*-?\s*(\d+)\b/i);
  if (match) return `ORD${match[1]}`.toUpperCase();

  match = raw.match(/\bODR\s*-?\s*(\d+)\b/i);
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
  if (match) return `${match[1].toUpperCase()}${match[2]}`;

  return null;
}

function hasExplicitOrderId(text = "") {
  return Boolean(extractOrderId(text));
}

function hasExplicitTrackingId(text = "") {
  return Boolean(extractTrackingId(text));
}

// =====================================================
// QUERY TYPE DETECTORS
// =====================================================

function isEmptyOrTooShort(text = "") {
  const q = normalizeForMatching(text);
  return !q || q.length <= 1;
}

function isGreeting(text = "") {
  const q = normalizeForMatching(text);

  const exactGreetings = new Set([
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
    "hlo",
    "hola",
    "namaste",
    "good morning",
    "good afternoon",
    "good evening"
  ]);

  if (exactGreetings.has(q)) return true;

  return matchesAny(q, [
    /^(hi|hello|hey|hlw|hlo)\s+(there|cartgenie|bot)?$/,
    /^(good morning|good afternoon|good evening)$/
  ]);
}

function isConversationEnd(text = "") {
  const q = normalizeForMatching(text);

  const exact = new Set([
    "thanks",
    "thank you",
    "thankyou",
    "thanks a lot",
    "thank you so much",
    "ok thanks",
    "okay thanks",
    "got it",
    "done",
    "ok done",
    "okay",
    "ok",
    "cool",
    "great",
    "perfect",
    "bye",
    "goodbye"
  ]);

  return exact.has(q);
}

function isContextReset(text = "") {
  const q = normalizeForMatching(text);

  return [
    "new query",
    "its a new query",
    "it s a new query",
    "it's a new query",
    "start new query",
    "start fresh",
    "start over",
    "fresh query",
    "reset",
    "reset chat",
    "clear context",
    "clear previous context",
    "forget previous",
    "forget previous order",
    "forget old order",
    "different order",
    "new request"
  ].some(
    (p) =>
      q === normalizeForMatching(p) ||
      q.includes(normalizeForMatching(p))
  );
}

function isOrderIdHelp(text = "") {
  const q = normalizeForMatching(text);

  return (
    includesAny(q, [
      "how can i check order id",
      "how to check order id",
      "how can i find order id",
      "how do i find order id",
      "where can i find order id",
      "where is order id",
      "where is my order id",
      "where can i see order id",
      "where can i see my order id",
      "how can fond ord id",
      "how can find ord id",
      "find ord id",
      "fond ord id",
      "what is order id",
      "what is my order id",
      "i dont know my order id",
      "i don't know my order id",
      "where can i get order number",
      "how can i get order number",
      "where is order number",
      "order id kaha",
      "order id kaise"
    ]) ||
    matchesAny(q, [
      /\bhow\b.*\b(find|fond|check|get|see)\b.*\b(ord|order)\b.*\bid\b/,
      /\bwhere\b.*\b(ord|order)\b.*\bid\b/,
      /\b(ord|order)\b.*\bid\b.*\bwhere\b/
    ])
  );
}

function isHumanSupport(text = "") {
  const q = normalizeForMatching(text);

  return includesAny(q, [
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
    "call me",
    "i want human",
    "need human",
    "escalate to human",
    "raise ticket",
    "create ticket"
  ]);
}

function isNegativeCorrection(text = "") {
  const q = normalizeForMatching(text);

  return (
    matchesAny(q, [
      /^(no|nope|nah)?\s*not\s+(cancel|return|replace|replacement|exchange|refund|track|reorder)\b/,
      /\bi do not want\s+(cancel|return|replace|replacement|exchange|refund|reorder)\b/,
      /\bi dont want\s+(cancel|return|replace|replacement|exchange|refund|reorder)\b/,
      /\bdon't\s+(cancel|return|replace|replacement|exchange|refund|reorder)\b/,
      /\bdont\s+(cancel|return|replace|replacement|exchange|refund|reorder)\b/
    ]) ||
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
      "keep the order"
    ])
  );
}

function isUnsafeRequest(text = "") {
  const q = normalizeForMatching(text);

  return includesAny(q, [
    "ignore previous instructions",
    "ignore all instructions",
    "ignore your instructions",
    "bypass policy",
    "bypass rules",
    "bypass the policy",
    "delete logs",
    "delete all logs",
    "remove logs",
    "clear logs",
    "give me admin access",
    "admin access",
    "show api key",
    "show secret",
    "show secrets",
    "system prompt",
    "developer message",
    "jailbreak",
    "private system information",
    "internal policy",
    "override policy"
  ]);
}

function isTrustQuestion(text = "") {
  const q = normalizeForMatching(text);

  return (
    includesAny(q, [
      "can you help",
      "can u help",
      "can you help me",
      "are you sure you can help me",
      "are sure you can help me",
      "can you really help",
      "will you help me",
      "do you help",
      "what can you do",
      "how can you help"
    ]) ||
    matchesAny(q, [
      /\bare\s+you\s+sure\b.*\bhelp\b/,
      /\bcan\s+you\b.*\bhelp\b/,
      /\bwhat\b.*\bcan\b.*\byou\b.*\bdo\b/
    ])
  );
}

function isToneFeedback(text = "") {
  const q = normalizeForMatching(text);

  return includesAny(q, [
    "rigid bot",
    "you are sounding like a rigid bot",
    "you sound rigid",
    "you are robotic",
    "too robotic",
    "you sound like bot",
    "bad response",
    "not polite",
    "you are not polite",
    "your tone is bad",
    "you are repeating",
    "same answer again",
    "you are not understanding",
    "you dont understand",
    "you don't understand"
  ]);
}

function isContextComplaint(text = "") {
  const q = normalizeForMatching(text);

  return includesAny(q, [
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
    "why are you forgetting"
  ]);
}

function isAbusiveUser(text = "") {
  const q = normalizeForMatching(text);

  return includesAny(q, [
    "you are dumb",
    "you are so dumb",
    "stupid",
    "idiot",
    "shit",
    "bullshit",
    "useless",
    "trash",
    "nonsense"
  ]);
}

function isRudeUser(text = "") {
  const q = normalizeForMatching(text);

  return includesAny(q, [
    "get lost",
    "go away",
    "shut up",
    "leave me",
    "stop talking"
  ]);
}
function isCustomerFrustration(text = "") {
  const q = normalizeForMatching(text);

  return includesAny(q, [
    "i am angry",
    "im angry",
    "i'm angry",
    "angry",
    "frustrated",
    "i am frustrated",
    "upset",
    "annoyed",
    "irritated",
    "not happy",
    "bad experience",
    "very bad"
  ]);
}

function isOffTopic(text = "") {
  const q = normalizeForMatching(text);

  if (hasExplicitOrderId(q) || hasExplicitTrackingId(q)) return false;

  return includesAny(q, [
    "learn dsa",
    "teach me dsa",
    "write code",
    "solve coding",
    "make website",
    "weather",
    "movie",
    "song",
    "joke",
    "jokes",
    "tell me a joke",
    "make me laugh",
    "who is prime minister",
    "math problem",
    "homework"
  ]);
}

// =====================================================
// ECOMMERCE INTENT DETECTORS
// =====================================================

function isReorderIntent(text = "") {
  const q = normalizeForMatching(text);

  return (
    includesAny(q, [
      "reorder",
      "re order",
      "order again",
      "buy again",
      "purchase again",
      "same product again",
      "same item again",
      "repeat order",
      "order same item",
      "order same product",
      "buy same product",
      "buy same item"
    ]) ||
    matchesAny(q, [
      /\border\b.*\bagain\b/,
      /\bbuy\b.*\bagain\b/,
      /\bpurchase\b.*\bagain\b/,
      /\bsame\b.*\b(product|item|order)\b.*\bagain\b/
    ])
  );
}

function isCancelIntent(text = "") {
  const q = normalizeForMatching(text);

  if (isReorderIntent(q)) return false;

  return (
    includesAny(q, [
      "cancel",
      "cancellation",
      "cancel my order",
      "cancel the order",
      "cancel it",
      "how can i cancel",
      "how to cancel",
      "can i cancel"
    ]) || matchesAny(q, [/\bcancel\b/, /\bcancellation\b/])
  );
}

function isReturnIntent(text = "") {
  const q = normalizeForMatching(text);

  if (isReorderIntent(q)) return false;

  if (
    includesAny(q, [
      "refund status",
      "track refund",
      "where is my refund"
    ])
  ) {
    return false;
  }

  return (
    includesAny(q, [
      "return",
      "return order",
      "return my order",
      "return this",
      "return it",
      "how can i return",
      "how to return"
    ]) || matchesAny(q, [/\breturn\b/])
  );
}

function isReplacementIntent(text = "") {
  const q = normalizeForMatching(text);

  if (isReorderIntent(q)) return false;

  return (
    includesAny(q, [
      "replace",
      "replacement",
      "help me with the replacement",
      "replace it",
      "replace order",
      "replacement request",
      "defective",
      "not working"
    ]) || matchesAny(q, [/\breplace\b/, /\breplacement\b/])
  );
}

function isExchangeIntent(text = "") {
  const q = normalizeForMatching(text);

  if (isReorderIntent(q)) return false;

  return (
    includesAny(q, [
      "exchange",
      "exchnage",
      "exchage",
      "xchange",
      "exchange it",
      "size change",
      "change size",
      "color change",
      "change color"
    ]) ||
    matchesAny(q, [/\bexchange\b/, /\bexchnage\b/, /\bexchage\b/])
  );
}

function isRefundIntent(text = "") {
  const q = normalizeForMatching(text);

  return (
    includesAny(q, [
      "refund",
      "refund status",
      "track refund",
      "where is my refund",
      "money back",
      "refund not received",
      "refund pending",
      "refund update"
    ]) || matchesAny(q, [/\brefund\b/])
  );
}

function isPaymentIssueIntent(text = "") {
  const q = normalizeForMatching(text);

  return includesAny(q, [
    "payment",
    "payment failed",
    "payment issue",
    "charged twice",
    "charged double",
    "double charged",
    "money deducted",
    "amount deducted",
    "amount debited",
    "debited",
    "deducted but order not placed",
    "paid but order not placed",
    "upi",
    "card payment",
    "transaction failed",
    "payment successful but order not placed"
  ]);
}

function isTrackingStatusIntent(text = "") {
  const q = normalizeForMatching(text);

  if (hasExplicitTrackingId(q)) return true;

  return (
    includesAny(q, [
      "track",
      "tracking",
      "tracking id",
      "where is my order",
      "where is order",
      "order status",
      "status",
      "staus",
      "check status",
      "current status",
      "latest status",
      "delivery status",
      "shipment status",
      "courier status",
      "give me details",
      "show details",
      "details",
      "where is it",
      "track it",
      "track this"
    ]) ||
    matchesAny(q, [
      /\b(status|staus)\b/,
      /\btrack(ing)?\b/,
      /\bwhere\b.*\border\b/,
      /\bwhere\b.*\bit\b/,
      /\bdetails\b/
    ])
  );
}

function isDeliveryIssueIntent(text = "") {
  const q = normalizeForMatching(text);

  return includesAny(q, [
    "delivery issue",
    "delayed",
    "delay",
    "late delivery",
    "not delivered",
    "delivery failed",
    "out for delivery",
    "lost in transit",
    "lost",
    "address not serviceable",
    "delivery partner",
    "courier issue"
  ]);
}

function isMissingItemIntent(text = "") {
  const q = normalizeForMatching(text);

  return includesAny(q, [
    "missing item",
    "item missing",
    "product missing",
    "part missing",
    "accessory missing",
    "package missing item"
  ]);
}

function isWrongItemIntent(text = "") {
  const q = normalizeForMatching(text);

  return includesAny(q, [
    "wrong item",
    "wrong product",
    "different product",
    "received wrong",
    "not what i ordered"
  ]);
}

function isDamagedItemIntent(text = "") {
  const q = normalizeForMatching(text);

  return includesAny(q, [
    "damaged",
    "broken",
    "defective",
    "cracked",
    "not working",
    "dead on arrival",
    "damaged item",
    "damaged product"
  ]);
}

// =====================================================
// GENERAL POLICY / FAQ DETECTION
// =====================================================

function scoreKeywords(text = "", keywords = []) {
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

function hasPolicyQuestionShape(text = "") {
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
    "required"
  ]);
}

function detectPolicyTopic(text = "") {
  const topicScores = [
    {
      topic: INTENTS.CANCEL_ORDER,
      issueType: "cancellation",
      score: scoreKeywords(text, [
        "cancel",
        "cancellation",
        "cancelled",
        "canceled",
        "after shipping",
        "before shipping"
      ])
    },
    {
      topic: INTENTS.RETURN_ORDER,
      issueType: "return",
      score: scoreKeywords(text, [
        "return",
        "return policy",
        "return window",
        "opened product",
        "packaging",
        "pickup",
        "send back"
      ])
    },
    {
      topic: INTENTS.REPLACE_ORDER,
      issueType: "replacement",
      score: scoreKeywords(text, [
        "replace",
        "replacement",
        "defective",
        "not working",
        "damaged product",
        "broken product"
      ])
    },
    {
      topic: INTENTS.EXCHANGE_ORDER,
      issueType: "exchange",
      score: scoreKeywords(text, [
        "exchange",
        "size change",
        "change size",
        "color change",
        "change color",
        "different size"
      ])
    },
    {
      topic: INTENTS.REFUND_STATUS,
      issueType: "refund",
      score: scoreKeywords(text, [
        "refund",
        "money back",
        "refund timeline",
        "refund pending",
        "bank"
      ])
    },
    {
      topic: INTENTS.DELIVERY_ISSUE,
      issueType: "delivery",
      score: scoreKeywords(text, [
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
        "parcel"
      ])
    },
    {
      topic: INTENTS.TRACK_ORDER,
      issueType: "tracking",
      score: scoreKeywords(text, [
        "track",
        "tracking",
        "tracking id",
        "shipment status",
        "delivery status",
        "latest status"
      ])
    },
    {
      topic: INTENTS.PAYMENT_ISSUE,
      issueType: "payment",
      score: scoreKeywords(text, [
        "payment",
        "paid",
        "charged",
        "deducted",
        "debited",
        "transaction",
        "upi",
        "card"
      ])
    },
    {
      topic: INTENTS.ORDER_ID_HELP,
      issueType: "order_id_help",
      score: scoreKeywords(text, [
        "order id",
        "order number",
        "order no",
        "what does an order id look like"
      ])
    }
  ];

  const best = topicScores.sort((a, b) => b.score - a.score)[0];

  if (!best || best.score <= 0) return null;

  return best;
}
function detectPolicyCondition(text = "", topic = "") {
  const q = normalizeForMatching(text);

  if (
    includesAny(q, [
      "after shipping",
      "already shipped",
      "once shipped",
      "after dispatch",
      "dispatched"
    ])
  ) {
    return "after_shipping";
  }

  if (
    includesAny(q, [
      "before delivery",
      "not delivered",
      "not received yet",
      "before receiving"
    ])
  ) {
    return "before_delivery";
  }

  if (includesAny(q, ["after delivery", "after delivered", "delivered"])) {
    return "after_delivery";
  }

  if (
    includesAny(q, [
      "opened",
      "open product",
      "opened product",
      "used product"
    ])
  ) {
    return "opened_product";
  }

  if (
    includesAny(q, [
      "without packaging",
      "original packaging",
      "box",
      "package missing",
      "packaging"
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
      "window"
    ])
  ) {
    if (topic === INTENTS.REFUND_STATUS) return "refund_timeline";
    return "time_window";
  }

  if (
    includesAny(q, [
      "document",
      "documents",
      "proof",
      "photo",
      "video",
      "invoice"
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
      "delivery partner"
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
      "address"
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
      "no movement"
    ])
  ) {
    return "delivery_delay";
  }

  if (
    includesAny(q, [
      "refund pending",
      "not received refund",
      "where is my refund",
      "when will i get refund"
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
  if (hasExplicitOrderId(text) || hasExplicitTrackingId(text)) return null;

  const q = normalizeForMatching(text);
  const topic = detectPolicyTopic(q);

  if (!topic) return null;

  const hasQuestionShape = hasPolicyQuestionShape(q);

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
    policyTopic: topic.topic,
    policyCondition: detectPolicyCondition(q, topic.topic),
    issueType: topic.issueType
  };
}

// =====================================================
// ISSUE TYPE DETECTION
// =====================================================

function detectIssueType(intent, text = "") {
  const q = normalizeForMatching(text);

  if (intent === INTENTS.GENERAL_POLICY_QUERY) return "general_policy";

  if (intent === INTENTS.PAYMENT_ISSUE) {
    if (includesAny(q, ["charged twice", "double charged"])) {
      return "charged_twice";
    }

    if (
      includesAny(q, [
        "money deducted",
        "amount deducted",
        "amount debited",
        "paid but order not placed",
        "payment successful but order not placed"
      ])
    ) {
      return "payment_deducted_order_not_created";
    }

    return "payment";
  }

  if (intent === INTENTS.DELIVERY_ISSUE) {
    if (includesAny(q, ["lost", "lost in transit"])) return "lost_in_transit";
    if (includesAny(q, ["delayed", "delay", "late"])) return "delivery_delay";
    if (includesAny(q, ["not delivered"])) return "not_delivered";
    return "delivery";
  }

  if (intent === INTENTS.MISSING_ITEM) return "missing_item";
  if (intent === INTENTS.WRONG_ITEM) return "wrong_item";
  if (intent === INTENTS.DAMAGED_ITEM) return "damaged_item";

  if (intent === INTENTS.CANCEL_ORDER) return "cancellation";
  if (intent === INTENTS.RETURN_ORDER) return "return";
  if (intent === INTENTS.REPLACE_ORDER) return "replacement";
  if (intent === INTENTS.EXCHANGE_ORDER) return "exchange";
  if (intent === INTENTS.REORDER_ORDER) return "reorder";
  if (intent === INTENTS.REFUND_STATUS) return "refund";
  if (intent === INTENTS.TRACK_ORDER) return "tracking";

  return "general";
}

// =====================================================
// MAIN DETECTOR
// =====================================================

function detectIntentAndEntities(text = "", context = {}) {
  const rawText = String(text || "");
  const q = normalizeForMatching(rawText);

  const orderId = extractOrderId(rawText);
  const trackingId = extractTrackingId(rawText);

  if (isEmptyOrTooShort(q)) {
    return makeResult({
      intent: INTENTS.GENERAL_SUPPORT,
      confidence: 0.35,
      rawText,
      source: "empty_or_too_short"
    });
  }

  if (isGreeting(q)) {
    return makeResult({
      intent: INTENTS.GREETING,
      confidence: 0.98,
      rawText,
      source: "deterministic_greeting"
    });
  }

  if (isConversationEnd(q)) {
    return makeResult({
      intent: INTENTS.CONVERSATION_END,
      confidence: 0.98,
      rawText,
      source: "deterministic_conversation_end"
    });
  }

  if (isContextReset(q)) {
    return makeResult({
      intent: INTENTS.CONTEXT_RESET,
      confidence: 0.98,
      rawText,
      source: "deterministic_context_reset"
    });
  }

  if (isUnsafeRequest(q)) {
    return makeResult({
      intent: INTENTS.UNSAFE_REQUEST,
      confidence: 0.98,
      rawText,
      source: "deterministic_unsafe_request",
      metadata: {
        requiresEscalation: true,
        riskSignals: ["unsafe_request"]
      }
    });
  }

  if (isOrderIdHelp(q)) {
    return makeResult({
      intent: INTENTS.ORDER_ID_HELP,
      confidence: 0.95,
      rawText,
      source: "deterministic_order_id_help",
      issueType: "order_id_help"
    });
  }

  if (isHumanSupport(q)) {
    return makeResult({
      intent: INTENTS.HUMAN_SUPPORT,
      confidence: 0.92,
      orderId,
      trackingId,
      issueType: "human_support",
      rawText,
      source: "deterministic_human_support",
      metadata: {
        requiresEscalation: true,
        riskSignals: ["customer_requested_human_support"]
      }
    });
  }

  if (isNegativeCorrection(q)) {
    return makeResult({
      intent: INTENTS.NEGATIVE_CORRECTION,
      confidence: 0.9,
      rawText,
      source: "deterministic_negative_correction"
    });
  }

  if (isToneFeedback(q)) {
    return makeResult({
      intent: INTENTS.TONE_FEEDBACK,
      confidence: 0.9,
      rawText,
      source: "deterministic_tone_feedback"
    });
  }

  if (isContextComplaint(q)) {
    return makeResult({
      intent: INTENTS.CONTEXT_COMPLAINT,
      confidence: 0.9,
      rawText,
      source: "deterministic_context_complaint"
    });
  }

  if (isTrustQuestion(q)) {
    return makeResult({
      intent: INTENTS.TRUST_QUESTION,
      confidence: 0.9,
      rawText,
      source: "deterministic_trust_question"
    });
  }

  if (isAbusiveUser(q)) {
    return makeResult({
      intent: INTENTS.ABUSIVE_USER,
      confidence: 0.92,
      rawText,
      source: "deterministic_abusive_user",
      metadata: {
        requiresEscalation: true,
        riskSignals: ["angry_customer"]
      }
    });
  }

  if (isRudeUser(q)) {
    return makeResult({
      intent: INTENTS.RUDE_USER,
      confidence: 0.9,
      rawText,
      source: "deterministic_rude_user"
    });
  }

  if (isCustomerFrustration(q)) {
    return makeResult({
      intent: INTENTS.CUSTOMER_FRUSTRATION,
      confidence: 0.88,
      rawText,
      source: "deterministic_customer_frustration",
      metadata: {
        requiresEscalation: true,
        riskSignals: ["angry_customer"]
      }
    });
  }

  if (isOffTopic(q)) {
    return makeResult({
      intent: INTENTS.OFF_TOPIC,
      confidence: 0.9,
      rawText,
      source: "deterministic_off_topic"
    });
  }

  const generalPolicy = detectGeneralPolicyQuery(rawText);

  if (generalPolicy) {
    return makeResult({
      intent: INTENTS.GENERAL_POLICY_QUERY,
      confidence: 0.88,
      orderId: null,
      trackingId: null,
      issueType: generalPolicy.issueType,
      rawText,
      source: "deterministic_general_policy",
      metadata: {
        isGeneralPolicyQuestion: true,
        policyTopic: generalPolicy.policyTopic,
        policyCondition: generalPolicy.policyCondition
      }
    });
  }

  if (orderId && !isCancelIntent(q) && !isReturnIntent(q) && !isReplacementIntent(q) && !isExchangeIntent(q) && !isReorderIntent(q) && !isRefundIntent(q) && !isPaymentIssueIntent(q) && !isTrackingStatusIntent(q) && !isDeliveryIssueIntent(q) && !isMissingItemIntent(q) && !isWrongItemIntent(q) && !isDamagedItemIntent(q)) {
    return makeResult({
      intent: INTENTS.ORDER_REFERENCE_ONLY,
      confidence: 0.9,
      orderId,
      trackingId,
      issueType: "general",
      rawText,
      source: "deterministic_order_reference_only"
    });
  }
    if (isReorderIntent(q)) {
    return makeResult({
      intent: INTENTS.REORDER_ORDER,
      confidence: 0.92,
      orderId,
      trackingId,
      issueType: detectIssueType(INTENTS.REORDER_ORDER, q),
      rawText,
      source: "deterministic_reorder"
    });
  }

  if (isRefundIntent(q)) {
    return makeResult({
      intent: INTENTS.REFUND_STATUS,
      confidence: 0.92,
      orderId,
      trackingId,
      issueType: detectIssueType(INTENTS.REFUND_STATUS, q),
      rawText,
      source: "deterministic_refund"
    });
  }

  if (isPaymentIssueIntent(q)) {
    return makeResult({
      intent: INTENTS.PAYMENT_ISSUE,
      confidence: 0.9,
      orderId,
      trackingId,
      issueType: detectIssueType(INTENTS.PAYMENT_ISSUE, q),
      rawText,
      source: "deterministic_payment_issue"
    });
  }

  if (isMissingItemIntent(q)) {
    return makeResult({
      intent: INTENTS.MISSING_ITEM,
      confidence: 0.9,
      orderId,
      trackingId,
      issueType: detectIssueType(INTENTS.MISSING_ITEM, q),
      rawText,
      source: "deterministic_missing_item"
    });
  }

  if (isWrongItemIntent(q)) {
    return makeResult({
      intent: INTENTS.WRONG_ITEM,
      confidence: 0.9,
      orderId,
      trackingId,
      issueType: detectIssueType(INTENTS.WRONG_ITEM, q),
      rawText,
      source: "deterministic_wrong_item"
    });
  }

  if (isDamagedItemIntent(q)) {
    return makeResult({
      intent: INTENTS.DAMAGED_ITEM,
      confidence: 0.9,
      orderId,
      trackingId,
      issueType: detectIssueType(INTENTS.DAMAGED_ITEM, q),
      rawText,
      source: "deterministic_damaged_item"
    });
  }

  if (isCancelIntent(q)) {
    return makeResult({
      intent: INTENTS.CANCEL_ORDER,
      confidence: 0.94,
      orderId,
      trackingId,
      issueType: detectIssueType(INTENTS.CANCEL_ORDER, q),
      rawText,
      source: "deterministic_cancel"
    });
  }

  if (isReturnIntent(q)) {
    return makeResult({
      intent: INTENTS.RETURN_ORDER,
      confidence: 0.94,
      orderId,
      trackingId,
      issueType: detectIssueType(INTENTS.RETURN_ORDER, q),
      rawText,
      source: "deterministic_return"
    });
  }

  if (isReplacementIntent(q)) {
    return makeResult({
      intent: INTENTS.REPLACE_ORDER,
      confidence: 0.92,
      orderId,
      trackingId,
      issueType: detectIssueType(INTENTS.REPLACE_ORDER, q),
      rawText,
      source: "deterministic_replacement"
    });
  }

  if (isExchangeIntent(q)) {
    return makeResult({
      intent: INTENTS.EXCHANGE_ORDER,
      confidence: 0.92,
      orderId,
      trackingId,
      issueType: detectIssueType(INTENTS.EXCHANGE_ORDER, q),
      rawText,
      source: "deterministic_exchange"
    });
  }

  if (isDeliveryIssueIntent(q)) {
    return makeResult({
      intent: INTENTS.DELIVERY_ISSUE,
      confidence: 0.9,
      orderId,
      trackingId,
      issueType: detectIssueType(INTENTS.DELIVERY_ISSUE, q),
      rawText,
      source: "deterministic_delivery_issue"
    });
  }

  if (isTrackingStatusIntent(q)) {
    return makeResult({
      intent: INTENTS.TRACK_ORDER,
      confidence: 0.92,
      orderId,
      trackingId,
      issueType: detectIssueType(INTENTS.TRACK_ORDER, q),
      rawText,
      source: "deterministic_tracking"
    });
  }

  if (trackingId) {
    return makeResult({
      intent: INTENTS.TRACK_ORDER,
      confidence: 0.9,
      orderId,
      trackingId,
      issueType: "tracking",
      rawText,
      source: "deterministic_tracking_reference"
    });
  }

  return makeResult({
    intent: INTENTS.GENERAL_SUPPORT,
    confidence: 0.55,
    orderId,
    trackingId,
    issueType: "general",
    rawText,
    source: "default_general_support"
  });
}

// =====================================================
// EXPORTS
// =====================================================

module.exports = {
  INTENTS,
  ORDER_REQUIRED_INTENTS,

  detectIntentAndEntities,

  normalizeText,
  normalizeForMatching,
  includesAny,
  matchesAny,

  extractOrderId,
  extractTrackingId,
  normalizeOrderId,
  normalizeTrackingId,
  hasExplicitOrderId,
  hasExplicitTrackingId,

  detectIssueType,

  isGreeting,
  isConversationEnd,
  isContextReset,
  isOrderIdHelp,
  isHumanSupport,
  isNegativeCorrection,
  isUnsafeRequest,
  isTrustQuestion,
  isToneFeedback,
  isContextComplaint,
  isAbusiveUser,
  isRudeUser,
  isCustomerFrustration,
  isOffTopic,

  isReorderIntent,
  isCancelIntent,
  isReturnIntent,
  isReplacementIntent,
  isExchangeIntent,
  isRefundIntent,
  isPaymentIssueIntent,
  isTrackingStatusIntent,
  isDeliveryIssueIntent,
  isMissingItemIntent,
  isWrongItemIntent,
  isDamagedItemIntent,

  detectGeneralPolicyQuery,
  detectPolicyTopic,
  detectPolicyCondition,
  hasPolicyQuestionShape
};