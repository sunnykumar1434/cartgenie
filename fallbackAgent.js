// fallbackAgent.js

const REPEATED_FAILURE_LIMIT = 3;

function getAttempt(sessionState = {}) {
  return sessionState.totalFailureCount || 0;
}

function buildUnsafeInputResponse(confidenceResult, intentResult, sessionState) {
  return {
    success: true,
    status: "FALLBACK_REQUIRED",
    customerMessage:
      "I can help with your order request, but I cannot bypass policy checks. Please share the issue clearly and I’ll guide you as per policy.",
    internal: {
      route: confidenceResult.route,
      decision: confidenceResult.decision,
      intent: intentResult.intent,
      confidence: intentResult.confidence,
      riskSignals: confidenceResult.riskSignals || [],
      attempt: getAttempt(sessionState)
    }
  };
}

function buildUnsupportedIntentResponse(confidenceResult, intentResult, sessionState) {
  return {
    success: true,
    status: "FALLBACK_REQUIRED",
    customerMessage:
      "I’m not able to handle this request automatically yet. A support agent may need to review it.",
    internal: {
      route: confidenceResult.route,
      decision: confidenceResult.decision,
      intent: intentResult.intent,
      confidence: intentResult.confidence,
      attempt: getAttempt(sessionState)
    }
  };
}

function buildOffTopicResponse(confidenceResult, intentResult, sessionState) {
  const attempt = getAttempt(sessionState);

  if (attempt >= 2) {
    return {
      success: true,
      status: "OFF_TOPIC_OR_UNCLEAR",
      customerMessage:
        "I’m here to help with order-related support. Please ask about cancellation, return, refund, replacement, exchange, delivery, tracking, or payment issues, and include your order ID if available.",
      internal: {
        route: confidenceResult.route,
        decision: "off_topic_or_unclear_query",
        intent: intentResult.intent,
        confidence: intentResult.confidence,
        attempt
      }
    };
  }

  return {
    success: true,
    status: "OFF_TOPIC_OR_UNCLEAR",
    customerMessage:
      "I’m here to help with order-related support like cancellation, return, refund, replacement, delivery, or payment issues. Please share your order-related query.",
    internal: {
      route: confidenceResult.route,
      decision: "off_topic_or_unclear_query",
      intent: intentResult.intent,
      confidence: intentResult.confidence,
      attempt
    }
  };
}

function buildGenericFallbackResponse(confidenceResult, intentResult, sessionState) {
  const attempt = getAttempt(sessionState);

  if (attempt >= 2) {
    return {
      success: true,
      status: "FALLBACK_REQUIRED",
      customerMessage:
        "I’m still not fully sure about your request. You can ask things like: cancel ORD101, return ORD103, track ORD102, refund status ORD106, or replace damaged product ORD105.",
      internal: {
        route: confidenceResult.route,
        decision: confidenceResult.decision,
        intent: intentResult.intent,
        confidence: intentResult.confidence,
        attempt
      }
    };
  }

  return {
    success: true,
    status: "FALLBACK_REQUIRED",
    customerMessage:
      "I’m not fully sure about your request. Please explain it a little more clearly so I can help.",
    internal: {
      route: confidenceResult.route,
      decision: confidenceResult.decision,
      intent: intentResult.intent,
      confidence: intentResult.confidence,
      attempt
    }
  };
}

function generateFallbackResponse(confidenceResult, intentResult, sessionState = {}) {
  if (!confidenceResult || !intentResult) {
    return {
      success: false,
      status: "FALLBACK_ERROR",
      customerMessage:
        "Sorry, I could not understand this request right now. Please try again with your order ID and issue.",
      internal: {
        reason: "Missing confidenceResult or intentResult in fallbackAgent."
      }
    };
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
      ticketRequired: false
    };
  }

  return {
    ticketRequired: true,
    ticketId: null,
    priority: "MEDIUM",
    assignedTeam: "Safety Review Team",
    sla: "1 business day",
    reason: "Unsafe or unsupported input requires review.",
    riskSignals: confidenceResult.riskSignals || []
  };
}

module.exports = {
  REPEATED_FAILURE_LIMIT,
  generateFallbackResponse,
  buildFallbackEscalation
};