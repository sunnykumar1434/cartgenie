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

// =====================================================
// SESSION STORE
// In production, move this to Redis/MongoDB.
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

  if (type === "fallback") {
    session.fallbackCount += 1;
  }

  if (type === "clarification") {
    session.clarificationCount += 1;
  }

  session.totalFailureCount =
    session.fallbackCount + session.clarificationCount;

  session.lastIntent = intentResult?.intent || session.lastIntent || null;
  session.lastOrderId = intentResult?.orderId || session.lastOrderId || null;
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

function clearPendingContext(sessionId) {
  return updateSession(sessionId, {
    pendingIntent: null,
    pendingMissingEntity: null,
    pendingIssueType: null,
  });
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
    ruleResult: null,
    response: {
      success: true,
      status: "ESCALATION_REQUIRED",
      message:
        "I am sorry this has not been resolved yet. I am moving this to a support specialist so your concern can be reviewed properly. If this is related to an order, please keep your order ID ready.",
      customerMessage:
        "I am sorry this has not been resolved yet. I am moving this to a support specialist so your concern can be reviewed properly. If this is related to an order, please keep your order ID ready.",
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
      title: `[MEDIUM] General Support review required for repeated unresolved query - ${sessionId}`,
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

// ===============================
// MIDDLEWARE
// ===============================

app.use(cors());
app.use(express.json());

// ===============================
// HELPERS
// ===============================

function normalizeText(text = "") {
  return String(text).trim().toLowerCase();
}

function extractOrderId(text = "") {
  const raw = String(text || "").trim();

  // Supports: ORD101, ord101, ODR105 typo
  let match = raw.match(/\b(?:ORD|ODR)\s*-?\s*(\d+)\b/i);
  if (match) {
    return `ORD${match[1]}`.toUpperCase();
  }

  // Supports: order 101, order id 101, my order id is 101
  match = raw.match(/\border(?:\s*id)?(?:\s*is)?\s*-?\s*(\d+)\b/i);
  if (match) {
    return `ORD${match[1]}`.toUpperCase();
  }

  return null;
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

function getOrderSummary(order) {
  if (!order) return null;

  return {
    orderId: order.orderId,
    status: order.status,
    category: order.category,
    paymentMethod: order.paymentMethod,
    paymentStatus: order.paymentStatus,
    orderValue: order.orderValue,
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
    refund_policy: "refund timeline",
    return_policy: "return policy",
    replacement_policy: "replacement policy",
    cancellation_policy: "cancellation policy",
    human_support: "human support",
  };

  return intentMap[intent] || "order-related";
}

function isFollowUpQuery(userQuery = "") {
  const text = normalizeText(userQuery);

  const followUpWords = [
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
  ];

  return followUpWords.some((word) => text.includes(word));
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

  const hasSwitchWord = switchWords.some((word) => text.includes(word));

  return hasSwitchWord && ORDER_REQUIRED_INTENTS.includes(newIntent);
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

function resolveIntentWithSession(intentResult, session, userQuery) {
  const resolved = {
    ...intentResult,
    originalIntent: intentResult.intent,
    originalOrderId: intentResult.orderId || null,
    contextResolved: false,
    contextReason: null,
  };

  const explicitOrderId = extractOrderId(userQuery);

  if (explicitOrderId && !resolved.orderId) {
    resolved.orderId = explicitOrderId;
    resolved.confidence = Math.max(resolved.confidence || 0, 0.88);
    resolved.contextResolved = true;
    resolved.contextReason = "resolved_explicit_or_typo_order_id";
  }

  if (intentResult.intent === "order_reference_only" && explicitOrderId) {
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

  if (shouldUseLastOrder(intentResult, session, userQuery)) {
    resolved.orderId = session.lastOrderId;
    resolved.issueType =
      intentResult.issueType || session.lastIssueType || "general";

    if (
      intentResult.intent === "general_support" ||
      intentResult.intent === "order_reference_only"
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

  if (isIntentSwitch(userQuery, intentResult.intent, session)) {
    resolved.orderId = intentResult.orderId || session.lastOrderId || null;
    resolved.contextResolved = Boolean(resolved.orderId);
    resolved.contextReason = "intent_switch_detected";
    return resolved;
  }

  return resolved;
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

function isOrderIdFaq(userQuery = "") {
  const text = normalizeText(userQuery);

  return (
    text.includes("what is order id") ||
    text.includes("what is my order id") ||
    text.includes("where is order id") ||
    text.includes("where is my order id") ||
    text.includes("where to see my order id") ||
    text.includes("where can i see my order id") ||
    text.includes("how to check order id") ||
    text.includes("how can i check order id") ||
    text.includes("how do i find order id") ||
    text.includes("find my order id")
  );
}

function isCancellationFaq(userQuery = "") {
  const text = normalizeText(userQuery);

  return (
    text.includes("how can i cancel") ||
    text.includes("how to cancel") ||
    text.includes("cancellation process") ||
    text.includes("why was my cancellation request rejected") ||
    text.includes("reactivate my cancelled")
  );
}

function isRefundFaq(userQuery = "") {
  const text = normalizeText(userQuery);

  return (
    text.includes("how long does the refund") ||
    text.includes("how long refund") ||
    text.includes("refund process take") ||
    text.includes("how refund works") ||
    text.includes("where can i check my refund") ||
    text.includes("where to check refund")
  );
}

function isSubscriptionOrAccountQuery(userQuery = "") {
  const text = normalizeText(userQuery);

  return [
    "subscription",
    "membership",
    "premium plan",
    "premium subscription",
    "downgrade",
    "renewal",
    "account",
    "billed",
    "billing",
    "gift card",
    "wrong plan",
  ].some((word) => text.includes(word));
}

function buildDirectInfoResult(sessionId, userQuery, infoType, message, extra = {}) {
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
      "Your order ID is usually available in your order confirmation email/SMS, invoice, or the order history section of your account. It looks like ORD101. If you share it here, I can help you track, cancel, return, replace, or check refund status."
    );
  }

  if (isRefundFaq(userQuery)) {
    return buildDirectInfoResult(
      sessionId,
      userQuery,
      "refund_policy",
      session.lastOrderId
        ? `Refund timelines usually depend on payment method and the current order stage. Since you already shared ${session.lastOrderId}, you can ask "check refund status" and I will use that order.`
        : "Refunds usually take 3-7 business days after cancellation/return approval. Card refunds can take 7-10 business days, while wallet refunds may be faster. Share your order ID if you want the exact refund status.",
      { pendingIntent: "refund_status", pendingIssueType: "refund_dispute" }
    );
  }

  if (isCancellationFaq(userQuery)) {
    return buildDirectInfoResult(
      sessionId,
      userQuery,
      "cancellation_policy",
      session.lastOrderId
        ? `Cancellation is usually possible before dispatch/shipment. Since you already shared ${session.lastOrderId}, you can say "cancel my order" and I will check that order.`
        : "You can cancel an order before it is dispatched or shipped. Share your order ID, for example ORD101, and I will check whether cancellation is available.",
      { pendingIntent: "cancel_order", pendingIssueType: "general" }
    );
  }

  if (isSubscriptionOrAccountQuery(userQuery)) {
    return buildDirectInfoResult(
      sessionId,
      userQuery,
      "account_or_subscription_help",
      "I can help with order support in this demo. For subscription, membership, account, billing, plan downgrade, or gift-card refund issues, please share the related account/order details if available. If this action is not supported automatically, I will explain the limitation and suggest the next best step instead of ending the conversation."
    );
  }

  return null;
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
    reason: "Greeting detected. No failure or fallback count required.",
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
        "Hi, welcome to CartGenie AI. I can help you with order tracking, cancellation, returns, refunds, replacement, exchange, delivery, and payment issues. Tell me what you need help with, and share your order ID if you have it.",
      customerMessage:
        "Hi, welcome to CartGenie AI. I can help you with order tracking, cancellation, returns, refunds, replacement, exchange, delivery, and payment issues. Tell me what you need help with, and share your order ID if you have it.",
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

function buildOrderReferenceOnlyResponse(orderId, order) {
  if (!order) {
    return {
      success: true,
      status: "CLARIFICATION_REQUIRED",
      message: `I could not find order ${orderId} in our demo records. Please check the order ID and try again.`,
      customerMessage: `I could not find order ${orderId} in our demo records. Please check the order ID and try again.`,
      internal: {
        decision: "order_reference_only_order_not_found",
        orderId,
      },
    };
  }

  return {
    success: true,
    status: "CLARIFICATION_REQUIRED",
    message: `Thanks for sharing order ${orderId}. I found this order. Please tell me what you would like to do next: track it, cancel it, return it, replace it, or check refund/payment status.`,
    customerMessage: `Thanks for sharing order ${orderId}. I found this order. Please tell me what you would like to do next: track it, cancel it, return it, replace it, or check refund/payment status.`,
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
        "Sure, I can help with that. I am marking this conversation for human support review. If this is related to a specific order, please share the order ID so the support team can check it faster.",
      customerMessage:
        "Sure, I can help with that. I am marking this conversation for human support review. If this is related to a specific order, please share the order ID so the support team can check it faster.",
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
          "I can help you with this, but I still need your order ID to check the correct details. Please share it in a format like ORD101. You can ask about cancellation, return, refund, replacement, exchange, delivery, tracking, or payment issues.",
        customerMessage:
          "I can help you with this, but I still need your order ID to check the correct details. Please share it in a format like ORD101. You can ask about cancellation, return, refund, replacement, exchange, delivery, tracking, or payment issues.",
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
      message: `Sure, I can help you with the ${friendlyIntent} request. Please share your order ID so I can check the latest status and guide you with the correct next step.`,
      customerMessage: `Sure, I can help you with the ${friendlyIntent} request. Please share your order ID so I can check the latest status and guide you with the correct next step.`,
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

  if (attempt >= 2) {
    return {
      success: true,
      status: "CLARIFICATION_REQUIRED",
      message:
        "I want to make sure I guide you correctly. Please share a little more detail about the issue. For example, you can say: cancel ORD101, return ORD103, track ORD102, refund status ORD106, or replace damaged product ORD105.",
      customerMessage:
        "I want to make sure I guide you correctly. Please share a little more detail about the issue. For example, you can say: cancel ORD101, return ORD103, track ORD102, refund status ORD106, or replace damaged product ORD105.",
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
      "I want to help, but I need a little more detail to understand your request correctly. Please tell me what happened and share your order ID if this is related to an order.",
    customerMessage:
      "I want to help, but I need a little more detail to understand your request correctly. Please tell me what happened and share your order ID if this is related to an order.",
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

// ===============================
// MAIN CARTGENIE PIPELINE
// ===============================

async function runCartGeniePipeline(userQuery, options = {}) {
  const sessionId = options.sessionId || "default_session";
  const existingSession = getSession(sessionId);

  if (isGreetingQuery(userQuery)) {
    return buildGreetingResult(sessionId, userQuery);
  }

  const directAnswer = buildDirectAnswerIfMatched(
    sessionId,
    userQuery,
    existingSession
  );

  if (directAnswer) {
    return directAnswer;
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
    const order = findOrder(intentResult.orderId);

    const session = updateSession(sessionId, {
      lastIntent: "order_reference_only",
      lastOrderId: intentResult.orderId || existingSession.lastOrderId,
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
    const nonFailureFallback = isNonFailureFallback(intentResult, confidenceResult);

    let session;

    if (nonFailureFallback) {
      const policyFollowUpIntent = getPolicyFollowUpIntent(
        intentResult.intent || confidenceResult.intent
      );

      session = updateSession(sessionId, {
        lastIntent: intentResult.intent || confidenceResult.intent,
        lastOrderId: intentResult.orderId || existingSession.lastOrderId,
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
      ruleResult: null,
      response: generateFallbackResponse(
        confidenceResult,
        intentResult,
        session
      ),
      escalation: buildFallbackEscalation(confidenceResult),
    };
  }

  const order = findOrder(intentResult.orderId);

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

// ===============================
// ROUTES
// ===============================

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
        "I could not find this order in the demo records. Please check the order ID and try again.",
      customerMessage:
        "I could not find this order in the demo records. Please check the order ID and try again.",
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
      message: "Session not found.",
      customerMessage: "Session not found.",
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

// ===============================
// SERVER START
// ===============================

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