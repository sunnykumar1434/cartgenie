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

const ORDER_REQUIRED_INTENTS = [
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
];

const POLICY_INTENTS = [
  "delivery_policy",
  "refund_policy",
  "return_policy",
  "replacement_policy",
  "cancellation_policy",
];

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

function registerFailure(sessionId, type, intentResult, userQuery) {
  const session = getSession(sessionId);

  if (type === "fallback") session.fallbackCount += 1;
  if (type === "clarification") session.clarificationCount += 1;

  session.totalFailureCount =
    session.fallbackCount + session.clarificationCount;

  session.lastIntent = intentResult?.intent || session.lastIntent || null;
  session.lastOrderId = intentResult?.orderId || session.lastOrderId || null;
  session.lastTrackingId =
    intentResult?.trackingId || session.lastTrackingId || null;
  session.lastIssueType =
    intentResult?.issueType || session.lastIssueType || "general";
  session.lastStage = type;
  session.lastQuery = userQuery;
  session.updatedAt = new Date().toISOString();

  return session;
}

function resetFailureCounters(sessionId, intentResult, userQuery) {
  const session = getSession(sessionId);

  session.fallbackCount = 0;
  session.clarificationCount = 0;
  session.totalFailureCount = 0;

  session.lastIntent = intentResult?.intent || session.lastIntent || null;
  session.lastOrderId = intentResult?.orderId || session.lastOrderId || null;
  session.lastTrackingId =
    intentResult?.trackingId || session.lastTrackingId || null;
  session.lastIssueType =
    intentResult?.issueType || session.lastIssueType || "general";
  session.lastStage = "completed";
  session.lastQuery = userQuery;

  session.pendingIntent = null;
  session.pendingMissingEntity = null;
  session.pendingIssueType = null;

  session.updatedAt = new Date().toISOString();

  return session;
}

function shouldEscalateRepeatedFailure(session) {
  return session.totalFailureCount >= REPEATED_FAILURE_LIMIT;
}

function generateRepeatedFailureTicketId(sessionId) {
  const randomPart = Math.floor(100000 + Math.random() * 900000);
  const cleanSessionId = String(sessionId || "SESSION").replace(
    /[^a-zA-Z0-9]/g,
    ""
  );

  return `CG-GEN-${cleanSessionId}-${randomPart}`;
}

function buildRepeatedFailureEscalation(
  sessionId,
  session,
  userQuery,
  intentResult,
  confidenceResult
) {
  const ticketId = generateRepeatedFailureTicketId(sessionId);

  return {
    success: true,
    stage: "repeated_failure_escalation",
    query: userQuery,
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
      message:
        "I’m sorry this still has not been resolved. I’ll move this to a support specialist so your concern can be checked properly. If this is related to an order, please keep your order ID ready.",
      customerMessage:
        "I’m sorry this still has not been resolved. I’ll move this to a support specialist so your concern can be checked properly. If this is related to an order, please keep your order ID ready.",
      internal: {
        reason: "Repeated fallback or clarification failure.",
        failureLimit: REPEATED_FAILURE_LIMIT,
        fallbackCount: session.fallbackCount,
        clarificationCount: session.clarificationCount,
        totalFailureCount: session.totalFailureCount,
      },
    },
    escalation: {
      ticketRequired: true,
      ticketId,
      priority: "MEDIUM",
      assignedTeam: "General Support",
      sla: "1 business day",
      title: `[MEDIUM] General Support review required - ${sessionId}`,
      reason:
        "Customer had repeated unclear, unsupported, or incomplete support requests.",
      reasons: [
        {
          trigger: "repeated_low_confidence",
          reason:
            "Repeated fallback or clarification responses reached the escalation limit.",
        },
      ],
      escalationTriggers: ["repeated_low_confidence"],
      customerMessage: `Your case has been escalated to General Support. Expected review time: 1 business day. Ticket ID: ${ticketId}.`,
      internalNotes: {
        lastQuery: userQuery,
        lastIntent: intentResult?.intent || null,
        lastDecision: confidenceResult?.decision || null,
        createdAt: new Date().toISOString(),
      },
    },
  };
}

// =====================================================
// BASIC HELPERS
// =====================================================

function normalizeText(text = "") {
  return String(text || "").trim().toLowerCase();
}

function extractOrderId(text = "") {
  const raw = String(text || "").trim();

  let match = raw.match(/\b(?:ORD|ODR)\s*-?\s*(\d+)\b/i);
  if (match) {
    return `ORD${match[1]}`.toUpperCase();
  }

  match = raw.match(/\border(?:\s*id)?(?:\s*is)?\s*-?\s*(\d+)\b/i);
  if (match) {
    return `ORD${match[1]}`.toUpperCase();
  }

  return null;
}

function extractTrackingId(text = "") {
  const raw = String(text || "").trim();

  const match = raw.match(/\b(?:TRK|AWB)\s*-?\s*(\d+)\b/i);
  if (!match) return null;

  const prefixMatch = raw.match(/\b(TRK|AWB)\s*-?\s*\d+\b/i);
  const prefix = prefixMatch ? prefixMatch[1].toUpperCase() : "TRK";

  return `${prefix}${match[1]}`;
}

function findOrder(orderId) {
  if (!orderId) return null;

  const normalizedOrderId = String(orderId).trim().toUpperCase();

  return (
    orders.find(
      (order) => String(order.orderId).trim().toUpperCase() === normalizedOrderId
    ) || null
  );
}

