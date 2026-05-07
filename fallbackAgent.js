// fallbackAgent.js

const REPEATED_FAILURE_LIMIT = 3;

function getAttempt(sessionState = {}) {
  return sessionState.totalFailureCount || 0;
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

function buildUnsafeInputResponse(confidenceResult, intentResult, sessionState) {
  return {
    success: true,
    status: "FALLBACK_REQUIRED",
    customerMessage:
      "I can help with your order-related concern, but I can’t bypass policy checks or ignore safety rules. Please share your issue clearly, along with your order ID if available, and I’ll guide you with the safest next step.",
    internal: safeInternal(confidenceResult, intentResult, sessionState, {
      fallbackType: "unsafe_input",
    }),
  };
}

function buildUnsupportedIntentResponse(confidenceResult, intentResult, sessionState) {
  const attempt = getAttempt(sessionState);

  if (attempt >= 2) {
    return {
      success: true,
      status: "FALLBACK_REQUIRED",
      customerMessage:
        "I may not be able to complete this request automatically, but I can still help with order support. Please ask about cancellation, return, refund, replacement, exchange, delivery, tracking, or payment issues. If this is related to an order, please include your order ID so I can check it properly.",
      internal: safeInternal(confidenceResult, intentResult, sessionState, {
        fallbackType: "unsupported_intent_repeated",
      }),
    };
  }

  return {
    success: true,
    status: "FALLBACK_REQUIRED",
    customerMessage:
      "I’m not able to handle this request automatically yet. I can help with order-related support such as cancellation, returns, refunds, replacement, exchange, delivery, tracking, and payment issues. Please share your order concern and I’ll guide you from there.",
    internal: safeInternal(confidenceResult, intentResult, sessionState, {
      fallbackType: "unsupported_intent",
    }),
  };
}

function buildOffTopicResponse(confidenceResult, intentResult, sessionState) {
  const attempt = getAttempt(sessionState);

  if (attempt >= 2) {
    return {
      success: true,
      status: "OFF_TOPIC_OR_UNCLEAR",
      customerMessage:
        "I’m here to help with order-related support, and I want to make sure I guide you correctly. You can ask things like “cancel my order”, “return my product”, “track my order”, “refund not received”, or “replace damaged product”. Please include your order ID if you have it.",
      internal: safeInternal(confidenceResult, intentResult, sessionState, {
        decision: "off_topic_or_unclear_query",
        fallbackType: "off_topic_repeated",
      }),
    };
  }

  return {
    success: true,
    status: "OFF_TOPIC_OR_UNCLEAR",
    customerMessage:
      "I’m here to help with order-related support such as cancellation, returns, refunds, replacement, delivery, tracking, and payment issues. Please share your order concern, and I’ll help you with the next step.",
    internal: safeInternal(confidenceResult, intentResult, sessionState, {
      decision: "off_topic_or_unclear_query",
      fallbackType: "off_topic",
    }),
  };
}

function buildGenericFallbackResponse(confidenceResult, intentResult, sessionState) {
  const attempt = getAttempt(sessionState);

  if (attempt >= 2) {
    return {
      success: true,
      status: "FALLBACK_REQUIRED",
      customerMessage:
        "I’m still not fully sure what you need help with. To help you faster, please share your order ID and the issue. For example, you can say: “cancel ORD101”, “return ORD103”, “track ORD102”, “refund status ORD106”, or “replace damaged product ORD105”.",
      internal: safeInternal(confidenceResult, intentResult, sessionState, {
        fallbackType: "generic_repeated",
      }),
    };
  }

  return {
    success: true,
    status: "FALLBACK_REQUIRED",
    customerMessage:
      "I want to help, but I need a little more detail to understand your request correctly. Please tell me what happened and share your order ID if this is related to an order.",
    internal: safeInternal(confidenceResult, intentResult, sessionState, {
      fallbackType: "generic",
    }),
  };
}

function buildMissingFallbackInputResponse() {
  return {
    success: false,
    status: "FALLBACK_ERROR",
    customerMessage:
      "Sorry, I couldn’t understand this request right now. Please try again with your order ID and a short description of the issue.",
    internal: {
      reason: "Missing confidenceResult or intentResult in fallbackAgent.",
    },
  };
}

function generateFallbackResponse(confidenceResult, intentResult, sessionState = {}) {
  if (!confidenceResult || !intentResult) {
    return buildMissingFallbackInputResponse();
  }

  if (confidenceResult.decision === "unsafe_input_detected") {
    return buildUnsafeInputResponse(confidenceResult, intentResult, sessionState);
  }

  if (confidenceResult.decision === "unsupported_intent") {
    return buildUnsupportedIntentResponse(
      confidenceResult,
      intentResult,
      sessionState
    );
  }

  if (
    intentResult.intent === "general_support" &&
    confidenceResult.decision === "low_confidence"
  ) {
    return buildOffTopicResponse(confidenceResult, intentResult, sessionState);
  }

  return buildGenericFallbackResponse(
    confidenceResult,
    intentResult,
    sessionState
  );
}

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

  if (riskSignals.includes("angry_customer")) {
    assignedTeam = "Customer Support Escalation Team";
    priority = "HIGH";
    sla = "4 business hours";
    reason = "Customer tone indicates frustration and may need careful human handling.";
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
      "I’m marking this for support review so the right team can check it carefully.",
  };
}

module.exports = {
  REPEATED_FAILURE_LIMIT,
  generateFallbackResponse,
  buildFallbackEscalation,
};