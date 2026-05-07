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
  buildFallbackEscalation
} = require("./fallbackAgent");

const {
  logAuditEvent,
  logErrorEvent,
  readRecentAuditLogs,
  readRecentErrorLogs
} = require("./auditLogger");

const app = express();

const PORT = process.env.PORT || 5001;

// =====================================================
// SESSION STORE
// Tracks repeated fallback/clarification failures.
// In production, move this to Redis/MongoDB.
// =====================================================

const sessionStore = {};
const REPEATED_FAILURE_LIMIT = 3;

function getSession(sessionId = "default_session") {
  if (!sessionStore[sessionId]) {
    sessionStore[sessionId] = {
      sessionId,
      fallbackCount: 0,
      clarificationCount: 0,
      totalFailureCount: 0,
      lastIntent: null,
      lastOrderId: null,
      lastStage: null,
      lastQuery: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
  }

  return sessionStore[sessionId];
}

function updateSession(sessionId, updates = {}) {
  const session = getSession(sessionId);

  Object.assign(session, updates, {
    updatedAt: new Date().toISOString()
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

  session.lastIntent = intentResult?.intent || null;
  session.lastOrderId = intentResult?.orderId || null;
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
  session.lastIntent = intentResult?.intent || null;
  session.lastOrderId = intentResult?.orderId || null;
  session.lastStage = "completed";
  session.lastQuery = userQuery;
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
    ruleResult: null,
    response: {
      success: true,
      status: "ESCALATION_REQUIRED",
      message:
        "I’m sorry this hasn’t been resolved yet. I’m moving this to a support specialist so your concern can be reviewed properly. If this is related to an order, please keep your order ID ready.",
      customerMessage:
        "I’m sorry this hasn’t been resolved yet. I’m moving this to a support specialist so your concern can be reviewed properly. If this is related to an order, please keep your order ID ready.",
      internal: {
        reason: "Repeated fallback or clarification failure.",
        failureLimit: REPEATED_FAILURE_LIMIT,
        fallbackCount: session.fallbackCount,
        clarificationCount: session.clarificationCount,
        totalFailureCount: session.totalFailureCount
      }
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
            "Repeated fallback or clarification responses reached the escalation limit."
        }
      ],
      escalationTriggers: ["repeated_low_confidence"],
      customerMessage: `Your case has been escalated to General Support. Expected review time: 1 business day. Ticket ID: ${ticketId}.`,
      internalNotes: {
        lastQuery: userQuery,
        lastIntent: intentResult?.intent || null,
        lastDecision: confidenceResult?.decision || null,
        createdAt: new Date().toISOString()
      }
    }
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

function findOrder(orderId) {
  if (!orderId) return null;

  const normalizedOrderId = String(orderId).trim().toUpperCase();

  return (
    orders.find(
      (order) => String(order.orderId).trim().toUpperCase() === normalizedOrderId
    ) || null
  );
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
    wrong_item: "wrong item",
    missing_item: "missing item"
  };

  return intentMap[intent] || "order-related";
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
          attempt
        }
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
        attempt
      }
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
        attempt
      }
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
      attempt
    }
  };
}

// ===============================
// MAIN CARTGENIE PIPELINE
// ===============================

