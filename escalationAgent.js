function getPriorityFromTriggers(triggers = []) {
  if (
    triggers.includes("very_high_value_order") ||
    triggers.includes("pan_verification_required")
  ) {
    return "CRITICAL";
  }

  if (
    triggers.includes("payment_conflict") ||
    triggers.includes("refund_dispute") ||
    triggers.includes("smartphone_doa_claim") ||
    triggers.includes("fraud_risk") ||
    triggers.includes("angry_customer") ||
    triggers.includes("abusive_customer")
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

function getAssignedTeam(triggers = [], intent, decision) {
  if (
    triggers.includes("payment_conflict") ||
    triggers.includes("refund_dispute") ||
    intent === "payment_issue" ||
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
    triggers.includes("fraud_risk") ||
    triggers.includes("high_value_order") ||
    triggers.includes("very_high_value_order") ||
    triggers.includes("pan_verification_required")
  ) {
    return "Risk Review Team";
  }

  if (
    intent === "delivery_issue" ||
    intent === "track_order" ||
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
      "Repeated low-confidence handling requires human support."
  };

  return reasonMap[trigger] || "Manual review is required.";
}

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

function shouldEscalate(ruleResult) {
  if (!ruleResult) return false;

  if (ruleResult.requiresEscalation === true) return true;

  const escalationDecisions = [
    "payment_issue_escalate",
    "refund_discrepancy_escalate",
    "replacement_requires_doa_certificate",
    "replacement_requires_brand_verification",
    "replacement_requires_unboxing_proof",
    "delivery_failed_escalate",
    "lost_in_transit_escalate",
    "cancel_requires_escalation",
    "return_requires_escalation",
    "replacement_requires_escalation"
  ];

  return escalationDecisions.includes(ruleResult.decision);
}

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
  handleEscalation
};