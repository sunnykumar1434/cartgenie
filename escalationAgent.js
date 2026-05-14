"use strict";

/**
 * escalationAgent.js
 *
 * Handles support escalation decisions for CartGenie.
 *
 * Used by app.js:
 * const { handleEscalation } = require("./escalationAgent");
 *
 * Main goals:
 * - Generate clean escalation metadata.
 * - Escalate risky cases: human support, payment issue, lost shipment,
 *   angry customer, damaged/wrong/missing item, unclear manual review.
 * - Avoid duplicate/confusing escalation messages.
 * - Keep demo-safe behavior for presentation.
 */

// =====================================================
// HELPERS
// =====================================================

function normalizeText(value = "") {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_");
}

function normalizeLooseText(value = "") {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function safeString(value, fallback = null) {
  if (value === undefined || value === null) return fallback;
  const clean = String(value).trim();
  return clean || fallback;
}

function getOrderId(ruleResult = {}) {
  return (
    safeString(ruleResult.orderId) ||
    safeString(ruleResult.order?.orderId) ||
    null
  );
}

function getIntent(ruleResult = {}) {
  return safeString(ruleResult.intent, "general_support");
}

function getIssueType(ruleResult = {}) {
  return safeString(ruleResult.issueType, "general");
}

function getDecision(ruleResult = {}) {
  return safeString(ruleResult.decision, "unknown");
}

function getStatus(ruleResult = {}) {
  return (
    safeString(ruleResult.status) ||
    safeString(ruleResult.orderStatus) ||
    safeString(ruleResult.order?.status) ||
    "UNKNOWN"
  );
}

function generateTicketId(prefix = "CG") {
  const timePart = Date.now().toString(36).toUpperCase();
  const randomPart = Math.floor(100000 + Math.random() * 900000);
  return `${prefix}-${timePart}-${randomPart}`;
}

function uniqueArray(values = []) {
  return Array.from(
    new Set(
      values
        .filter(Boolean)
        .map((value) => String(value).trim())
        .filter(Boolean)
    )
  );
}

function includesAny(text = "", patterns = []) {
  const clean = normalizeLooseText(text);

  return patterns.some((pattern) =>
    clean.includes(normalizeLooseText(pattern))
  );
}

// =====================================================
// PRIORITY / TEAM LOGIC
// =====================================================

function detectTriggers(ruleResult = {}, context = {}) {
  const intent = getIntent(ruleResult);
  const issueType = getIssueType(ruleResult);
  const decision = getDecision(ruleResult);
  const status = normalizeText(getStatus(ruleResult));
  const query = context.query || "";

  const existingTriggers = ruleResult.escalationTriggers || [];
  const triggers = [...existingTriggers];

  if (ruleResult.requiresEscalation) {
    triggers.push("rule_engine_escalation_required");
  }

  if (intent === "human_support") {
    triggers.push("customer_requested_human_support");
  }

  if (
    includesAny(query, [
      "connect me to human",
      "human support",
      "human agent",
      "talk to human",
      "real person",
      "customer care",
      "raise ticket",
      "create ticket",
      "escalate",
    ])
  ) {
    triggers.push("customer_requested_human_support");
  }

  if (
    intent === "payment_issue" ||
    issueType === "payment" ||
    issueType === "charged_twice" ||
    issueType === "payment_deducted_order_not_created" ||
    includesAny(query, [
      "charged twice",
      "double charged",
      "money deducted",
      "amount deducted",
      "paid but order not placed",
      "payment successful but order not placed",
    ])
  ) {
    triggers.push("payment_issue");
  }

  if (
    intent === "missing_item" ||
    issueType === "missing_item" ||
    includesAny(query, ["missing item", "item missing", "product missing"])
  ) {
    triggers.push("missing_item");
  }

  if (
    intent === "wrong_item" ||
    issueType === "wrong_item" ||
    includesAny(query, ["wrong item", "wrong product", "different product"])
  ) {
    triggers.push("wrong_item");
  }

  if (
    intent === "damaged_item" ||
    issueType === "damaged_item" ||
    includesAny(query, ["damaged", "broken", "defective", "not working"])
  ) {
    triggers.push("damaged_item");
  }

  if (
    decision.includes("lost") ||
    status.includes("lost") ||
    includesAny(query, ["lost in transit", "lost order"])
  ) {
    triggers.push("lost_in_transit");
  }

  if (
    decision.includes("delay") ||
    status.includes("delayed") ||
    includesAny(query, ["delayed", "late delivery", "delay"])
  ) {
    triggers.push("delivery_delay");
  }

  if (
    decision.includes("manual_review") ||
    decision.includes("support_review") ||
    status.includes("manual_review")
  ) {
    triggers.push("manual_review_required");
  }

  if (
    context.customerTone === "angry" ||
    includesAny(query, [
      "angry",
      "frustrated",
      "upset",
      "dumb",
      "stupid",
      "shit",
      "useless",
      "get lost",
    ])
  ) {
    triggers.push("angry_customer");
  }

  if (
    includesAny(query, [
      "ignore previous instructions",
      "bypass policy",
      "admin access",
      "delete logs",
      "system prompt",
      "api key",
      "secret",
    ])
  ) {
    triggers.push("unsafe_request");
  }

  return uniqueArray(triggers);
}

function getPriority(triggers = [], ruleResult = {}, context = {}) {
  const highPriorityTriggers = [
    "payment_issue",
    "lost_in_transit",
    "missing_item",
    "wrong_item",
    "damaged_item",
    "angry_customer",
    "unsafe_request",
    "customer_requested_human_support",
  ];

  if (triggers.some((trigger) => highPriorityTriggers.includes(trigger))) {
    return "HIGH";
  }

  if (
    triggers.includes("delivery_delay") ||
    triggers.includes("manual_review_required")
  ) {
    return "MEDIUM";
  }

  if (ruleResult.priority) return ruleResult.priority;

  if (context.customerTone === "angry") return "HIGH";

  return "MEDIUM";
}

function getAssignedTeam(triggers = [], ruleResult = {}) {
  const intent = getIntent(ruleResult);
  const issueType = getIssueType(ruleResult);

  if (
    triggers.includes("payment_issue") ||
    intent === "payment_issue" ||
    issueType.includes("payment")
  ) {
    return "Payments Support Team";
  }

  if (
    triggers.includes("lost_in_transit") ||
    triggers.includes("delivery_delay")
  ) {
    return "Logistics Support Team";
  }

  if (
    triggers.includes("missing_item") ||
    triggers.includes("wrong_item") ||
    triggers.includes("damaged_item")
  ) {
    return "Returns & Quality Support Team";
  }

  if (
    triggers.includes("angry_customer") ||
    triggers.includes("customer_requested_human_support")
  ) {
    return "Customer Support Escalation Team";
  }

  if (triggers.includes("unsafe_request")) {
    return "Trust & Safety Review";
  }

  return "General Support";
}

function getSla(priority = "MEDIUM", triggers = []) {
  if (triggers.includes("unsafe_request")) {
    return "Immediate review";
  }

  if (priority === "HIGH") {
    return "4 business hours";
  }

  if (priority === "MEDIUM") {
    return "1 business day";
  }

  return "2 business days";
}

function getReason(triggers = [], ruleResult = {}, context = {}) {
  const orderId = getOrderId(ruleResult);
  const orderText = orderId ? ` for order ${orderId}` : "";

  if (triggers.includes("customer_requested_human_support")) {
    return `Customer requested human support${orderText}.`;
  }

  if (triggers.includes("payment_issue")) {
    return `Payment issue requires secure support review${orderText}.`;
  }

  if (triggers.includes("lost_in_transit")) {
    return `Shipment may be lost in transit and needs logistics review${orderText}.`;
  }

  if (triggers.includes("delivery_delay")) {
    return `Delivery appears delayed and may need logistics follow-up${orderText}.`;
  }

  if (triggers.includes("missing_item")) {
    return `Missing item issue needs support validation${orderText}.`;
  }

  if (triggers.includes("wrong_item")) {
    return `Wrong item issue needs support validation${orderText}.`;
  }

  if (triggers.includes("damaged_item")) {
    return `Damaged/defective item issue needs support validation${orderText}.`;
  }

  if (triggers.includes("angry_customer")) {
    return `Customer appears frustrated and should be handled carefully${orderText}.`;
  }

  if (triggers.includes("unsafe_request")) {
    return "Unsafe or policy-bypass request detected.";
  }

  if (triggers.includes("manual_review_required")) {
    return `Manual support review is required${orderText}.`;
  }

  return (
    ruleResult.reason ||
    `Support review may be required${orderText}.`
  );
}

function shouldEscalate(ruleResult = {}, context = {}) {
  const triggers = detectTriggers(ruleResult, context);

  if (ruleResult.requiresEscalation) return true;

  if (triggers.length > 0) {
    const strongTriggers = [
      "customer_requested_human_support",
      "payment_issue",
      "lost_in_transit",
      "missing_item",
      "wrong_item",
      "damaged_item",
      "angry_customer",
      "unsafe_request",
      "manual_review_required",
    ];

    return triggers.some((trigger) => strongTriggers.includes(trigger));
  }

  return false;
}

// =====================================================
// MAIN HANDLER
// =====================================================

function handleEscalation(ruleResult = {}, context = {}) {
  const triggers = detectTriggers(ruleResult, context);
  const escalationRequired = shouldEscalate(ruleResult, context);

  if (!escalationRequired) {
    return {
      ticketRequired: false,
      ticketId: null,
      assignedTeam: null,
      priority: null,
      sla: null,
      reason: null,
      escalationTriggers: [],
    };
  }

  const priority = getPriority(triggers, ruleResult, context);
  const assignedTeam = getAssignedTeam(triggers, ruleResult);
  const sla = getSla(priority, triggers);
  const reason = getReason(triggers, ruleResult, context);

  const ticketPrefix =
    assignedTeam === "Payments Support Team"
      ? "CG-PAY"
      : assignedTeam === "Logistics Support Team"
      ? "CG-LOG"
      : assignedTeam === "Returns & Quality Support Team"
      ? "CG-RQA"
      : assignedTeam === "Trust & Safety Review"
      ? "CG-SAFE"
      : "CG-SUP";

  return {
    ticketRequired: true,
    ticketId: generateTicketId(ticketPrefix),
    assignedTeam,
    priority,
    sla,
    reason,
    escalationTriggers: triggers,
  };
}

// =====================================================
// CUSTOMER MESSAGE HELPER
// =====================================================

function buildEscalationCustomerMessage(escalation = {}, ruleResult = {}) {
  if (!escalation || !escalation.ticketRequired) {
    return null;
  }

  const orderId = getOrderId(ruleResult);
  const orderText = orderId ? ` for order ${orderId}` : "";

  return `I’ll mark this${orderText} for ${escalation.assignedTeam} review. Ticket ID: ${escalation.ticketId}. Expected SLA: ${escalation.sla}.`;
}

// =====================================================
// COMPATIBILITY ALIASES
// =====================================================

function createEscalation(ruleResult = {}, context = {}) {
  return handleEscalation(ruleResult, context);
}

function evaluateEscalation(ruleResult = {}, context = {}) {
  return handleEscalation(ruleResult, context);
}

function escalationAgent(ruleResult = {}, context = {}) {
  return handleEscalation(ruleResult, context);
}

module.exports = {
  handleEscalation,
  createEscalation,
  evaluateEscalation,
  escalationAgent,

  buildEscalationCustomerMessage,

  detectTriggers,
  shouldEscalate,
  getPriority,
  getAssignedTeam,
  getSla,
  getReason,
};