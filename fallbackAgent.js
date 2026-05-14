"use strict";

/**
 * fallbackAgent.js
 *
 * Soft fallback + conversational repair layer for CartGenie.
 *
 * Responsibilities:
 * - Friendly fallback when intent/confidence is low.
 * - Handle off-topic queries politely.
 * - Handle rude/angry/tone/context complaints with empathy.
 * - Avoid robotic repeated greetings.
 * - Avoid "order null" / "undefined".
 * - Provide escalation object for repeated fallback or risky queries.
 *
 * Required exports used by app.js:
 * - generateFallbackResponse(confidenceResult, intentResult, sessionState)
 * - buildFallbackEscalation(confidenceResult)
 * - isGreetingQuery(query)
 */

// =====================================================
// HELPERS
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

function safeOrderId(value) {
  if (!value) return null;

  const clean = String(value || "").trim().toUpperCase();

  if (!clean || clean === "NULL" || clean === "UNDEFINED") return null;

  return clean;
}

function buildResponse({
  status = "FALLBACK",
  message,
  suggestedActions = [],
  metadata = {},
}) {
  const finalMessage =
    message ||
    "I’m sorry, I couldn’t understand that clearly. Please share your order-related concern again, and I’ll help you step by step.";

  return {
    success: true,
    status,
    message: finalMessage,
    customerMessage: finalMessage,
    suggestedActions,
    metadata,
  };
}

function getIntent(intentResult = {}) {
  return String(intentResult.intent || "general_support").trim();
}

function getQuery(intentResult = {}) {
  return String(intentResult.rawText || intentResult.query || "").trim();
}

function getLastOrderId(sessionState = {}, intentResult = {}) {
  return safeOrderId(
    intentResult.orderId ||
      intentResult.entities?.orderId ||
      sessionState.lastOrderId
  );
}

function getRiskSignals(confidenceResult = {}, intentResult = {}) {
  const a = confidenceResult.riskSignals || [];
  const b = intentResult.metadata?.riskSignals || [];

  return Array.from(new Set([...a, ...b]));
}

function hasRisk(confidenceResult = {}, intentResult = {}, risk) {
  return getRiskSignals(confidenceResult, intentResult).includes(risk);
}

// =====================================================
// QUERY DETECTORS
// =====================================================

function isGreetingQuery(query = "") {
  const q = normalizeForMatching(query);

  const greetings = new Set([
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
    "good evening",
  ]);

  if (greetings.has(q)) return true;

  return /^(hi|hello|hey|hlw|hlo)\s*(there|cartgenie|bot)?$/.test(q);
}

function isThanksQuery(query = "") {
  const q = normalizeForMatching(query);

  return [
    "thanks",
    "thank you",
    "thankyou",
    "thanks a lot",
    "thank you so much",
    "ok thanks",
    "okay thanks",
    "done",
    "got it",
    "okay",
    "ok",
    "cool",
    "great",
    "perfect",
    "bye",
    "goodbye",
  ].includes(q);
}

function isOffTopicQuery(query = "") {
  const q = normalizeForMatching(query);

  return includesAny(q, [
    "learn dsa",
    "teach me dsa",
    "write code",
    "solve coding",
    "make website",
    "weather",
    "movie",
    "song",
    "tell me a joke",
    "joke",
    "jokes",
    "make me laugh",
    "homework",
    "math problem",
    "who is prime minister",
  ]);
}

function isOrderIdHelpQuery(query = "") {
  const q = normalizeForMatching(query);

  return (
    includesAny(q, [
      "how can i check order id",
      "how to check order id",
      "how can i find order id",
      "how do i find order id",
      "where is my order id",
      "where can i find order id",
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
    ]) ||
    /\bhow\b.*\b(find|fond|check|get|see)\b.*\b(ord|order)\b.*\bid\b/.test(q) ||
    /\bwhere\b.*\b(ord|order)\b.*\bid\b/.test(q)
  );
}

function isTrustQuestion(query = "") {
  const q = normalizeForMatching(query);

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
      "how can you help",
    ]) ||
    /\bare\s+you\s+sure\b.*\bhelp\b/.test(q) ||
    /\bcan\s+you\b.*\bhelp\b/.test(q) ||
    /\bwhat\b.*\bcan\b.*\byou\b.*\bdo\b/.test(q)
  );
}

function isToneFeedback(query = "") {
  const q = normalizeForMatching(query);

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
    "same answer again",
    "you are repeating",
    "you are not understanding",
    "you dont understand",
    "you don't understand",
  ]);
}

