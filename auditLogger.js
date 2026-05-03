// auditLogger.js

const fs = require("fs");
const path = require("path");

const LOG_DIR = path.join(__dirname, "logs");
const AUDIT_LOG_FILE = path.join(LOG_DIR, "audit.log");
const ERROR_LOG_FILE = path.join(LOG_DIR, "error.log");

function ensureLogDirectory() {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
}

function safeStringify(data) {
  try {
    return JSON.stringify(data);
  } catch (error) {
    return JSON.stringify({
      error: "Failed to stringify log data",
      message: error.message
    });
  }
}

function sanitizeForAudit(data = {}) {
  return {
    timestamp: new Date().toISOString(),
    requestId: data.requestId || null,
    sessionId: data.sessionId || null,
    query: data.query || null,

    stage: data.stage || null,

    intent: data.intentResult?.intent || null,
    confidence: data.intentResult?.confidence || null,
    intentSource: data.intentResult?.source || null,
    orderId: data.intentResult?.orderId || null,
    issueType: data.intentResult?.issueType || null,

    confidenceRoute: data.confidenceResult?.route || null,
    confidenceDecision: data.confidenceResult?.decision || null,
    riskSignals: data.confidenceResult?.riskSignals || [],

    orderFound: data.orderFound || false,

    ruleDecision: data.ruleResult?.decision || null,
    ruleAllowed: data.ruleResult?.allowed ?? null,
    refundRequired: data.ruleResult?.refundRequired ?? null,
    ruleRequiresEscalation: data.ruleResult?.requiresEscalation ?? null,
    ruleEscalationTriggers: data.ruleResult?.escalationTriggers || [],

    responseStatus: data.response?.status || null,
    customerMessage: data.response?.customerMessage || null,

    ticketRequired: data.escalation?.ticketRequired || false,
    ticketId: data.escalation?.ticketId || null,
    assignedTeam: data.escalation?.assignedTeam || null,
    priority: data.escalation?.priority || null,
    sla: data.escalation?.sla || null,

    sessionState: data.sessionState
      ? {
          fallbackCount: data.sessionState.fallbackCount,
          clarificationCount: data.sessionState.clarificationCount,
          totalFailureCount: data.sessionState.totalFailureCount,
          lastIntent: data.sessionState.lastIntent,
          lastOrderId: data.sessionState.lastOrderId,
          lastStage: data.sessionState.lastStage
        }
      : null
  };
}

function logAuditEvent(eventData = {}) {
  try {
    ensureLogDirectory();

    const cleanLog = sanitizeForAudit(eventData);
    const logLine = safeStringify(cleanLog) + "\n";

    fs.appendFileSync(AUDIT_LOG_FILE, logLine, "utf8");

    return {
      success: true,
      file: AUDIT_LOG_FILE
    };
  } catch (error) {
    console.error("Audit logging failed:", error.message);

    return {
      success: false,
      error: error.message
    };
  }
}

function logErrorEvent(errorData = {}) {
  try {
    ensureLogDirectory();

    const logLine =
      safeStringify({
        timestamp: new Date().toISOString(),
        requestId: errorData.requestId || null,
        sessionId: errorData.sessionId || null,
        query: errorData.query || null,
        message: errorData.message || null,
        stack: errorData.stack || null,
        source: errorData.source || "cartgenie_backend"
      }) + "\n";

    fs.appendFileSync(ERROR_LOG_FILE, logLine, "utf8");

    return {
      success: true,
      file: ERROR_LOG_FILE
    };
  } catch (error) {
    console.error("Error logging failed:", error.message);

    return {
      success: false,
      error: error.message
    };
  }
}

function readRecentAuditLogs(limit = 20) {
  try {
    ensureLogDirectory();

    if (!fs.existsSync(AUDIT_LOG_FILE)) {
      return [];
    }

    const content = fs.readFileSync(AUDIT_LOG_FILE, "utf8").trim();

    if (!content) {
      return [];
    }

    return content
      .split("\n")
      .slice(-limit)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return {
            parseError: true,
            raw: line
          };
        }
      });
  } catch (error) {
    return [
      {
        error: "Failed to read audit logs",
        message: error.message
      }
    ];
  }
}

function readRecentErrorLogs(limit = 20) {
  try {
    ensureLogDirectory();

    if (!fs.existsSync(ERROR_LOG_FILE)) {
      return [];
    }

    const content = fs.readFileSync(ERROR_LOG_FILE, "utf8").trim();

    if (!content) {
      return [];
    }

    return content
      .split("\n")
      .slice(-limit)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return {
            parseError: true,
            raw: line
          };
        }
      });
  } catch (error) {
    return [
      {
        error: "Failed to read error logs",
        message: error.message
      }
    ];
  }
}

module.exports = {
  logAuditEvent,
  logErrorEvent,
  readRecentAuditLogs,
  readRecentErrorLogs
};