function findOrderByTrackingId(trackingId) {
  if (!trackingId) return null;

  const normalizedTrackingId = String(trackingId).trim().toUpperCase();

  return (
    orders.find((order) => {
      const trackingIds = [
        order.trackingId,
        order.awb,
        order.shipmentId,
        order.courierTrackingId,
      ]
        .filter(Boolean)
        .map((value) => String(value).trim().toUpperCase());

      return trackingIds.includes(normalizedTrackingId);
    }) || null
  );
}

function getOrderSummary(order) {
  if (!order) return null;

  return {
    orderId: order.orderId,
    status: order.status,
    category: order.category,
    paymentMethod: order.paymentMethod,
    paymentStatus: order.paymentStatus,
    orderValue: order.orderValue,
    trackingId: order.trackingId || order.awb || null,
  };
}

function getIntentFriendlyName(intent) {
  const intentMap = {
    cancel_order: "cancellation",
    return_order: "return",
    replace_order: "replacement",
    exchange_order: "exchange",
    refund_status: "refund",
    payment_issue: "payment",
    track_order: "delivery or tracking",
    delivery_issue: "delivery issue",
    wrong_item: "wrong item",
    missing_item: "missing item",
    damaged_item: "damaged item",
    delivery_policy: "delivery timeline",
    refund_policy: "refund",
    return_policy: "return policy",
    replacement_policy: "replacement policy",
    cancellation_policy: "cancellation policy",
    human_support: "human support",
  };

  return intentMap[intent] || "order-related";
}

function includesAny(text, patterns = []) {
  const clean = normalizeText(text);
  return patterns.some((pattern) => clean.includes(pattern));
}

function isShortOrGarbageInput(userQuery = "") {
  const text = normalizeText(userQuery);

  if (!text) return true;

  if (isGreetingOrGreetingTypo(text) || isThanksOrConversationEndQuery(text)) {
    return false;
  }

  if (text.length <= 2) return true;
  if (/^[^a-z0-9]+$/i.test(text)) return true;

  const garbagePatterns = [
    "asdf",
    "asdfgh",
    "qwerty",
    "blah",
    "random",
    "test test",
    "aaaa",
    "????",
    "sdf",
    "xyzxyz",
    "lorem ipsum",
  ];

  return garbagePatterns.includes(text);
}

function isThanksOrConversationEndQuery(userQuery = "") {
  const text = normalizeText(userQuery);

  return [
    "thanks",
    "thank you",
    "thankyou",
    "thanks a lot",
    "thank you so much",
    "okay thanks",
    "ok thanks",
    "ok thank you",
    "okay thank you",
    "done",
    "okay done",
    "ok done",
    "got it",
    "understood",
    "fine",
    "cool",
    "great",
    "nice",
    "perfect",
    "that helps",
    "helpful",
  ].includes(text);
}

function isGreetingOrGreetingTypo(userQuery = "") {
  const text = normalizeText(userQuery);

  return [
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
    "good morning",
    "good afternoon",
    "good evening",
    "namaste",
    "namaskar",
  ].includes(text);
}

function isOrderIdFaq(userQuery = "") {
  return includesAny(userQuery, [
    "what is order id",
    "what is my order id",
    "where is order id",
    "where is my order id",
    "where to see my order id",
    "where can i see my order id",
    "where can i find my order id",
    "how to check order id",
    "how can i check order id",
    "how do i find order id",
    "find my order id",
    "i don't know my order id",
    "i dont know my order id",
    "i do not know my order id",
  ]);
}

function isRefundContextQuery(userQuery = "") {
  return includesAny(userQuery, [
    "track refund",
    "track my refund",
    "track a refund",
    "refund tracking",
    "refund status",
    "check refund",
    "where is my refund",
    "where can i check my refund",
    "where to check refund",
    "how can i track a refund",
    "how to track refund",
    "refund not received",
    "refund delayed",
    "money back",
    "want my money back",
  ]);
}

function isRefundFaq(userQuery = "") {
  return includesAny(userQuery, [
    "how long does the refund",
    "how long refund",
    "refund process take",
    "how refund works",
    "where can i check my refund",
    "where to check refund",
    "track refund",
    "track my refund",
    "track a refund",
    "refund tracking",
    "how can i track a refund",
    "how to track refund",
  ]);
}

function isPaymentContextQuery(userQuery = "") {
  return includesAny(userQuery, [
    "charged twice",
    "double charged",
    "paid twice",
    "money deducted",
    "amount deducted",
    "payment failed",
    "payment issue",
    "payment problem",
    "payment not showing",
    "paid but order is not showing",
    "paid but order not showing",
    "upi deducted",
    "card charged",
    "money debited",
    "amount debited",
  ]);
}

function isReturnWithOrderQuery(userQuery = "") {
  const text = normalizeText(userQuery);
  return (
    extractOrderId(userQuery) &&
    (text.includes("return") ||
      text.includes("can i return") ||
      text.includes("want to return"))
  );
}

function isCancellationFaq(userQuery = "") {
  return includesAny(userQuery, [
    "how can i cancel",
    "how to cancel",
    "cancellation process",
    "why was my cancellation request rejected",
    "reactivate my cancelled",
  ]);
}