function isContextComplaint(query = "") {
  const q = normalizeForMatching(query);

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
    "why are you forgetting",
  ]);
}

function isAngryOrRudeQuery(query = "") {
  const q = normalizeForMatching(query);

  return includesAny(q, [
    "angry",
    "i am angry",
    "im angry",
    "i'm angry",
    "frustrated",
    "upset",
    "annoyed",
    "irritated",
    "dumb",
    "you are dumb",
    "you are so dumb",
    "stupid",
    "idiot",
    "shit",
    "bullshit",
    "useless",
    "trash",
    "get lost",
    "go away",
    "shut up",
    "bad bot",
    "not helpful",
  ]);
}

function isUnsafeQuery(query = "") {
  const q = normalizeForMatching(query);

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
    "system prompt",
    "developer message",
    "api key",
    "secret",
    "show secret",
    "show secrets",
    "jailbreak",
    "private system information",
    "internal policy",
    "override policy",
  ]);
}

function isNegativeCorrectionQuery(query = "") {
  const q = normalizeForMatching(query);

  return (
    /\b(no|nope|nah|never)\b/.test(q) ||
    /\b(do not|dont|don't)\b/.test(q) ||
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
      "stop",
      "not now",
    ])
  );
}

// =====================================================
// MESSAGE BUILDERS
// =====================================================

function greetingResponse() {
  return buildResponse({
    status: "GREETING",
    message:
      "Hi, welcome to CartGenie AI. How can I help you today? If your request is related to an order, you can share an order ID like ORD101.",
    suggestedActions: [
      "Track order",
      "Cancel order",
      "Return order",
      "Refund status",
    ],
  });
}

function thanksResponse() {
  return buildResponse({
    status: "CONVERSATION_END",
    message:
      "You’re welcome. I’m glad I could help. If you need anything else with an order later, just message me anytime.",
  });
}

function offTopicResponse() {
  return buildResponse({
    status: "OFF_TOPIC",
    message:
      "That sounds interesting, but I’m best at helping with CartGenie order-related support. If you have an order issue, share your order ID and I’ll help with tracking, cancellation, returns, refunds, replacement, delivery, or payment concerns.",
    suggestedActions: [
      "Track order",
      "Cancel order",
      "Refund status",
      "Contact support",
    ],
  });
}

function orderIdHelpResponse() {
  return buildResponse({
    status: "ORDER_ID_HELP",
    message:
      "Sure, I can help with that. Your order ID is usually available in your order confirmation email or SMS, invoice, or the order history section of your account. It usually looks like ORD101. Once you share it here, I can help you track, cancel, return, replace, exchange, reorder, or check refund status.",
    suggestedActions: ["Share order ID", "Track order", "Refund status"],
  });
}

function trustQuestionResponse() {
  return buildResponse({
    status: "CAPABILITY_RESPONSE",
    message:
      "Yes, I can help. I’ll guide you step by step. If your issue is about an order, share the order ID like ORD101, or simply tell me what happened.",
    suggestedActions: [
      "Track order",
      "Cancel order",
      "Return order",
      "Refund status",
    ],
  });
}

function toneFeedbackResponse() {
  return buildResponse({
    status: "TONE_FEEDBACK_ACKNOWLEDGED",
    message:
      "You’re right to point that out — sorry if I sounded too stiff. I’ll keep it clear, polite, and helpful from here. Tell me what you need help with, and I’ll guide you step by step.",
    suggestedActions: [
      "Track order",
      "Cancel order",
      "Refund status",
      "Human support",
    ],
  });
}

function contextComplaintResponse(orderId) {
  if (orderId) {
    return buildResponse({
      status: "CONTEXT_COMPLAINT_ACKNOWLEDGED",
      message: `Sorry about that. I still have your previous order context as ${orderId}. Tell me what you want to do next with this order, and I’ll follow that context carefully.`,
      suggestedActions: [
        "Track order",
        "Cancel order",
        "Return/Replacement",
        "Refund status",
      ],
    });
  }

  return buildResponse({
    status: "CONTEXT_COMPLAINT_ACKNOWLEDGED",
    message:
      "Sorry about that. I don’t have a clear order context right now. Please share your order ID like ORD101 and tell me what you need help with.",
    suggestedActions: ["Share order ID", "Track order", "Contact support"],
  });
}