async function runCartGeniePipeline(userQuery, options = {}) {
  const sessionId = options.sessionId || "default_session";

  const intentResult = await detectIntentAndEntities(userQuery);

  const confidenceResult = evaluateConfidence(intentResult, {
    query: userQuery
  });

  updateSession(sessionId, {
    lastIntent: intentResult.intent,
    lastOrderId: intentResult.orderId,
    lastQuery: userQuery
  });

  if (confidenceResult.route === "clarification") {
    const session = registerFailure(
      sessionId,
      "clarification",
      intentResult,
      userQuery
    );

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
      sessionState: session,
      intentResult,
      confidenceResult,
      orderFound: false,
      ruleResult: null,
      response: buildClarificationResponse(
        confidenceResult,
        intentResult,
        session
      ),
      escalation: {
        ticketRequired: false
      }
    };
  }

  if (confidenceResult.route === "fallback_llm") {
    const session = registerFailure(
      sessionId,
      "fallback",
      intentResult,
      userQuery
    );

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
      stage: "fallback",
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
      escalation: buildFallbackEscalation(confidenceResult)
    };
  }

  const order = findOrder(intentResult.orderId);

  const ruleResult = applyRules({
    intent: intentResult.intent,
    order,
    issueType: intentResult.issueType
  });

  if (confidenceResult.requiresEscalation) {
    ruleResult.requiresEscalation = true;
    ruleResult.escalationTriggers = [
      ...(ruleResult.escalationTriggers || []),
      ...(confidenceResult.riskSignals || [])
    ];
    ruleResult.escalationTriggers = [...new Set(ruleResult.escalationTriggers)];
  }

  const response = generateResponse(ruleResult);

  const escalation = handleEscalation(ruleResult, {
    query: userQuery,
    customerTone: confidenceResult.riskSignals.includes("angry_customer")
      ? "angry"
      : "neutral",
    source: "api"
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
    orderSummary: order
      ? {
          orderId: order.orderId,
          status: order.status,
          category: order.category,
          paymentMethod: order.paymentMethod,
          paymentStatus: order.paymentStatus,
          orderValue: order.orderValue
        }
      : null,
    ruleResult,
    response,
    escalation
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
      "Order Lookup",
      "Rule Engine",
      "Fallback Agent",
      "Response Agent",
      "Escalation Agent",
      "Audit Logger",
      "Session-Based Repeated Failure Escalation"
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
      errorLogs: "GET /api/error-logs"
    }
  });
});

app.get("/health", (req, res) => {
  res.json({
    success: true,
    status: "OK",
    service: "cartgenie-backend",
    port: PORT,
    timestamp: new Date().toISOString()
  });
});

app.get("/api/orders", (req, res) => {
  res.json({
    success: true,
    count: orders.length,
    orders
  });
});

app.get("/api/orders/:orderId", (req, res) => {
  const orderId = String(req.params.orderId || "").toUpperCase();
  const order = findOrder(orderId);

  if (!order) {
    return res.status(404).json({
      success: false,
      message:
        "I couldn’t find this order in the demo records. Please check the order ID and try again.",
      orderId
    });
  }

  return res.json({
    success: true,
    order
  });
});

app.get("/api/sessions", (req, res) => {
  res.json({
    success: true,
    count: Object.keys(sessionStore).length,
    sessions: sessionStore
  });
});

app.get("/api/sessions/:sessionId", (req, res) => {
  const sessionId = req.params.sessionId;
  const session = sessionStore[sessionId];

  if (!session) {
    return res.status(404).json({
      success: false,
      message: "Session not found.",
      sessionId
    });
  }

  return res.json({
    success: true,
    session
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
    sessionId
  });
});

app.get("/api/audit-logs", (req, res) => {
  const limit = Number(req.query.limit) || 20;

  res.json({
    success: true,
    count: limit,
    logs: readRecentAuditLogs(limit)
  });
});

app.get("/api/error-logs", (req, res) => {
  const limit = Number(req.query.limit) || 20;

  res.json({
    success: true,
    count: limit,
    logs: readRecentErrorLogs(limit)
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
          query: "Cancel my order ORD101"
        }
      });
    }

    const safeSessionId =
      typeof sessionId === "string" && sessionId.trim().length > 0
        ? sessionId.trim()
        : "default_session";

    const result = await runCartGeniePipeline(query.trim(), {
      sessionId: safeSessionId
    });

    logAuditEvent({
      ...result,
      requestId: req.headers["x-request-id"] || null,
      sessionId: safeSessionId
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
      source: "POST /api/support"
    });

    return res.status(500).json({
      success: false,
      status: "SERVER_ERROR",
      message:
        "Sorry, something went wrong while processing your request. Please try again in a moment.",
      customerMessage:
        "Sorry, something went wrong while processing your request. Please try again in a moment.",
      error: process.env.NODE_ENV === "production" ? undefined : error.message
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
  sessionStore
};