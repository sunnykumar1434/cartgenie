// escalationAgent.js

// ===============================
// PRIORITY LOGIC
// ===============================

function getPriorityFromTriggers(triggers = []) {
  if (
    triggers.includes("very_high_value_order") ||
    triggers.includes("pan_verification_required") ||
    triggers.includes("prompt_injection_detected") ||
    triggers.includes("unsafe_input_detected")
  ) {
    return "CRITICAL";
  }

  if (
    triggers.includes("payment_conflict") ||
    triggers.includes("refund_dispute") ||
    triggers.includes("smartphone_doa_claim") ||
    triggers.includes("fraud_risk") ||
    triggers.includes("angry_customer") ||
    triggers.includes("abusive_customer") ||
    triggers.includes("customer_requested_human_support")
  ) {
    return "HIGH";
  }

  if (
    triggers.includes("brand_verification_required") ||
    triggers.includes("unboxing_proof_required") ||
    triggers.includes("high_value_order") ||
    triggers.includes("missing_product_claim") ||
    triggers.includes("wrong_product_claim") ||
    triggers.includes("policy_conflict") ||
    triggers.includes("order_status_unclear") ||
    triggers.includes("repeated_low_confidence")
  ) {
    return "MEDIUM";
  }

  return "LOW";
}

// ===============================
// TEAM ASSIGNMENT LOGIC
// ===============================

function getAssignedTeam(triggers = [], intent, decision) {
  if (
    triggers.includes("prompt_injection_detected") ||
    triggers.includes("unsafe_input_detected") ||
    triggers.includes("fraud_risk")
  ) {
    return "Safety Review Team";
  }

  if (
    triggers.includes("payment_conflict") ||
    triggers.includes("refund_dispute") ||
    intent === "payment_issue" ||
    intent === "refund_status" ||
    decision === "payment_issue_escalate" ||
    decision === "refund_discrepancy_escalate"
  ) {
    return "Payments Support";
  }

  if (
    triggers.includes("smartphone_doa_claim") ||
    triggers.includes("brand_verification_required") ||
    triggers.includes("unboxing_proof_required") ||
    decision === "replacement_requires_doa_certificate" ||
    decision === "replacement_requires_brand_verification" ||
    decision === "replacement_requires_unboxing_proof"
  ) {
    return "Replacement Verification Team";
  }

  if (
    triggers.includes("very_high_value_order") ||
    triggers.includes("pan_verification_required")
  ) {
    return "Risk Review Team";
  }

  if (
    triggers.includes("angry_customer") ||
    triggers.includes("abusive_customer") ||
    triggers.includes("customer_requested_human_support") ||
    triggers.includes("repeated_low_confidence")
  ) {
    return "Customer Support Escalation Team";
  }

  if (
    intent === "delivery_issue" ||
    decision === "delivery_failed_escalate" ||
    decision === "lost_in_transit_escalate"
  ) {
    return "Logistics Support";
  }

  if (
    intent === "return_order" ||
    decision === "return_requires_escalation" ||
    decision === "return_blocked_quality_check_failed"
  ) {
    return "Returns Support";
  }

  return "General Support";
}

// ===============================
// SLA LOGIC
// ===============================

function getSLA(priority) {
  switch (priority) {
    case "CRITICAL":
      return "1 business hour";

    case "HIGH":
      return "4 business hours";

    case "MEDIUM":
      return "1 business day";

    case "LOW":
      return "2 business days";

    default:
      return "2 business days";
  }
}

// ===============================
// ESCALATION REASON MAPPING
// ===============================

function getEscalationReason(trigger) {
  const reasonMap = {
    very_high_value_order:
      "Very high-value order requires additional verification.",
    high_value_order:
      "High-value order requires additional verification.",
    pan_verification_required:
      "PAN verification is required for this order.",

    payment_conflict:
      "Payment conflict or payment mismatch detected.",
    refund_dispute:
      "Refund dispute or refund mismatch detected.",

    smartphone_doa_claim:
      "Smartphone dead-on-arrival claim requires specialist verification.",
    brand_verification_required:
      "Brand or service-center verification is required.",
    unboxing_proof_required:
      "Unboxing proof is required before approval.",

    fraud_risk:
      "Fraud risk signal detected.",
    prompt_injection_detected:
      "Unsafe prompt-injection or policy-bypass attempt detected.",
    unsafe_input_detected:
      "Unsafe instruction pattern detected.",

    angry_customer:
      "Customer sentiment indicates anger or dissatisfaction.",
    abusive_customer:
      "Abusive or unsafe customer language detected.",

    missing_product_claim:
      "Missing product claim requires manual review.",
    wrong_product_claim:
      "Wrong product claim requires manual review.",

    policy_conflict:
      "Policy conflict requires human review.",
    order_status_unclear:
      "Order status is unclear for automatic decision.",

    repeated_low_confidence:
      "Repeated unclear or unresolved requests require human support.",
    customer_requested_human_support:
      "Customer explicitly requested human support."
  };

  return reasonMap[trigger] || "Manual review is required.";
}

// ===============================
// SAFE SUPPRESSION LOGIC
// Prevent over-escalation for normal informational flows.
// ===============================

function isInformationalDecision(ruleResult = {}) {
  const informationalDecisions = [
    "order_delivered",
    "order_in_transit",
    "order_shipped",
    "order_placed",
    "order_confirmed",
    "order_out_for_delivery",
    "order_not_dispatched",
    "tracking_info_available",
    "delivery_policy_info",
    "refund_policy_info",
    "return_policy_info",
    "replacement_policy_info",
    "cancellation_policy_info"
  ];

  return informationalDecisions.includes(ruleResult.decision);
}