function angryOrRudeResponse(orderId, confidenceResult = {}) {
  const needsEscalation =
    confidenceResult.requiresEscalation ||
    (confidenceResult.riskSignals || []).some((signal) =>
      [
        "angry_customer",
        "abusive_or_rude_language",
        "customer_requested_human_support",
      ].includes(signal)
    );

  if (orderId) {
    return buildResponse({
      status: needsEscalation
        ? "FRUSTRATION_ESCALATION_READY"
        : "FRUSTRATION_ACKNOWLEDGED",
      message: `I’m sorry this has been frustrating. I’ll keep it simple and focus on helping you. I still have ${orderId} in context. I can help track it, check cancellation, review return/replacement options, or mark this for human support review.`,
      suggestedActions: [
        "Track order",
        "Check cancellation",
        "Return/Replacement",
        "Human support",
      ],
      metadata: {
        requiresEscalation: needsEscalation,
      },
    });
  }

  return buildResponse({
    status: needsEscalation
      ? "FRUSTRATION_ESCALATION_READY"
      : "FRUSTRATION_ACKNOWLEDGED",
    message:
      "I’m sorry this has been frustrating. I’ll keep it simple and focus on helping you. If this is about an order, share the order ID or tell me what happened, and I’ll guide you from there.",
    suggestedActions: ["Share order ID", "Human support"],
    metadata: {
      requiresEscalation: needsEscalation,
    },
  });
}

function unsafeResponse() {
  return buildResponse({
    status: "UNSAFE_REQUEST_BLOCKED",
    message:
      "I can’t help with bypassing security, admin access, deleting logs, or private system information. I can still help with normal CartGenie order support such as tracking, refunds, delivery, returns, replacement, cancellation, or payment issues.",
    suggestedActions: ["Track order", "Refund status", "Human support"],
  });
}

function negativeCorrectionResponse(orderId) {
  if (orderId) {
    return buildResponse({
      status: "NEGATIVE_CORRECTION",
      message: `No problem — I won’t continue with that previous request for ${orderId}. Please tell me what you’d like to do instead, and I’ll help you from there.`,
      suggestedActions: [
        "Track order",
        "Refund status",
        "Return/Replacement",
        "Human support",
      ],
    });
  }

  return buildResponse({
    status: "NEGATIVE_CORRECTION",
    message:
      "No problem — I won’t continue with that previous request. Please tell me what you’d like to do instead, and I’ll help you from there.",
    suggestedActions: [
      "Track order",
      "Refund status",
      "Return/Replacement",
      "Human support",
    ],
  });
}

function missingOrderClarification(intentResult = {}) {
  const intent = getIntent(intentResult);

  const friendlyMap = {
    track_order: "tracking/status",
    cancel_order: "cancellation",
    return_order: "return",
    replace_order: "replacement",
    exchange_order: "exchange",
    reorder_order: "reorder",
    refund_status: "refund",
    payment_issue: "payment",
    delivery_issue: "delivery",
    missing_item: "missing item",
    wrong_item: "wrong item",
    damaged_item: "damaged item",
  };

  const friendly = friendlyMap[intent] || "order support";

  return buildResponse({
    status: "CLARIFICATION_REQUIRED",
    message: `Sure, I can help with your ${friendly} request. Please share your order ID, like ORD101, so I can check the latest status and guide you with the correct next step.`,
    suggestedActions: ["Share order ID", "Find order ID help"],
  });
}

function generalFallbackResponse(sessionState = {}) {
  const fallbackCount = Number(sessionState.fallbackCount || 0);
  const orderId = safeOrderId(sessionState.lastOrderId);

  if (orderId) {
    return buildResponse({
      status: "CLARIFICATION_REQUIRED",
      message: `I want to make sure I guide you correctly. Since you already shared order ${orderId}, please tell me what you want to do next: track it, cancel it, return it, replace it, exchange it, reorder it, or check refund/payment status.`,
      suggestedActions: [
        "Track order",
        "Cancel order",
        "Return/Replacement",
        "Refund status",
      ],
    });
  }

  if (fallbackCount >= 2) {
    return buildResponse({
      status: "ESCALATION_SUGGESTED",
      message:
        "I’m sorry, I’m still not understanding this clearly. You can share your order ID like ORD101 and your issue, or I can mark this for human support review.",
      suggestedActions: ["Share order ID", "Human support"],
      metadata: {
        escalationSuggested: true,
      },
    });
  }

  return buildResponse({
    status: "CLARIFICATION_REQUIRED",
    message:
      "I’m here to help with your CartGenie order issue. Tell me what happened, or share an order ID like ORD101, and I’ll guide you with the next step.",
    suggestedActions: [
      "Track order",
      "Cancel order",
      "Refund status",
      "Find order ID",
    ],
  });
}

