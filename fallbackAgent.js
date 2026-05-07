// fallbackAgent.js

const REPEATED_FAILURE_LIMIT = 3;

// ===============================
// BASIC HELPERS
// ===============================

function getAttempt(sessionState = {}) {
  return sessionState.totalFailureCount || 0;
}

function normalizeText(text = "") {
  return String(text).trim().toLowerCase();
}

function safeInternal(confidenceResult, intentResult, sessionState, extra = {}) {
  return {
    route: confidenceResult?.route || "fallback_llm",
    decision: confidenceResult?.decision || "fallback_required",
    intent: intentResult?.intent || "general_support",
    confidence: intentResult?.confidence ?? 0,
    riskSignals: confidenceResult?.riskSignals || [],
    attempt: getAttempt(sessionState),
    ...extra,
  };
}

// ===============================
// QUERY CLASSIFIERS
// ===============================

function isGreetingQuery(text = "") {
  const clean = normalizeText(text);

  return /^(hi|hello|hey|hii|hiii|good morning|good afternoon|good evening|namaste|namaskar)$/i.test(
    clean
  );
}

function isEntertainmentOrCreativeQuery(text = "") {
  const clean = normalizeText(text);

  const patterns = [
    "joke",
    "funny",
    "make me laugh",
    "shayari",
    "poem",
    "poetry",
    "story",
    "sing",
    "song",
    "rap",
    "riddle",
    "meme",
    "quote",
    "pickup line",
  ];

  return patterns.some((pattern) => clean.includes(pattern));
}

function isKnowledgeOrStudyQuery(text = "") {
  const clean = normalizeText(text);

  const patterns = [
    "what is",
    "who is",
    "where is",
    "when is",
    "explain",
    "definition",
    "meaning of",
    "tell me about",
    "history of",
    "difference between",
    "write code",
    "python",
    "java",
    "javascript",
    "c++",
    "html",
    "css",
    "sql",
    "homework",
    "assignment",
    "resume",
    "cover letter",
    "interview question",
  ];

  return patterns.some((pattern) => clean.includes(pattern));
}

function isLifestyleOrExternalQuery(text = "") {
  const clean = normalizeText(text);

  const patterns = [
    "weather",
    "news",
    "cricket",
    "score",
    "movie",
    "recipe",
    "travel",
    "flight",
    "train",
    "book ticket",
    "hotel",
    "restaurant",
  ];

  return patterns.some((pattern) => clean.includes(pattern));
}

function isGarbageLikeQuery(text = "") {
  const clean = normalizeText(text);

  if (!clean) return true;
  if (clean.length <= 2) return true;
  if (/^[^a-z0-9]+$/i.test(clean)) return true;

  const patterns = [
    "asdasd",
    "asdf",
    "qwerty",
    "blah",
    "random",
    "test test",
    "aaaa",
    "????",
    "sdf",
    "xyzxyz",
    "lorem ipsum",
    "dummy text",
    "gibberish",
  ];

  return patterns.some((pattern) => clean.includes(pattern));
}

function isOrderSupportRelated(text = "") {
  const clean = normalizeText(text);

  const patterns = [
    "order",
    "ord",
    "cancel",
    "return",
    "refund",
    "replace",
    "replacement",
    "exchange",
    "delivery",
    "track",
    "tracking",
    "payment",
    "cod",
    "upi",
    "card",
    "paid",
    "delivered",
    "shipped",
    "dispatch",
    "item",
    "product",
    "missing",
    "wrong",
    "damaged",
    "defective",
    "invoice",
    "pickup",
    "courier",
    "shipment",
  ];

  return patterns.some((pattern) => clean.includes(pattern));
}

function getNonCommerceCategory(text = "") {
  if (isGreetingQuery(text)) return "greeting";
  if (isEntertainmentOrCreativeQuery(text)) return "creative_or_entertainment";
  if (isKnowledgeOrStudyQuery(text)) return "knowledge_or_study";
  if (isLifestyleOrExternalQuery(text)) return "external_or_lifestyle";
  if (isGarbageLikeQuery(text)) return "unclear_or_garbage";
  return "off_topic_general";
}

// ===============================
// RESPONSE BUILDERS
// ===============================

function makeResponse(status, message, confidenceResult, intentResult, sessionState, extraInternal = {}) {
  return {
    success: true,
    status,
    message,
    customerMessage: message,
    internal: safeInternal(confidenceResult, intentResult, sessionState, extraInternal),
  };
}

function buildGreetingResponse(confidenceResult, intentResult, sessionState) {
  const message =
    "Hi, welcome to CartGenie AI. I can help you with order tracking, cancellation, returns, refunds, replacement, exchange, delivery, and payment issues. Tell me what you need help with, and share your order ID if you have it.";

  return makeResponse(
    "GREETING",
    message,
    confidenceResult,
    intentResult,
    sessionState,
    {
      decision: "greeting_detected",
      fallbackType: "greeting",
    }
  );
}