function hasOnlySoftRiskTriggers(triggers = []) {
  if (!Array.isArray(triggers) || triggers.length === 0) return true;

  const hardTriggers = [
    "payment_conflict",
    "refund_dispute",
    "smartphone_doa_claim",
    "brand_verification_required",
    "unboxing_proof_required",
    "fraud_risk",
    "prompt_injection_detected",
    "unsafe_input_detected",
    "angry_customer",
    "abusive_customer",
    "missing_product_claim",
    "wrong_product_claim",
    "policy_conflict",
    "order_status_unclear",
    "repeated_low_confidence",
    "customer_requested_human_support",
    "very_high_value_order",
    "pan_verification_required"
  ];

  return !triggers.some((trigger) => hardTriggers.includes(trigger));
}

function shouldSuppressEscalation(ruleResult = {}) {
  const triggers = ruleResult.escalationTriggers || [];

  // Normal tracking or delivered-status responses should not create tickets
  // only because the order value is high.
  if (
    ruleResult.intent === "track_order" &&
    isInformationalDecision(ruleResult) &&
    hasOnlySoftRiskTriggers(triggers)
  ) {
    return true;
  }

  // Approved informational decisions should not escalate unless a hard risk exists.
  if (
    ruleResult.allowed === true &&
    isInformationalDecision(ruleResult) &&
    hasOnlySoftRiskTriggers(triggers)
  ) {
    return true;
  }

  return false;
}

// ===============================
// TICKET HELPERS
// ===============================

function buildTicketTitle(ruleResult, priority, assignedTeam) {
  const orderId = ruleResult.orderId || "UNKNOWN_ORDER";
  const decision = ruleResult.decision || "unknown_decision";

  return `[${priority}] ${assignedTeam} review required for ${orderId} - ${decision}`;
}

function buildCustomerEscalationMessage(ticket) {
  if (!ticket.ticketRequired) {
    return "";
  }

  return `Your case has been escalated to ${ticket.assignedTeam}. Priority: ${ticket.priority}. Expected review time: ${ticket.sla}. Ticket ID: ${ticket.ticketId}.`;
}

function generateTicketId(orderId) {
  const randomPart = Math.floor(100000 + Math.random() * 900000);
  const cleanOrderId = orderId || "NOORDER";
  return `CG-${cleanOrderId}-${randomPart}`;
}

// ===============================
// MAIN ESCALATION DECISION
// ===============================

function shouldEscalate(ruleResult) {
  if (!ruleResult) return false;

  if (shouldSuppressEscalation(ruleResult)) {
    return false;
  }

  if (ruleResult.requiresEscalation === true) {
    return true;
  }

  const escalationDecisions = [
    "payment_issue_escalate",
    "refund_discrepancy_escalate",

    "replacement_requires_doa_certificate",
    "replacement_requires_brand_verification",
    "replacement_requires_unboxing_proof",
    "replacement_requires_escalation",

    "delivery_failed_escalate",
    "lost_in_transit_escalate",

    "cancel_requires_escalation",
    "return_requires_escalation",
    "return_blocked_quality_check_failed",

    "unsafe_input_detected",
    "prompt_injection_detected",
    "customer_requested_human_support",
    "repeated_low_confidence"
  ];

  return escalationDecisions.includes(ruleResult.decision);
}

// ===============================
// MAIN HANDLER
// ===============================

function handleEscalation(ruleResult, context = {}) {
  if (!shouldEscalate(ruleResult)) {
    return {
      ticketRequired: false,
      ticketId: null,
      priority: null,
      assignedTeam: null,
      sla: null,
      title: null,
      reasons: [],
      customerMessage: "",
      internalNotes: "No escalation required.",
      escalationTriggers: ruleResult?.escalationTriggers || []
    };
  }

  const triggers = [...new Set(ruleResult.escalationTriggers || [])];

  const priority = getPriorityFromTriggers(triggers);
  const assignedTeam = getAssignedTeam(
    triggers,
    ruleResult.intent,
    ruleResult.decision
  );
  const sla = getSLA(priority);
  const ticketId = generateTicketId(ruleResult.orderId);

  const reasons =
    triggers.length > 0
      ? triggers.map((trigger) => ({
          trigger,
          reason: getEscalationReason(trigger)
        }))
      : [
          {
            trigger: "manual_review",
            reason: "Manual review is required for this decision."
          }
        ];

  const ticket = {
    ticketRequired: true,
    ticketId,
    priority,
    assignedTeam,
    sla,
    title: buildTicketTitle(ruleResult, priority, assignedTeam),

    orderId: ruleResult.orderId || null,
    intent: ruleResult.intent || null,
    decision: ruleResult.decision || null,

    allowedByPolicy: ruleResult.allowed,
    refundRequired: ruleResult.refundRequired || false,
    nextAction: ruleResult.nextAction || null,

    reasons,
    escalationTriggers: triggers,

    customerMessage: "",

    internalNotes: {
      rawReason: ruleResult.reason || null,
      customerTone: context.customerTone || "neutral",
      query: context.query || null,
      source: context.source || "cartgenie_backend",
      createdAt: new Date().toISOString()
    }
  };

  ticket.customerMessage = buildCustomerEscalationMessage(ticket);

  return ticket;
}

module.exports = {
  handleEscalation,

  _internal: {
    getPriorityFromTriggers,
    getAssignedTeam,
    getSLA,
    getEscalationReason,
    shouldEscalate,
    shouldSuppressEscalation,
    isInformationalDecision,
    hasOnlySoftRiskTriggers,
    generateTicketId
  }
};