function isBulkCancelQuery(userQuery = "") {
  return includesAny(userQuery, [
    "cancel all pending orders",
    "cancel all orders",
    "cancel every order",
    "cancel my all orders",
  ]);
}

function isSubscriptionOrAccountQuery(userQuery = "") {
  return includesAny(userQuery, [
    "subscription",
    "membership",
    "premium plan",
    "premium subscription",
    "downgrade",
    "renewal",
    "gift card",
    "wrong plan",
  ]);
}

function isFollowUpQuery(userQuery = "") {
  return includesAny(userQuery, [
    "details",
    "give me details",
    "show details",
    "status",
    "current status",
    "track it",
    "track this",
    "what about it",
    "what happened",
    "tell me more",
    "more details",
    "where is it",
    "is it delivered",
    "delivered or not",
    "cancel my order",
    "return my order",
    "replace my order",
    "exchange my order",
    "refund status",
    "check refund",
    "give tracking details",
    "tracking details",
    "latest status",
    "latest update",
  ]);
}

function shouldUseLastOrder(intentResult, session, userQuery) {
  if (intentResult.orderId) return false;
  if (!session.lastOrderId) return false;

  if (ORDER_REQUIRED_INTENTS.includes(intentResult.intent)) return true;
  if (isFollowUpQuery(userQuery)) return true;

  return false;
}

function isIntentSwitch(userQuery = "", newIntent, session) {
  const text = normalizeText(userQuery);

  if (!session.lastIntent) return false;
  if (!newIntent || newIntent === session.lastIntent) return false;

  const switchWords = [
    "instead",
    "actually",
    "sorry",
    "no",
    "change",
    "i mean",
    "rather",
  ];

  return (
    switchWords.some((word) => text.includes(word)) &&
    ORDER_REQUIRED_INTENTS.includes(newIntent)
  );
}

function getPolicyFollowUpIntent(intent) {
  const map = {
    delivery_policy: "track_order",
    refund_policy: "refund_status",
    return_policy: "return_order",
    replacement_policy: "replace_order",
    cancellation_policy: "cancel_order",
  };

  return map[intent] || null;
}

function isNonFailureFallback(intentResult, confidenceResult) {
  const intent = intentResult?.intent || confidenceResult?.intent;
  const decision = confidenceResult?.decision;

  if (intent === "greeting") return true;
  if (intent === "non_commerce_request") return true;
  if (POLICY_INTENTS.includes(intent)) return true;

  if (decision === "greeting_detected") return true;
  if (decision === "non_commerce_request") return true;
  if (decision === "general_policy_query") return true;

  return false;
}

function getFallbackStage(intentResult, confidenceResult) {
  const intent = intentResult?.intent || confidenceResult?.intent;
  const decision = confidenceResult?.decision;

  if (intent === "greeting" || decision === "greeting_detected") {
    return "greeting";
  }

  if (intent === "unsafe_request" || decision === "unsafe_input_detected") {
    return "safety_fallback";
  }

  if (intent === "non_commerce_request" || decision === "non_commerce_request") {
    return "off_topic";
  }

  if (POLICY_INTENTS.includes(intent) || decision === "general_policy_query") {
    return "policy_info";
  }

  return "fallback";
}

// =====================================================
// DIRECT RESPONSE BUILDERS
// =====================================================

function buildDirectInfoResult(
  sessionId,
  userQuery,
  infoType,
  message,
  extra = {}
) {
  const session = updateSession(sessionId, {
    fallbackCount: 0,
    clarificationCount: 0,
    totalFailureCount: 0,
    lastIntent: infoType,
    lastStage: "direct_info",
    lastQuery: userQuery,
    pendingIntent: extra.pendingIntent || null,
    pendingMissingEntity: extra.pendingIntent ? "orderId" : null,
    pendingIssueType: extra.pendingIssueType || "general",
  });

  const intentResult = {
    intent: infoType,
    confidence: 1,
    orderId: null,
    trackingId: null,
    issueType: extra.pendingIssueType || "general",
    rawText: userQuery,
    source: "local_direct_info_handler",
  };

  const confidenceResult = {
    originalConfidence: 1,
    normalizedConfidence: 1,
    highThreshold: 0.75,
    lowThreshold: 0.5,
    intent: infoType,
    route: "direct_info",
    decision: infoType,
    allowedToUseRuleEngine: false,
    requiresFallback: false,
    requiresClarification: false,
    requiresEscalation: false,
    missingEntities: [],
    riskSignals: [],
    reason: "Direct FAQ or general support answer.",
    metadata: {
      orderId: null,
      issueType: extra.pendingIssueType || "general",
    },
  };

  return {
    success: true,
    stage: "direct_info",
    query: userQuery,
    sessionId,
    sessionState: session,
    intentResult,
    confidenceResult,
    orderFound: false,
    orderSummary: null,
    ruleResult: null,
    response: {
      success: true,
      status: "INFO",
      message,
      customerMessage: message,
      internal: {
        decision: infoType,
        pendingIntent: extra.pendingIntent || null,
      },
    },
    escalation: {
      ticketRequired: false,
    },
  };
}