function buildUnsafeInputResponse(confidenceResult, intentResult, sessionState) {
  const message =
    "I can help you with order-related support, but I cannot bypass policy checks, skip verification, hide logs, or ignore safety rules. Please share your actual order issue and order ID, and I will guide you through the correct support flow.";

  return makeResponse(
    "FALLBACK_REQUIRED",
    message,
    confidenceResult,
    intentResult,
    sessionState,
    {
      fallbackType: "unsafe_input",
    }
  );
}

function buildHumanSupportFallback(confidenceResult, intentResult, sessionState) {
  const message =
    "I understand that you would like human support. I can mark this for review by the support team. To help them check faster, please share your order ID and a short description of the issue.";

  return makeResponse(
    "ESCALATION_REQUESTED",
    message,
    confidenceResult,
    intentResult,
    sessionState,
    {
      fallbackType: "human_support_requested",
    }
  );
}

function buildGeneralPolicyFallback(confidenceResult, intentResult, sessionState) {
  const intent = intentResult?.intent || confidenceResult?.intent;

  const policyMessages = {
    delivery_policy:
      "Delivery timelines usually depend on the product, seller, warehouse location, courier availability, and your delivery address. Share your order ID and I can check the current order status for you.",
    refund_policy:
      "Refund timelines usually depend on the payment method and whether pickup, return, or quality check is completed. Share your order ID and I can check the exact refund status for you.",
    return_policy:
      "Return eligibility depends on the product category, return window, delivery status, item condition, and quality check rules. Share your order ID and I can check whether your order is eligible.",
    replacement_policy:
      "Replacement eligibility depends on the product category, issue type, stock availability, replacement window, and verification requirements. Share your order ID and I can check it properly.",
    cancellation_policy:
      "Cancellation usually depends on whether the order is still placed/confirmed or already shipped/out for delivery. Share your order ID and I can check if cancellation is available.",
  };

  const message =
    policyMessages[intent] ||
    "I can help with policy-related order questions. Please share your order ID if you want me to check the exact eligibility or status.";

  return makeResponse(
    "POLICY_INFO",
    message,
    confidenceResult,
    intentResult,
    sessionState,
    {
      fallbackType: "general_policy_query",
    }
  );
}

function buildUnsupportedIntentResponse(confidenceResult, intentResult, sessionState) {
  const attempt = getAttempt(sessionState);

  const message =
    attempt >= REPEATED_FAILURE_LIMIT
      ? "I am sorry, I am still not able to complete this request automatically. I am designed for order-related support like tracking, cancellation, returns, refunds, replacement, exchange, delivery, and payment issues. If your concern is related to an order, please share the order ID and I will check it properly."
      : "I understand what you are asking, but I am focused on e-commerce order support right now. I can help with tracking, cancellation, returns, refunds, replacement, exchange, delivery, and payment issues. Please share your order concern and I will guide you step by step.";

  return makeResponse(
    "FALLBACK_REQUIRED",
    message,
    confidenceResult,
    intentResult,
    sessionState,
    {
      fallbackType:
        attempt >= REPEATED_FAILURE_LIMIT
          ? "unsupported_intent_repeated"
          : "unsupported_intent",
    }
  );
}

function buildNonCommerceResponse(confidenceResult, intentResult, sessionState) {
  const attempt = getAttempt(sessionState);
  const rawText = intentResult?.rawText || "";
  const category = getNonCommerceCategory(rawText);

  let message;

  if (category === "creative_or_entertainment") {
    message =
      "That sounds fun, but I am here mainly to help with your order-related concerns. I can help with tracking, cancellation, returns, refunds, replacement, exchange, delivery, and payment issues. Share your order ID or tell me your order problem, and I will help right away.";
  } else if (category === "knowledge_or_study") {
    message =
      "I may not be the right assistant for that topic because I am focused on CartGenie order support. I can help you with order tracking, cancellation, returns, refunds, replacement, exchange, delivery, and payment issues. Please share your order concern and I will guide you.";
  } else if (category === "external_or_lifestyle") {
    message =
      "I cannot help much with that outside topic here, but I can definitely help with your order support needs. You can ask me about tracking, cancellation, returns, refunds, replacement, exchange, delivery, or payment issues.";
  } else if (category === "unclear_or_garbage") {
    message =
      "I could not understand that clearly. Please tell me your order-related issue in a simple way, such as track my order, cancel my order, return my product, refund not received, or replace damaged product. If you have an order ID, include it too.";
  } else {
    message =
      "I am here mainly for order-related support. I can help with tracking, cancellation, returns, refunds, replacement, exchange, delivery, and payment issues. Please share your order concern and I will guide you with the next step.";
  }

  if (attempt >= REPEATED_FAILURE_LIMIT) {
    message =
      "I am still not fully sure what you need help with. To help you faster, please ask about an order-related issue like cancel my order, return my product, track my order, refund not received, or replace damaged product. If you have an order ID, please include it too.";
  }

  return makeResponse(
    "OFF_TOPIC_OR_UNCLEAR",
    message,
    confidenceResult,
    intentResult,
    sessionState,
    {
      decision: "non_commerce_request",
      fallbackType:
        attempt >= REPEATED_FAILURE_LIMIT
          ? "non_commerce_repeated"
          : category,
    }
  );
}