// =====================================================
// MAIN FALLBACK RESPONSE
// =====================================================

function generateFallbackResponse(
  confidenceResult = {},
  intentResult = {},
  sessionState = {}
) {
  const intent = getIntent(intentResult);
  const query = getQuery(intentResult);
  const orderId = getLastOrderId(sessionState, intentResult);

  if (isUnsafeQuery(query) || intent === "unsafe_request") {
    return unsafeResponse();
  }

  if (isGreetingQuery(query) || intent === "greeting") {
    return greetingResponse();
  }

  if (isThanksQuery(query) || intent === "conversation_end") {
    return thanksResponse();
  }

  if (isOrderIdHelpQuery(query) || intent === "order_id_help") {
    return orderIdHelpResponse();
  }

  if (isTrustQuestion(query) || intent === "trust_question") {
    return trustQuestionResponse();
  }

  if (isToneFeedback(query) || intent === "tone_feedback") {
    return toneFeedbackResponse();
  }

  if (isContextComplaint(query) || intent === "context_complaint") {
    return contextComplaintResponse(orderId);
  }

  if (isNegativeCorrectionQuery(query) || intent === "negative_correction") {
    return negativeCorrectionResponse(orderId);
  }

  if (
    isAngryOrRudeQuery(query) ||
    intent === "customer_frustration" ||
    intent === "abusive_user" ||
    intent === "rude_user" ||
    hasRisk(confidenceResult, intentResult, "angry_customer") ||
    hasRisk(confidenceResult, intentResult, "abusive_or_rude_language")
  ) {
    return angryOrRudeResponse(orderId, confidenceResult);
  }

  if (isOffTopicQuery(query) || intent === "off_topic") {
    return offTopicResponse();
  }

  if (
    confidenceResult.requiresClarification &&
    Array.isArray(confidenceResult.missingEntities) &&
    confidenceResult.missingEntities.includes("orderId")
  ) {
    return missingOrderClarification(intentResult);
  }

  if (
    [
      "track_order",
      "cancel_order",
      "return_order",
      "replace_order",
      "exchange_order",
      "reorder_order",
      "refund_status",
      "payment_issue",
      "delivery_issue",
      "missing_item",
      "wrong_item",
      "damaged_item",
    ].includes(intent) &&
    !orderId
  ) {
    return missingOrderClarification(intentResult);
  }

  return generalFallbackResponse(sessionState);
}

// =====================================================
// ESCALATION BUILDER
// =====================================================

function buildFallbackEscalation(confidenceResult = {}) {
  const riskSignals = confidenceResult.riskSignals || [];
  const requiresEscalation = Boolean(confidenceResult.requiresEscalation);

  const highPrioritySignals = [
    "angry_customer",
    "abusive_or_rude_language",
    "customer_requested_human_support",
    "payment_risk",
    "fulfillment_risk",
    "unsafe_request",
  ];

  const hasHighPriority = riskSignals.some((signal) =>
    highPrioritySignals.includes(signal)
  );

  if (!requiresEscalation && !hasHighPriority) {
    return {
      ticketRequired: false,
    };
  }

  return {
    ticketRequired: true,
    ticketId: null,
    priority: hasHighPriority ? "HIGH" : "MEDIUM",
    assignedTeam: hasHighPriority
      ? "Customer Support Escalation Team"
      : "General Support",
    sla: hasHighPriority ? "4 business hours" : "1 business day",
    reason:
      confidenceResult.reason ||
      "Fallback/escalation required due to low confidence or customer risk signal.",
    escalationTriggers: riskSignals,
  };
}

// =====================================================
// COMPATIBILITY ALIASES
// =====================================================

function handleFallback(
  confidenceResult = {},
  intentResult = {},
  sessionState = {}
) {
  return generateFallbackResponse(
    confidenceResult,
    intentResult,
    sessionState
  );
}

function fallbackResponse(
  confidenceResult = {},
  intentResult = {},
  sessionState = {}
) {
  return generateFallbackResponse(
    confidenceResult,
    intentResult,
    sessionState
  );
}

// =====================================================
// EXPORTS
// =====================================================

module.exports = {
  generateFallbackResponse,
  buildFallbackEscalation,
  isGreetingQuery,

  handleFallback,
  fallbackResponse,

  normalizeText,
  normalizeForMatching,
  includesAny,
};