function buildDirectAnswerIfMatched(sessionId, userQuery, session) {
  if (isOrderIdFaq(userQuery)) {
    return buildDirectInfoResult(
      sessionId,
      userQuery,
      "order_id_faq",
      "Sure, I can help with that. Your order ID is usually available in your order confirmation email or SMS, invoice, or the order history section of your account. It usually looks like ORD101. Once you share it here, I can help you track, cancel, return, replace, or check refund status."
    );
  }

  if (isBulkCancelQuery(userQuery)) {
    return buildDirectInfoResult(
      sessionId,
      userQuery,
      "cancel_order",
      "I understand you want to cancel multiple orders. For safety, I can check one order at a time in this demo. Please share the order ID, like ORD101, and I’ll check whether cancellation is available for that order.",
      {
        pendingIntent: "cancel_order",
        pendingIssueType: "general",
      }
    );
  }

  if (isRefundFaq(userQuery)) {
    return buildDirectInfoResult(
      sessionId,
      userQuery,
      "refund_policy",
      session.lastOrderId
        ? `Sure, I can help with refund tracking. Since you already shared ${session.lastOrderId}, you can simply say "check refund status" and I’ll use that order.`
        : "Sure, I can help with refund tracking. Refunds usually take 3-7 business days after cancellation or return approval. Card refunds can sometimes take 7-10 business days depending on the bank. Please share your order ID, like ORD101, and I’ll check the exact refund status.",
      {
        pendingIntent: "refund_status",
        pendingIssueType: "refund_dispute",
      }
    );
  }

  if (isCancellationFaq(userQuery)) {
    return buildDirectInfoResult(
      sessionId,
      userQuery,
      "cancellation_policy",
      session.lastOrderId
        ? `Sure, I can help with cancellation. Since you already shared ${session.lastOrderId}, you can say "cancel my order" and I’ll check whether cancellation is available.`
        : "Sure, I can help with cancellation. Cancellation is usually possible before the order is dispatched or shipped. Please share your order ID, like ORD101, and I’ll check whether it can still be cancelled.",
      {
        pendingIntent: "cancel_order",
        pendingIssueType: "general",
      }
    );
  }

  if (isSubscriptionOrAccountQuery(userQuery)) {
    return buildDirectInfoResult(
      sessionId,
      userQuery,
      "account_or_subscription_help",
      "I understand. This demo is mainly focused on order support, such as tracking, cancellation, returns, refunds, replacement, delivery, and payment issues. If your concern is connected to an order or payment, please share the order ID and I’ll guide you with the best next step."
    );
  }

  return null;
}

function buildShortInputResult(sessionId, userQuery, session) {
  return {
    success: true,
    stage: "short_unclear_input",
    query: userQuery,
    sessionId,
    sessionState: session,
    intentResult: {
      intent: "general_support",
      confidence: 0.2,
      orderId: null,
      trackingId: null,
      issueType: "general",
      rawText: userQuery,
      source: "local_short_input_guard",
    },
    confidenceResult: {
      route: "clarification",
      decision: "short_unclear_input",
      requiresClarification: true,
      requiresFallback: false,
      requiresEscalation: false,
      missingEntities: [],
      riskSignals: [],
    },
    orderFound: false,
    orderSummary: null,
    ruleResult: null,
    response: {
      success: true,
      status: "CLARIFICATION_REQUIRED",
      message:
        "I’m here to help. Could you please type your complete order-related issue? For example, you can say: track my order ORD108, cancel my order ORD101, or check refund status ORD106.",
      customerMessage:
        "I’m here to help. Could you please type your complete order-related issue? For example, you can say: track my order ORD108, cancel my order ORD101, or check refund status ORD106.",
    },
    escalation: {
      ticketRequired: false,
    },
  };
}

function buildGreetingResult(sessionId, userQuery) {
  const session = updateSession(sessionId, {
    fallbackCount: 0,
    clarificationCount: 0,
    totalFailureCount: 0,
    lastIntent: "greeting",
    lastStage: "greeting",
    lastQuery: userQuery,
    pendingIntent: null,
    pendingMissingEntity: null,
    pendingIssueType: null,
  });

  const intentResult = {
    intent: "greeting",
    confidence: 1,
    orderId: null,
    trackingId: null,
    issueType: "general",
    rawText: userQuery,
    source: "local_greeting_handler",
  };

  const confidenceResult = {
    originalConfidence: 1,
    normalizedConfidence: 1,
    highThreshold: 0.75,
    lowThreshold: 0.5,
    intent: "greeting",
    route: "greeting",
    decision: "greeting_detected",
    allowedToUseRuleEngine: false,
    requiresFallback: false,
    requiresClarification: false,
    requiresEscalation: false,
    missingEntities: [],
    riskSignals: [],
    reason: "Greeting detected.",
    metadata: {
      orderId: null,
      issueType: "general",
    },
  };

  return {
    success: true,
    stage: "greeting",
    query: userQuery,
    sessionId,
    sessionState: session,
    intentResult,
    confidenceResult,
    orderFound: false,
    orderSummary: null,
    ruleResult: null,
    response: {
      success: true,
      status: "GREETING",
      message:
        "Hi, welcome to CartGenie AI. How can I help you today? I can help with order tracking, cancellation, returns, refunds, replacement, exchange, delivery, and payment issues. If your request is related to an order, please share your order ID like ORD101.",
      customerMessage:
        "Hi, welcome to CartGenie AI. How can I help you today? I can help with order tracking, cancellation, returns, refunds, replacement, exchange, delivery, and payment issues. If your request is related to an order, please share your order ID like ORD101.",
      internal: {
        decision: "greeting_detected",
        route: "greeting",
      },
    },
    escalation: {
      ticketRequired: false,
    },
  };
}