function buildGenericFallbackResponse(confidenceResult, intentResult, sessionState) {
  const attempt = getAttempt(sessionState);

  const message =
    attempt >= REPEATED_FAILURE_LIMIT
      ? "I am sorry, I am still not able to understand the request clearly. Please share your order ID and the issue in a simple way. For example: cancel ORD101, return ORD103, track ORD102, refund status ORD106, or replace damaged product ORD105."
      : "I want to make sure I guide you correctly. Please share a little more detail about the issue. If this is related to an order, include your order ID too.";

  return makeResponse(
    "FALLBACK_REQUIRED",
    message,
    confidenceResult,
    intentResult,
    sessionState,
    {
      fallbackType:
        attempt >= REPEATED_FAILURE_LIMIT ? "generic_repeated" : "generic",
    }
  );
}

function buildMissingFallbackInputResponse() {
  return {
    success: false,
    status: "FALLBACK_ERROR",
    message:
      "Sorry, I could not understand this request right now. Please try again with your order ID and a short description of the issue.",
    customerMessage:
      "Sorry, I could not understand this request right now. Please try again with your order ID and a short description of the issue.",
    internal: {
      reason: "Missing confidenceResult or intentResult in fallbackAgent.",
    },
  };
}

// ===============================
// MAIN FALLBACK ROUTER
// ===============================

function generateFallbackResponse(confidenceResult, intentResult, sessionState = {}) {
  if (!confidenceResult || !intentResult) {
    return buildMissingFallbackInputResponse();
  }

  const intent = intentResult.intent || confidenceResult.intent;
  const decision = confidenceResult.decision;
  const rawText = intentResult.rawText || "";

  if (decision === "unsafe_input_detected" || intent === "unsafe_request") {
    return buildUnsafeInputResponse(confidenceResult, intentResult, sessionState);
  }

  if (intent === "greeting" || decision === "greeting_detected" || isGreetingQuery(rawText)) {
    return buildGreetingResponse(confidenceResult, intentResult, sessionState);
  }

  if (intent === "human_support") {
    return buildHumanSupportFallback(confidenceResult, intentResult, sessionState);
  }

  if (decision === "unsupported_intent") {
    return buildUnsupportedIntentResponse(confidenceResult, intentResult, sessionState);
  }

  if (
    decision === "general_policy_query" ||
    [
      "delivery_policy",
      "refund_policy",
      "return_policy",
      "replacement_policy",
      "cancellation_policy",
    ].includes(intent)
  ) {
    return buildGeneralPolicyFallback(confidenceResult, intentResult, sessionState);
  }

  if (
    intent === "non_commerce_request" ||
    decision === "non_commerce_request" ||
    intentResult.issueType === "off_topic" ||
    (!isOrderSupportRelated(rawText) &&
      (isEntertainmentOrCreativeQuery(rawText) ||
        isKnowledgeOrStudyQuery(rawText) ||
        isLifestyleOrExternalQuery(rawText) ||
        isGarbageLikeQuery(rawText)))
  ) {
    return buildNonCommerceResponse(confidenceResult, intentResult, sessionState);
  }

  if (decision === "low_confidence") {
    return buildGenericFallbackResponse(confidenceResult, intentResult, sessionState);
  }

  return buildGenericFallbackResponse(confidenceResult, intentResult, sessionState);
}

// ===============================
// FALLBACK ESCALATION BUILDER
// ===============================

function buildFallbackEscalation(confidenceResult) {
  if (!confidenceResult?.requiresEscalation) {
    return {
      ticketRequired: false,
    };
  }

  const riskSignals = confidenceResult.riskSignals || [];

  let assignedTeam = "Safety Review Team";
  let priority = "MEDIUM";
  let sla = "1 business day";
  let reason = "This request needs support review before we proceed.";

  if (riskSignals.includes("prompt_injection_detected")) {
    assignedTeam = "Safety Review Team";
    priority = "HIGH";
    sla = "4 business hours";
    reason = "Unsafe instruction or prompt-injection pattern detected.";
  }

  if (
    riskSignals.includes("angry_customer") ||
    riskSignals.includes("abusive_customer")
  ) {
    assignedTeam = "Customer Support Escalation Team";
    priority = "HIGH";
    sla = "4 business hours";
    reason =
      "Customer tone indicates frustration and may need careful human handling.";
  }

  return {
    ticketRequired: true,
    ticketId: null,
    priority,
    assignedTeam,
    sla,
    reason,
    riskSignals,
    customerMessage:
      "I am marking this for support review so the right team can check it carefully.",
  };
}

module.exports = {
  REPEATED_FAILURE_LIMIT,

  generateFallbackResponse,
  buildFallbackEscalation,

  isGreetingQuery,
  isEntertainmentOrCreativeQuery,
  isKnowledgeOrStudyQuery,
  isLifestyleOrExternalQuery,
  isGarbageLikeQuery,
  isOrderSupportRelated,

  buildGreetingResponse,
};