function buildConversationEndResult(sessionId, userQuery) {
  const session = updateSession(sessionId, {
    fallbackCount: 0,
    clarificationCount: 0,
    totalFailureCount: 0,
    lastIntent: "conversation_end",
    lastStage: "conversation_end",
    lastQuery: userQuery,
    pendingIntent: null,
    pendingMissingEntity: null,
    pendingIssueType: null,
  });

  const intentResult = {
    intent: "conversation_end",
    confidence: 1,
    orderId: null,
    trackingId: null,
    issueType: "general",
    rawText: userQuery,
    source: "local_conversation_end_handler",
  };

  const confidenceResult = {
    originalConfidence: 1,
    normalizedConfidence: 1,
    highThreshold: 0.75,
    lowThreshold: 0.5,
    intent: "conversation_end",
    route: "direct_info",
    decision: "conversation_end",
    allowedToUseRuleEngine: false,
    requiresFallback: false,
    requiresClarification: false,
    requiresEscalation: false,
    missingEntities: [],
    riskSignals: [],
    reason: "Customer ended the conversation politely.",
    metadata: {
      orderId: null,
      issueType: "general",
    },
  };

  return {
    success: true,
    stage: "conversation_end",
    query: userQuery,
    sessionId,
    sessionState: session,
    intentResult,
    confidenceResult,
    orderFound: false,
    orderSummary: null,
    ruleResult: null,
    response: {
      success: true,
      status: "CONVERSATION_END",
      message:
        "You’re welcome. I’m glad I could help. If you need anything else with your order later, just message me anytime.",
      customerMessage:
        "You’re welcome. I’m glad I could help. If you need anything else with your order later, just message me anytime.",
      internal: {
        decision: "conversation_end",
      },
    },
    escalation: {
      ticketRequired: false,
    },
  };
}

function buildOrderReferenceOnlyResponse(orderId, order) {
  if (!order) {
    return {
      success: true,
      status: "CLARIFICATION_REQUIRED",
      message: `I’m sorry, I could not find order ${orderId} in the demo records. Please check the order ID once and share it again.`,
      customerMessage: `I’m sorry, I could not find order ${orderId} in the demo records. Please check the order ID once and share it again.`,
      internal: {
        decision: "order_reference_only_order_not_found",
        orderId,
      },
    };
  }

  return {
    success: true,
    status: "CLARIFICATION_REQUIRED",
    message: `Thanks for sharing order ${orderId}. I found this order. Please tell me what you’d like to do next: track it, cancel it, return it, replace it, exchange it, or check refund/payment status.`,
    customerMessage: `Thanks for sharing order ${orderId}. I found this order. Please tell me what you’d like to do next: track it, cancel it, return it, replace it, exchange it, or check refund/payment status.`,
    internal: {
      decision: "order_reference_only_needs_intent",
      orderId,
      orderSummary: getOrderSummary(order),
    },
  };
}

function buildHumanSupportResult(
  sessionId,
  userQuery,
  intentResult,
  confidenceResult
) {
  const existingSession = getSession(sessionId);

  const session = updateSession(sessionId, {
    lastIntent: "human_support",
    lastOrderId: intentResult.orderId || existingSession.lastOrderId || null,
    lastTrackingId:
      intentResult.trackingId || existingSession.lastTrackingId || null,
    lastIssueType:
      intentResult.issueType || existingSession.lastIssueType || "general",
    lastStage: "human_support_requested",
    lastQuery: userQuery,
    pendingIntent: "human_support",
    pendingMissingEntity:
      intentResult.orderId || existingSession.lastOrderId ? null : "orderId",
  });

  const ticketId = `CG-HUM-${String(sessionId).replace(
    /[^a-zA-Z0-9]/g,
    ""
  )}-${Math.floor(100000 + Math.random() * 900000)}`;

  return {
    success: true,
    stage: "human_support",
    query: userQuery,
    sessionId,
    sessionState: session,
    intentResult,
    confidenceResult,
    orderFound: Boolean(intentResult.orderId && findOrder(intentResult.orderId)),
    orderSummary: intentResult.orderId
      ? getOrderSummary(findOrder(intentResult.orderId))
      : null,
    ruleResult: null,
    response: {
      success: true,
      status: "ESCALATION_REQUIRED",
      message:
        "Of course. I’ll mark this conversation for human support review. If this is related to a specific order, please share the order ID so the support team can check it faster.",
      customerMessage:
        "Of course. I’ll mark this conversation for human support review. If this is related to a specific order, please share the order ID so the support team can check it faster.",
      internal: {
        decision: "customer_requested_human_support",
        intent: "human_support",
      },
    },
    escalation: {
      ticketRequired: true,
      ticketId,
      priority: "MEDIUM",
      assignedTeam: "General Support",
      sla: "1 business day",
      title: `[MEDIUM] Human support requested - ${sessionId}`,
      reason: "Customer requested a human support agent.",
      reasons: [
        {
          trigger: "customer_requested_human_support",
          reason:
            "Customer explicitly asked to speak with a human/support agent.",
        },
      ],
      escalationTriggers: ["customer_requested_human_support"],
      customerMessage: `Your request has been marked for human support review. Expected review time: 1 business day. Ticket ID: ${ticketId}.`,
      internalNotes: {
        query: userQuery,
        createdAt: new Date().toISOString(),
      },
    },
  };
}

function buildClarificationResponse(
  confidenceResult,
  intentResult,
  sessionState
) {
  const missing = confidenceResult.missingEntities || [];
  const attempt = sessionState?.totalFailureCount || 0;
  const friendlyIntent = getIntentFriendlyName(intentResult?.intent);

  if (missing.includes("orderId")) {
    if (attempt >= 2) {
      return {
        success: true,
        status: "CLARIFICATION_REQUIRED",
        message:
          "I can help with this, but I still need your order ID to check the correct details. Please share it in a format like ORD101. I can help with cancellation, return, refund, replacement, exchange, delivery, tracking, or payment issues.",
        customerMessage:
          "I can help with this, but I still need your order ID to check the correct details. Please share it in a format like ORD101. I can help with cancellation, return, refund, replacement, exchange, delivery, tracking, or payment issues.",
        internal: {
          route: confidenceResult.route,
          decision: confidenceResult.decision,
          intent: intentResult.intent,
          confidence: intentResult.confidence,
          missingEntities: missing,
          attempt,
        },
      };
    }

    return {
      success: true,
      status: "CLARIFICATION_REQUIRED",
      message: `Sure, I can help with your ${friendlyIntent} request. Please share your order ID, like ORD101, so I can check the latest status and guide you with the correct next step.`,
      customerMessage: `Sure, I can help with your ${friendlyIntent} request. Please share your order ID, like ORD101, so I can check the latest status and guide you with the correct next step.`,
      internal: {
        route: confidenceResult.route,
        decision: confidenceResult.decision,
        intent: intentResult.intent,
        confidence: intentResult.confidence,
        missingEntities: missing,
        attempt,
      },
    };
  }

  return {
    success: true,
    status: "CLARIFICATION_REQUIRED",
    message:
      "I want to make sure I guide you correctly. Could you please share a little more detail about the issue? If this is related to an order, please also share the order ID.",
    customerMessage:
      "I want to make sure I guide you correctly. Could you please share a little more detail about the issue? If this is related to an order, please also share the order ID.",
    internal: {
      route: confidenceResult.route,
      decision: confidenceResult.decision,
      intent: intentResult.intent,
      confidence: intentResult.confidence,
      missingEntities: missing,
      attempt,
    },
  };
}

// =====================================================
// CONTEXT RESOLUTION
// =====================================================

function resolveIntentWithSession(intentResult, session, userQuery) {
  const resolved = {
    ...intentResult,
    originalIntent: intentResult.intent,
    originalOrderId: intentResult.orderId || null,
    originalTrackingId: intentResult.trackingId || null,
    contextResolved: false,
    contextReason: null,
  };

  const explicitOrderId = extractOrderId(userQuery);
  const explicitTrackingId = extractTrackingId(userQuery);

  if (explicitTrackingId && !explicitOrderId) {
    const trackingOrder = findOrderByTrackingId(explicitTrackingId);

    if (trackingOrder) {
      resolved.intent = "track_order";
      resolved.orderId = trackingOrder.orderId;
      resolved.trackingId = explicitTrackingId;
      resolved.issueType = "general";
      resolved.confidence = Math.max(resolved.confidence || 0, 0.95);
      resolved.contextResolved = true;
      resolved.contextReason = "resolved_order_using_tracking_id";
      return resolved;
    }

    resolved.trackingId = explicitTrackingId;
  }

  if (explicitOrderId && !resolved.orderId) {
    resolved.orderId = explicitOrderId;
    resolved.confidence = Math.max(resolved.confidence || 0, 0.88);
    resolved.contextResolved = true;
    resolved.contextReason = "resolved_explicit_or_typo_order_id";
  }

  if (isPaymentContextQuery(userQuery)) {
    resolved.intent = "payment_issue";
    resolved.orderId =
      explicitOrderId || session.lastOrderId || resolved.orderId || null;
    resolved.issueType = "payment_conflict";
    resolved.confidence = Math.max(resolved.confidence || 0, 0.95);
    resolved.contextResolved = Boolean(resolved.orderId);
    resolved.contextReason = "payment_context_priority";
    return resolved;
  }

  if (isRefundContextQuery(userQuery)) {
    resolved.intent =
      explicitOrderId || session.lastOrderId || resolved.orderId
        ? "refund_status"
        : "refund_policy";
    resolved.orderId =
      explicitOrderId || session.lastOrderId || resolved.orderId || null;
    resolved.issueType = "refund_dispute";
    resolved.confidence = Math.max(resolved.confidence || 0, 0.94);
    resolved.contextResolved = Boolean(resolved.orderId);
    resolved.contextReason = "refund_context_priority_over_tracking";
    return resolved;
  }

  if (isReturnWithOrderQuery(userQuery)) {
    resolved.intent = "return_order";
    resolved.orderId = explicitOrderId || resolved.orderId;
    resolved.issueType = resolved.issueType || "general";
    resolved.confidence = Math.max(resolved.confidence || 0, 0.93);
    resolved.contextResolved = true;
    resolved.contextReason = "return_with_order_id_priority";
    return resolved;
  }

  if (resolved.intent === "order_reference_only" && explicitOrderId) {
    if (session.pendingIntent) {
      resolved.intent = session.pendingIntent;
      resolved.orderId = explicitOrderId;
      resolved.issueType = session.pendingIssueType || "general";
      resolved.confidence = Math.max(resolved.confidence || 0, 0.95);
      resolved.contextResolved = true;
      resolved.contextReason = "resolved_order_id_using_pending_intent";
      return resolved;
    }

    if (
      session.lastIntent &&
      ORDER_REQUIRED_INTENTS.includes(session.lastIntent)
    ) {
      resolved.intent = session.lastIntent;
      resolved.orderId = explicitOrderId;
      resolved.issueType = session.lastIssueType || "general";
      resolved.confidence = Math.max(resolved.confidence || 0, 0.9);
      resolved.contextResolved = true;
      resolved.contextReason = "resolved_order_id_using_last_intent";
      return resolved;
    }

    resolved.intent = "order_reference_only";
    resolved.orderId = explicitOrderId;
    resolved.contextResolved = false;
    resolved.contextReason = "only_order_id_without_pending_intent";
    return resolved;
  }

  if (shouldUseLastOrder(resolved, session, userQuery)) {
    resolved.orderId = session.lastOrderId;
    resolved.trackingId = resolved.trackingId || session.lastTrackingId || null;
    resolved.issueType =
      resolved.issueType || session.lastIssueType || "general";

    if (
      resolved.intent === "general_support" ||
      resolved.intent === "order_reference_only"
    ) {
      resolved.intent = session.lastIntent || "track_order";
    }

    if (!ORDER_REQUIRED_INTENTS.includes(resolved.intent)) {
      resolved.intent = "track_order";
    }

    resolved.confidence = Math.max(resolved.confidence || 0, 0.88);
    resolved.contextResolved = true;
    resolved.contextReason = "resolved_follow_up_using_last_order";
    return resolved;
  }

  if (isIntentSwitch(userQuery, resolved.intent, session)) {
    resolved.orderId = resolved.orderId || session.lastOrderId || null;
    resolved.trackingId = resolved.trackingId || session.lastTrackingId || null;
    resolved.contextResolved = Boolean(resolved.orderId);
    resolved.contextReason = "intent_switch_detected";
    return resolved;
  }

  return resolved;
}

// =====================================================
// MAIN CARTGENIE PIPELINE
// =====================================================

async function runCartGeniePipeline(userQuery, options = {}) {
  const sessionId = options.sessionId || "default_session";
  const existingSession = getSession(sessionId);

  if (isThanksOrConversationEndQuery(userQuery)) {
    return buildConversationEndResult(sessionId, userQuery);
  }

  const directAnswer = buildDirectAnswerIfMatched(
    sessionId,
    userQuery,
    existingSession
  );

  if (directAnswer) {
    return directAnswer;
  }

  if (isGreetingOrGreetingTypo(userQuery) || isGreetingQuery(userQuery)) {
    return buildGreetingResult(sessionId, userQuery);
  }

  if (isShortOrGarbageInput(userQuery)) {
    return buildShortInputResult(sessionId, userQuery, existingSession);
  }

  const rawIntentResult = await detectIntentAndEntities(userQuery);

  const intentResult = resolveIntentWithSession(
    rawIntentResult,
    existingSession,
    userQuery
  );

  const confidenceResult = evaluateConfidence(intentResult, {
    query: userQuery,
  });

  if (
    confidenceResult.route === "human_support" ||
    confidenceResult.route === "escalation"
  ) {
    return buildHumanSupportResult(
      sessionId,
      userQuery,
      intentResult,
      confidenceResult
    );
  }

  if (confidenceResult.route === "context_resolution") {
    const order =
      findOrder(intentResult.orderId) ||
      findOrderByTrackingId(intentResult.trackingId);

    const session = updateSession(sessionId, {
      lastIntent: "order_reference_only",
      lastOrderId: intentResult.orderId || existingSession.lastOrderId,
      lastTrackingId: intentResult.trackingId || existingSession.lastTrackingId,
      lastIssueType: intentResult.issueType || "general",
      lastStage: "context_resolution",
      lastQuery: userQuery,
    });

    return {
      success: true,
      stage: "context_resolution",
      query: userQuery,
      sessionId,
      sessionState: session,
      intentResult,
      confidenceResult,
      orderFound: Boolean(order),
      orderSummary: getOrderSummary(order),
      ruleResult: null,
      response: buildOrderReferenceOnlyResponse(intentResult.orderId, order),
      escalation: {
        ticketRequired: false,
      },
    };
  }

  if (confidenceResult.route === "clarification") {
    const session = registerFailure(
      sessionId,
      "clarification",
      intentResult,
      userQuery
    );

    if (confidenceResult.missingEntities?.includes("orderId")) {
      updateSession(sessionId, {
        pendingIntent: intentResult.intent,
        pendingMissingEntity: "orderId",
        pendingIssueType: intentResult.issueType || "general",
      });
    }

    if (shouldEscalateRepeatedFailure(session)) {
      return buildRepeatedFailureEscalation(
        sessionId,
        session,
        userQuery,
        intentResult,
        confidenceResult
      );
    }

    return {
      success: true,
      stage: "confidence_clarification",
      query: userQuery,
      sessionId,
      sessionState: getSession(sessionId),
      intentResult,
      confidenceResult,
      orderFound: false,
      orderSummary: null,
      ruleResult: null,
      response: buildClarificationResponse(
        confidenceResult,
        intentResult,
        getSession(sessionId)
      ),
      escalation: {
        ticketRequired: false,
      },
    };
  }

  if (confidenceResult.route === "fallback_llm") {
    const fallbackStage = getFallbackStage(intentResult, confidenceResult);
    const nonFailureFallback = isNonFailureFallback(
      intentResult,
      confidenceResult
    );

    let session;

    if (nonFailureFallback) {
      const policyFollowUpIntent = getPolicyFollowUpIntent(
        intentResult.intent || confidenceResult.intent
      );

      session = updateSession(sessionId, {
        lastIntent: intentResult.intent || confidenceResult.intent,
        lastOrderId: intentResult.orderId || existingSession.lastOrderId,
        lastTrackingId:
          intentResult.trackingId || existingSession.lastTrackingId,
        lastIssueType: intentResult.issueType || "general",
        lastStage: fallbackStage,
        lastQuery: userQuery,
        pendingIntent: policyFollowUpIntent,
        pendingMissingEntity: policyFollowUpIntent ? "orderId" : null,
        pendingIssueType: intentResult.issueType || "general",
      });
    } else if (confidenceResult.decision === "unsafe_input_detected") {
      session = updateSession(sessionId, {
        lastIntent: intentResult.intent || "unsafe_request",
        lastOrderId: intentResult.orderId || existingSession.lastOrderId,
        lastTrackingId:
          intentResult.trackingId || existingSession.lastTrackingId,
        lastIssueType: intentResult.issueType || "unsafe",
        lastStage: fallbackStage,
        lastQuery: userQuery,
        pendingIntent: null,
        pendingMissingEntity: null,
        pendingIssueType: null,
      });
    } else {
      session = registerFailure(sessionId, "fallback", intentResult, userQuery);

      if (shouldEscalateRepeatedFailure(session)) {
        return buildRepeatedFailureEscalation(
          sessionId,
          session,
          userQuery,
          intentResult,
          confidenceResult
        );
      }
    }

    return {
      success: true,
      stage: fallbackStage,
      query: userQuery,
      sessionId,
      sessionState: session,
      intentResult,
      confidenceResult,
      orderFound: false,
      orderSummary: null,
      ruleResult: null,
      response: generateFallbackResponse(
        confidenceResult,
        intentResult,
        session
      ),
      escalation: buildFallbackEscalation(confidenceResult),
    };
  }

  const order =
    findOrder(intentResult.orderId) ||
    findOrderByTrackingId(intentResult.trackingId);

  const ruleResult = applyRules({
    intent: intentResult.intent,
    order,
    issueType: intentResult.issueType,
  });

  if (confidenceResult.requiresEscalation) {
    ruleResult.requiresEscalation = true;
    ruleResult.escalationTriggers = [
      ...(ruleResult.escalationTriggers || []),
      ...(confidenceResult.riskSignals || []),
    ];
    ruleResult.escalationTriggers = [...new Set(ruleResult.escalationTriggers)];
  }

  const response = generateResponse(ruleResult);

  const escalation = handleEscalation(ruleResult, {
    query: userQuery,
    customerTone: confidenceResult.riskSignals.includes("angry_customer")
      ? "angry"
      : "neutral",
    source: "api",
  });

  resetFailureCounters(sessionId, intentResult, userQuery);

  return {
    success: true,
    stage: "completed",
    query: userQuery,
    sessionId,
    sessionState: getSession(sessionId),
    intentResult,
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
    architecture: [
      "Intent Agent",
      "Confidence Agent",
      "Session Context Resolver",
      "Order Lookup",
      "Rule Engine",
      "Fallback Agent",
      "Response Agent",
      "Escalation Agent",
      "Audit Logger",
      "Session-Based Repeated Failure Escalation",
    ],
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
      message:
        "I’m sorry, I could not find this order in the demo records. Please check the order ID once and try again.",
      customerMessage:
        "I’m sorry, I could not find this order in the demo records. Please check the order ID once and try again.",
      orderId,
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
  const session = sessionStore[sessionId];

  if (!session) {
    return res.status(404).json({
      success: false,
      message: "I’m sorry, this session was not found.",
      customerMessage: "I’m sorry, this session was not found.",
      sessionId,
    });
  }

  return res.json({
    success: true,
    session,
  });
});

app.delete("/api/sessions/:sessionId", (req, res) => {
  const sessionId = req.params.sessionId;

  if (sessionStore[sessionId]) {
    delete sessionStore[sessionId];
  }

  return res.json({
    success: true,
    message: "Session reset successfully.",
    customerMessage: "Session reset successfully.",
    sessionId,
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
    const { query, sessionId } = req.body;

    if (!query || typeof query !== "string" || query.trim().length === 0) {
      return res.status(400).json({
        success: false,
        status: "INVALID_REQUEST",
        message:
          "Please enter your support request so I can help you. For example, you can say: Cancel my order ORD101.",
        customerMessage:
          "Please enter your support request so I can help you. For example, you can say: Cancel my order ORD101.",
        example: {
          sessionId: "user_123",
          query: "Cancel my order ORD101",
        },
      });
    }

    const safeSessionId =
      typeof sessionId === "string" && sessionId.trim().length > 0
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
      error: process.env.NODE_ENV === "production" ? undefined : error.message,
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