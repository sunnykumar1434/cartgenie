const rules = require("./rules.json");

// ===============================
// HELPERS
// ===============================

function normalize(value = "") {
  return String(value || "").trim().toLowerCase();
}

function normalizeStatus(status = "") {
  const s = normalize(status);

  const aliases = {
    canceled: "cancelled",
    packed: "processing",
    rto: "returned_to_origin",
    return_to_origin: "returned_to_origin",
    returned_origin: "returned_to_origin",
    ofd: "out_for_delivery",
    delivered_success: "delivered"
  };

  return aliases[s] || s;
}

function normalizePaymentStatus(status = "") {
  const s = normalize(status);

  const aliases = {
    success: "paid",
    successful: "paid",
    completed: "paid",
    captured: "paid",
    deducted: "payment_pending_but_debited",
    deducted_but_failed: "payment_pending_but_debited",
    pending_but_debited: "payment_pending_but_debited"
  };

  return aliases[s] || s;
}

function normalizePaymentMethod(method = "") {
  const m = normalize(method);

  const aliases = {
    credit_card: "card",
    debit_card: "card",
    cards: "card",
    cash_on_delivery: "cod",
    cash: "cod",
    paylater: "pay_later",
    net_banking: "netbanking"
  };

  return aliases[m] || m;
}

function getOrderValue(order = {}) {
  return Number(order.orderValue || order.amount || order.value || 0);
}

function isPrepaid(order) {
  return ["upi", "card", "netbanking", "wallet", "pay_later", "emi"].includes(
    normalizePaymentMethod(order.paymentMethod || order.paymentMode)
  );
}

function isPaid(order) {
  return ["paid", "success"].includes(
    normalizePaymentStatus(order.paymentStatus)
  );
}

function hasPaymentConflict(order) {
  const paymentStatuses = rules.payment?.paymentConflictStatuses || [
    "failed",
    "double_charged",
    "refund_failed",
    "refund_not_received",
    "payment_pending_but_debited"
  ];

  return paymentStatuses.includes(normalizePaymentStatus(order.paymentStatus));
}

function isHighValue(order) {
  return getOrderValue(order) >= Number(rules.thresholds?.highValueOrder || 50000);
}

function isVeryHighValue(order) {
  return (
    getOrderValue(order) >= Number(rules.thresholds?.veryHighValueOrder || 200000)
  );
}

function isInsideWindow(daysAgo, windowDays) {
  if (typeof daysAgo !== "number") return false;
  return daysAgo <= windowDays;
}

function createResult({
  intent,
  order,
  decision,
  allowed,
  reason,
  refundRequired = false,
  requiresEscalation = false,
  escalationTriggers = [],
  nextAction = null,
  extra = {}
}) {
  return {
    intent,
    orderId: order ? order.orderId : null,
    decision,
    allowed,
    reason,
    refundRequired,
    requiresEscalation,
    escalationTriggers: [...new Set(escalationTriggers || [])],
    nextAction,
    ...extra
  };
}

function shouldApplyValueEscalation(intent, decision) {
  const informationalDecisions = [
    "order_delivered",
    "order_in_transit",
    "order_shipped",
    "order_placed",
    "order_confirmed",
    "order_out_for_delivery",
    "order_not_dispatched",
    "order_not_dispatched_yet",
    "tracking_available",
    "tracking_info_available",
    "delivery_policy_info",
    "refund_policy_info",
    "return_policy_info",
    "replacement_policy_info",
    "cancellation_policy_info"
  ];

  if (intent === "track_order" && informationalDecisions.includes(decision)) {
    return false;
  }

  return true;
}

function applyCommonEscalation(result, order) {
  if (!order || !result) return result;

  result.escalationTriggers = result.escalationTriggers || [];

  if (shouldApplyValueEscalation(result.intent, result.decision)) {
    if (isVeryHighValue(order)) {
      result.requiresEscalation = true;
      result.escalationTriggers.push("very_high_value_order");
    } else if (isHighValue(order)) {
      result.requiresEscalation = true;
      result.escalationTriggers.push("high_value_order");
    }
  }

  if (hasPaymentConflict(order)) {
    result.requiresEscalation = true;
    result.escalationTriggers.push("payment_conflict");
  }

  if (order.fraudRisk === true || order.isHighRiskUser === true) {
    result.requiresEscalation = true;
    result.escalationTriggers.push("fraud_risk");
  }

  if (
    typeof order.repeatedFailures === "number" &&
    order.repeatedFailures >= Number(rules.thresholds?.maxRepeatedFailures || 3)
  ) {
    result.requiresEscalation = true;
    result.escalationTriggers.push("repeated_low_confidence");
  }

  result.escalationTriggers = [...new Set(result.escalationTriggers)];

  return result;
}

// ===============================
// POLICY INFO INTENTS
// These do not require order ID.
// ===============================

function evaluatePolicyInfo(intent) {
  const policy = rules.policyInfo || {};

  const policyMap = {
    delivery_policy: {
      decision: "delivery_policy_info",
      reason:
        policy.delivery_policy?.message ||
        "Most orders are delivered within 3-7 business days depending on product type, seller, courier partner, and delivery location. Please share your order ID for exact tracking.",
      nextAction: "ask_order_id_for_exact_tracking"
    },
    refund_policy: {
      decision: "refund_policy_info",
      reason:
        policy.refund_policy?.message ||
        "Refunds are usually processed after cancellation confirmation or after return pickup, receiving, and quality check. Refunds generally go to the original payment source.",
      nextAction: "ask_order_id_for_refund_status"
    },
    return_policy: {
      decision: "return_policy_info",
      reason:
        policy.return_policy?.message ||
        "Returns depend on product category, return window, item condition, pickup eligibility, and quality check. Please share your order ID to check exact eligibility.",
      nextAction: "ask_order_id_for_return_eligibility"
    },
    replacement_policy: {
      decision: "replacement_policy_info",
      reason:
        policy.replacement_policy?.message ||
        "Replacement may be available for damaged, defective, wrong, missing, incomplete, technical issue, or dead-on-arrival cases within the allowed replacement window.",
      nextAction: "ask_order_id_for_replacement_eligibility"
    },
    cancellation_policy: {
      decision: "cancellation_policy_info",
      reason:
        policy.cancellation_policy?.message ||
        "Cancellation is usually allowed before dispatch or shipment. Once shipped, out for delivery, or delivered, cancellation is blocked.",
      nextAction: "ask_order_id_for_cancellation_eligibility"
    }
  };

  const data = policyMap[intent];

  if (!data) {
    return createResult({
      intent,
      order: null,
      decision: "policy_info_unavailable",
      allowed: false,
      reason: "I can help with order policies, but I need a little more detail.",
      nextAction: "ask_clarifying_question"
    });
  }

  return createResult({
    intent,
    order: null,
    decision: data.decision,
    allowed: true,
    reason: data.reason,
    refundRequired: false,
    requiresEscalation: false,
    escalationTriggers: [],
    nextAction: data.nextAction
  });
}

function evaluateNonCommerceRequest() {
  return createResult({
    intent: "non_commerce_request",
    order: null,
    decision: "non_commerce_request",
    allowed: false,
    reason:
      "This request is outside order support. CartGenie can help with tracking, cancellation, returns, refunds, replacement, exchange, delivery, and payment issues.",
    requiresEscalation: false,
    escalationTriggers: [],
    nextAction: "redirect_to_order_support"
  });
}

function evaluateGreeting() {
  return createResult({
    intent: "greeting",
    order: null,
    decision: "greeting_detected",
    allowed: true,
    reason:
      "Hi, welcome to CartGenie AI. I can help with tracking, cancellation, returns, refunds, replacement, exchange, delivery, and payment issues.",
    requiresEscalation: false,
    escalationTriggers: [],
    nextAction: "ask_customer_support_need"
  });
}

function evaluateUnsafeRequest() {
  return createResult({
    intent: "unsafe_request",
    order: null,
    decision: "unsafe_input_detected",
    allowed: false,
    reason:
      "Unsafe or policy-bypass instruction pattern detected. This request cannot be processed automatically.",
    requiresEscalation: true,
    escalationTriggers: ["unsafe_input_detected"],
    nextAction: "safety_review"
  });
}

function evaluateHumanSupport(order = null) {
  return createResult({
    intent: "human_support",
    order,
    decision: "customer_requested_human_support",
    allowed: true,
    reason: "Customer requested human support.",
    requiresEscalation: true,
    escalationTriggers: ["customer_requested_human_support"],
    nextAction: "create_human_support_ticket"
  });
}

// ===============================
// CANCELLATION
// ===============================

function evaluateCancellation(order) {
  const status = normalizeStatus(order.status);

  const allowedStatuses = rules.cancellation?.allowedStatuses || [
    "placed",
    "confirmed",
    "processing"
  ];

  const decisionCodes = rules.cancellation?.decisionCodes || {};

  if (allowedStatuses.includes(status)) {
    const refundRequired = isPrepaid(order) && isPaid(order);

    const result = createResult({
      intent: "cancel_order",
      order,
      decision: refundRequired
        ? decisionCodes.allowedWithRefund || "cancel_allowed_refund_initiated"
        : decisionCodes.allowed || "cancel_allowed",
      allowed: true,
      reason: refundRequired
        ? "Order is eligible for cancellation. Since it is prepaid, refund should be initiated to the original payment source."
        : "Order is eligible for cancellation because it has not been dispatched yet.",
      refundRequired,
      nextAction: refundRequired
        ? "cancel_order_and_initiate_refund"
        : "cancel_order"
    });

    return applyCommonEscalation(result, order);
  }

  if (status === "dispatched") {
    return applyCommonEscalation(
      createResult({
        intent: "cancel_order",
        order,
        decision: decisionCodes.blockedDispatched || "cancel_blocked_dispatched",
        allowed: false,
        reason:
          "Order has already been dispatched, so cancellation is blocked as per policy.",
        nextAction: "suggest_reject_at_doorstep_or_return_if_eligible"
      }),
      order
    );
  }

  if (status === "shipped") {
    return applyCommonEscalation(
      createResult({
        intent: "cancel_order",
        order,
        decision: decisionCodes.blockedShipped || "cancel_blocked_shipped",
        allowed: false,
        reason:
          "Order has already been shipped, so cancellation is blocked as per policy.",
        nextAction: "suggest_reject_at_doorstep_or_return_if_eligible"
      }),
      order
    );
  }

  if (status === "out_for_delivery") {
    return applyCommonEscalation(
      createResult({
        intent: "cancel_order",
        order,
        decision:
          decisionCodes.blockedOutForDelivery ||
          "cancel_blocked_out_for_delivery",
        allowed: false,
        reason:
          "Order is already out for delivery, so it cannot be cancelled now. Customer may reject it at doorstep if allowed.",
        nextAction: "suggest_reject_at_doorstep"
      }),
      order
    );
  }

  if (status === "delivered") {
    return applyCommonEscalation(
      createResult({
        intent: "cancel_order",
        order,
        decision: decisionCodes.blockedDelivered || "cancel_blocked_delivered",
        allowed: false,
        reason:
          "Order has already been delivered, so cancellation is not possible. Customer may request return or replacement if eligible.",
        nextAction: "suggest_return_or_replacement_if_eligible"
      }),
      order
    );
  }

  if (status === "cancelled") {
    return createResult({
      intent: "cancel_order",
      order,
      decision: decisionCodes.alreadyCancelled || "cancel_already_done",
      allowed: false,
      reason: "This order is already cancelled.",
      nextAction: "check_refund_status_if_prepaid"
    });
  }

  return applyCommonEscalation(
    createResult({
      intent: "cancel_order",
      order,
      decision: decisionCodes.requiresEscalation || "cancel_requires_escalation",
      allowed: false,
      reason:
        "Cancellation decision requires human review because the order status is not clear for automatic cancellation.",
      requiresEscalation: true,
      escalationTriggers: ["order_status_unclear"],
      nextAction: "human_review"
    }),
    order
  );
}

// ===============================
// RETURN
// ===============================

function evaluateReturn(order) {
  const status = normalizeStatus(order.status);
  const category = normalize(order.category);

  const decisionCodes = rules.return?.decisionCodes || {};
  const blockedCategories = rules.return?.blockedCategories || [];

  if (status !== "delivered") {
    return applyCommonEscalation(
      createResult({
        intent: "return_order",
        order,
        decision:
          decisionCodes.blockedNotDelivered || "return_blocked_not_delivered",
        allowed: false,
        reason: "Return can be requested only after the order is delivered.",
        nextAction: "wait_until_delivery"
      }),
      order
    );
  }

  if (order.isAlteredProduct || category === "altered_product") {
    return applyCommonEscalation(
      createResult({
        intent: "return_order",
        order,
        decision:
          decisionCodes.blockedAlteredProduct ||
          "return_blocked_altered_product",
        allowed: false,
        reason:
          "Altered products are non-returnable and non-refundable as per policy.",
        nextAction: "escalate_if_customer_disputes"
      }),
      order
    );
  }

  if (!order.returnable || blockedCategories.includes(category)) {
    return applyCommonEscalation(
      createResult({
        intent: "return_order",
        order,
        decision:
          decisionCodes.blockedNonReturnable || "return_blocked_non_returnable",
        allowed: false,
        reason: "This product category is not eligible for return as per policy.",
        nextAction: "check_replacement_if_damaged_wrong_or_defective"
      }),
      order
    );
  }

  const windowDays =
    order.returnWindowDays ||
    rules.return?.categoryReturnWindows?.[category] ||
    rules.return?.defaultReturnWindowDays ||
    7;

  if (!isInsideWindow(order.deliveryDaysAgo, windowDays)) {
    return applyCommonEscalation(
      createResult({
        intent: "return_order",
        order,
        decision:
          decisionCodes.blockedWindowExpired || "return_blocked_window_expired",
        allowed: false,
        reason: `Return window has expired. This product had a return window of ${windowDays} days.`,
        nextAction: "escalate_only_if_exception_claim"
      }),
      order
    );
  }

  const conditionFailed =
    order.correctProduct === false ||
    order.completeProduct === false ||
    order.unusedProduct === false ||
    order.undamagedProduct === false ||
    order.originalPackaging === false ||
    order.tagsIntact === false ||
    order.accessoriesPresent === false;

  if (conditionFailed) {
    return applyCommonEscalation(
      createResult({
        intent: "return_order",
        order,
        decision:
          decisionCodes.blockedQualityCheckFailed ||
          "return_blocked_quality_check_failed",
        allowed: false,
        reason:
          "Return may be rejected because the product does not satisfy pickup quality check requirements.",
        nextAction: "manual_quality_check_review"
      }),
      order
    );
  }

  return applyCommonEscalation(
    createResult({
      intent: "return_order",
      order,
      decision: decisionCodes.allowed || "return_allowed",
      allowed: true,
      reason:
        "Product is eligible for return within the return window. Pickup and quality check are required before refund.",
      refundRequired: true,
      nextAction: "create_return_request_and_schedule_pickup"
    }),
    order
  );
}

// ===============================
// REPLACEMENT
// ===============================

function evaluateReplacement(order, issueType = "general") {
  const status = normalizeStatus(order.status);
  const category = normalize(order.category);
  const normalizedIssueType = normalize(issueType || order.issueType || "general");

  if (status !== "delivered") {
    return applyCommonEscalation(
      createResult({
        intent: "replace_order",
        order,
        decision: "replacement_blocked_not_delivered",
        allowed: false,
        reason: "Replacement can be requested only after the order is delivered.",
        nextAction: "wait_until_delivery"
      }),
      order
    );
  }

  const windowDays =
    order.replacementWindowDays ||
    rules.replacement?.categoryReplacementWindows?.[category] ||
    rules.replacement?.defaultReplacementWindowDays ||
    7;

  const decisionCodes = rules.replacement?.decisionCodes || {};

  const DECISION = {
    allowed: decisionCodes.allowed || "replacement_allowed",
    requiresBrandVerification:
      decisionCodes.requiresBrandVerification ||
      "replacement_requires_brand_verification",
    requiresUnboxingProof:
      decisionCodes.requiresUnboxingProof ||
      "replacement_requires_unboxing_proof",
    requiresDOACertificate:
      decisionCodes.requiresDOACertificate ||
      "replacement_requires_doa_certificate",
    blockedWindowExpired:
      decisionCodes.blockedWindowExpired || "replacement_blocked_window_expired",
    blockedAlreadyReplaced:
      decisionCodes.blockedAlreadyReplaced ||
      "replacement_blocked_already_replaced",
    blockedIssueNotEligible:
      decisionCodes.blockedIssueNotEligible ||
      "replacement_blocked_issue_not_eligible",
    requiresEscalation:
      decisionCodes.requiresEscalation || "replacement_requires_escalation"
  };

  if (!order.replacementEligible) {
    return applyCommonEscalation(
      createResult({
        intent: "replace_order",
        order,
        decision: DECISION.blockedIssueNotEligible,
        allowed: false,
        reason: "This product is not eligible for replacement as per policy.",
        nextAction: "human_review_if_customer_disputes"
      }),
      order
    );
  }

  if (
    Number(order.replacementCount || 0) >= 1 &&
    rules.replacement?.onlyOneReplacementAllowed
  ) {
    return applyCommonEscalation(
      createResult({
        intent: "replace_order",
        order,
        decision: DECISION.blockedAlreadyReplaced,
        allowed: false,
        reason: "Only one replacement is allowed for this product as per policy.",
        nextAction: "human_review_if_issue_continues"
      }),
      order
    );
  }

  if (!isInsideWindow(order.deliveryDaysAgo, windowDays)) {
    return applyCommonEscalation(
      createResult({
        intent: "replace_order",
        order,
        decision: DECISION.blockedWindowExpired,
        allowed: false,
        reason: `Replacement window has expired. This product had a replacement window of ${windowDays} days.`,
        nextAction: "brand_service_or_human_review"
      }),
      order
    );
  }

  const allowedIssueTypes = rules.replacement?.allowedIssueTypes || [
    "defective_product",
    "damaged_product",
    "wrong_product",
    "missing_item",
    "incomplete_product",
    "technical_issue",
    "dead_on_arrival"
  ];

  if (!allowedIssueTypes.includes(normalizedIssueType)) {
    return applyCommonEscalation(
      createResult({
        intent: "replace_order",
        order,
        decision: DECISION.blockedIssueNotEligible,
        allowed: false,
        reason:
          "Replacement is allowed only for defective, damaged, wrong, missing, incomplete, technical issue, or DOA cases.",
        nextAction: "ask_customer_for_issue_details"
      }),
      order
    );
  }

  let decision = DECISION.allowed;
  let allowed = true;
  let requiresEscalation = false;
  let escalationTriggers = [];
  let nextAction = "create_replacement_request";
  let reason =
    "Product is eligible for replacement based on the reported issue and replacement window.";

  const brandVerificationCategories =
    rules.replacement?.brandVerificationCategories || [];

  const requiresDOACertificateFor =
    rules.replacement?.requiresDOACertificateFor || [];

  const requiresUnboxingProofFor =
    rules.replacement?.requiresUnboxingProofFor || [];

  const requiresBrandVerification = brandVerificationCategories.includes(category);

  const requiresDOA =
    normalizedIssueType === "dead_on_arrival" &&
    requiresDOACertificateFor.includes(category);

  const requiresUnboxingProof =
    requiresUnboxingProofFor.includes(normalizedIssueType) ||
    requiresUnboxingProofFor.includes(`${category}_damage`);

  if (requiresBrandVerification) {
    requiresEscalation = true;
    escalationTriggers.push("brand_verification_required");
    decision = DECISION.requiresBrandVerification;
    nextAction = "collect_brand_verification_or_service_center_details";
    reason =
      "Product may be eligible for replacement, but brand/service verification is required for this category.";
  }

  if (requiresUnboxingProof) {
    requiresEscalation = true;
    escalationTriggers.push("unboxing_proof_required");

    if (!requiresDOA) {
      decision = DECISION.requiresUnboxingProof;
      nextAction = "collect_unboxing_proof";
      reason:
        "Product may be eligible for replacement, but unboxing proof is required for this issue type.";
    }
  }

  if (requiresDOA) {
    requiresEscalation = true;
    escalationTriggers.push("smartphone_doa_claim");
    escalationTriggers.push("brand_verification_required");
    escalationTriggers.push("unboxing_proof_required");

    decision = DECISION.requiresDOACertificate;
    nextAction = "collect_doa_certificate_and_unboxing_video";
    reason =
      "DOA replacement requires brand DOA certificate and clear unboxing proof before approval.";
  }

  return applyCommonEscalation(
    createResult({
      intent: "replace_order",
      order,
      decision,
      allowed,
      reason,
      requiresEscalation,
      escalationTriggers,
      nextAction
    }),
    order
  );
}

// ===============================
// REFUND
// ===============================

function evaluateRefund(order) {
  const status = normalizeStatus(order.status);
  const decisionCodes = rules.refund?.decisionCodes || {};
  const refundTimeline = rules.refund?.standardTimelineBusinessDays || "3-7";

  if (hasPaymentConflict(order)) {
    return applyCommonEscalation(
      createResult({
        intent: "refund_status",
        order,
        decision:
          decisionCodes.discrepancyEscalate || "refund_discrepancy_escalate",
        allowed: false,
        reason:
          "Refund/payment discrepancy detected. This needs human support verification.",
        requiresEscalation: true,
        escalationTriggers: ["refund_dispute", "payment_conflict"],
        nextAction: "create_payment_support_ticket"
      }),
      order
    );
  }

  if (status === "refund_completed") {
    return createResult({
      intent: "refund_status",
      order,
      decision: decisionCodes.completed || "refund_completed",
      allowed: true,
      reason: "Refund has already been completed.",
      nextAction: "share_refund_reference_if_available"
    });
  }

  if (status === "refund_initiated") {
    return createResult({
      intent: "refund_status",
      order,
      decision: decisionCodes.initiated || "refund_initiated",
      allowed: true,
      reason: `Refund has been initiated. Standard refund timeline is ${refundTimeline} business days.`,
      nextAction: "wait_for_bank_processing"
    });
  }

  if (status === "cancelled") {
    if (isPrepaid(order) && isPaid(order)) {
      return createResult({
        intent: "refund_status",
        order,
        decision: decisionCodes.initiated || "refund_pending_after_cancellation",
        allowed: true,
        reason: `This order is cancelled. If the refund is not completed yet, it is normally processed within ${refundTimeline} business days to the original payment method.`,
        refundRequired: true,
        nextAction: "check_refund_processing_status"
      });
    }

    return createResult({
      intent: "refund_status",
      order,
      decision: "refund_not_applicable_cod_or_unpaid",
      allowed: false,
      reason:
        "This order is cancelled, but no prepaid refund is applicable based on the current payment details.",
      nextAction: "no_refund_action_required"
    });
  }

  if (status === "return_picked") {
    return createResult({
      intent: "refund_status",
      order,
      decision:
        decisionCodes.pendingReturnReceived || "refund_pending_return_received",
      allowed: false,
      reason:
        "Refund is pending because the returned product has not yet been received by the seller.",
      nextAction: "wait_for_seller_to_receive_return"
    });
  }

  if (status === "return_received" && order.qualityCheckPassed !== true) {
    return createResult({
      intent: "refund_status",
      order,
      decision: decisionCodes.pendingQualityCheck || "refund_pending_quality_check",
      allowed: false,
      reason: "Refund is pending because quality check is not completed yet.",
      nextAction: "wait_for_quality_check"
    });
  }

  if (status === "quality_check_passed") {
    const codNeedsBank = normalizePaymentMethod(order.paymentMethod) === "cod";

    return createResult({
      intent: "refund_status",
      order,
      decision: codNeedsBank
        ? decisionCodes.pendingBankDetails || "refund_pending_bank_details"
        : decisionCodes.initiated || "refund_initiated",
      allowed: true,
      reason: codNeedsBank
        ? "Quality check is passed. Bank details are required to process COD refund."
        : "Quality check is passed. Refund should be initiated to the original payment source.",
      refundRequired: true,
      nextAction: codNeedsBank ? "collect_bank_details" : "initiate_refund"
    });
  }

  return applyCommonEscalation(
    createResult({
      intent: "refund_status",
      order,
      decision: decisionCodes.pendingPickup || "refund_pending_pickup",
      allowed: false,
      reason:
        "Refund can be processed only after cancellation or after return pickup and verification.",
      nextAction: "check_cancellation_or_return_status"
    }),
    order
  );
}

// ===============================
// PAYMENT
// ===============================

function evaluatePayment(order) {
  const decisionCodes = rules.payment?.decisionCodes || {};
  const orderValue = getOrderValue(order);

  if (orderValue >= Number(rules.payment?.panRequiredAbove || 200000)) {
    return createResult({
      intent: "payment_issue",
      order,
      decision:
        decisionCodes.panVerificationRequired || "pan_verification_required",
      allowed: false,
      reason:
        "High-value order requires PAN verification before further payment processing.",
      requiresEscalation: true,
      escalationTriggers: ["pan_verification_required"],
      nextAction: "collect_pan_verification"
    });
  }

  if (
    normalizePaymentMethod(order.paymentMethod || order.paymentMode) === "cod" &&
    orderValue > Number(rules.payment?.codMaxOrderValue || 50000)
  ) {
    return createResult({
      intent: "payment_issue",
      order,
      decision: decisionCodes.codNotAvailable || "cod_not_available",
      allowed: false,
      reason: `COD is not available for orders above ₹${
        rules.payment?.codMaxOrderValue || 50000
      }.`,
      nextAction: "suggest_prepaid_payment_method"
    });
  }

  if (hasPaymentConflict(order)) {
    return createResult({
      intent: "payment_issue",
      order,
      decision: decisionCodes.paymentIssueEscalate || "payment_issue_escalate",
      allowed: false,
      reason:
        "Payment conflict detected. This case should be escalated for verification.",
      requiresEscalation: true,
      escalationTriggers: ["payment_conflict"],
      nextAction: "create_payment_support_ticket"
    });
  }

  return createResult({
    intent: "payment_issue",
    order,
    decision: decisionCodes.paymentMethodSupported || "payment_method_supported",
    allowed: true,
    reason: "Payment method is supported and no payment conflict is detected.",
    nextAction: "no_payment_action_required"
  });
}

// ===============================
// EXCHANGE
// ===============================

function evaluateExchange(order) {
  const status = normalizeStatus(order.status);
  const category = normalize(order.category);
  const decisionCodes = rules.exchange?.decisionCodes || {};

  if (status !== "delivered") {
    return applyCommonEscalation(
      createResult({
        intent: "exchange_order",
        order,
        decision: "exchange_blocked_not_delivered",
        allowed: false,
        reason: "Exchange can be requested only after the order is delivered.",
        nextAction: "wait_until_delivery"
      }),
      order
    );
  }

  if (!order.exchangeable) {
    return applyCommonEscalation(
      createResult({
        intent: "exchange_order",
        order,
        decision:
          decisionCodes.blockedNotExchangeable ||
          "exchange_blocked_not_exchangeable",
        allowed: false,
        reason: "This product is not eligible for exchange as per policy.",
        nextAction: "check_return_or_replacement_if_eligible"
      }),
      order
    );
  }

  if (
    Number(order.exchangeCount || 0) >= 1 &&
    rules.exchange?.onlyOneExchangeAllowed
  ) {
    return applyCommonEscalation(
      createResult({
        intent: "exchange_order",
        order,
        decision:
          decisionCodes.blockedAlreadyExchanged ||
          "exchange_blocked_already_exchanged",
        allowed: false,
        reason: "Only one exchange is allowed for this product as per policy.",
        nextAction: "human_review_if_customer_disputes"
      }),
      order
    );
  }

  if (!order.stockAvailableForExchange) {
    return applyCommonEscalation(
      createResult({
        intent: "exchange_order",
        order,
        decision:
          decisionCodes.blockedStockUnavailable ||
          "exchange_blocked_stock_unavailable",
        allowed: false,
        reason:
          "Exchange is currently not possible because replacement stock is unavailable.",
        nextAction: "offer_return_if_eligible"
      }),
      order
    );
  }

  if (!order.addressServiceable) {
    return applyCommonEscalation(
      createResult({
        intent: "exchange_order",
        order,
        decision:
          decisionCodes.blockedAddressNotServiceable ||
          "exchange_blocked_address_not_serviceable",
        allowed: false,
        reason: "Exchange pickup/delivery is not available for this address.",
        nextAction: "human_review_or_alternate_address"
      }),
      order
    );
  }

  const windowDays =
    order.exchangeWindowDays ||
    rules.exchange?.categoryExchangeWindows?.[category] ||
    rules.exchange?.defaultExchangeWindowDays ||
    7;

  if (!isInsideWindow(order.deliveryDaysAgo, windowDays)) {
    return applyCommonEscalation(
      createResult({
        intent: "exchange_order",
        order,
        decision:
          decisionCodes.blockedWindowExpired || "exchange_blocked_window_expired",
        allowed: false,
        reason: `Exchange window has expired. This product had an exchange window of ${windowDays} days.`,
        nextAction: "check_return_or_human_review"
      }),
      order
    );
  }

  return applyCommonEscalation(
    createResult({
      intent: "exchange_order",
      order,
      decision: decisionCodes.allowed || "exchange_allowed",
      allowed: true,
      reason:
        "Product is eligible for exchange. Pickup and quality check may be required.",
      nextAction: "create_exchange_request"
    }),
    order
  );
}

// ===============================
// DELIVERY / TRACKING
// ===============================

function evaluateDelivery(order) {
  const status = normalizeStatus(order.status);

  const trackingId =
    order.trackingId ||
    order.awb ||
    order.shipmentId ||
    order.courierTrackingId ||
    null;

  const estimatedDeliveryDate =
    order.estimatedDeliveryDate ||
    order.expectedDeliveryDate ||
    order.promisedDeliveryDate ||
    null;

  const deliveryDate = order.deliveryDate || order.deliveredAt || null;

  if (status === "delivered") {
    return createResult({
      intent: "track_order",
      order,
      decision: "order_delivered",
      allowed: true,
      reason: deliveryDate
        ? `Order has already been delivered on ${deliveryDate}.`
        : "Order has already been delivered.",
      nextAction: "show_delivered_status",
      extra: {
        trackingId,
        deliveryDate,
        currentStatus: "delivered"
      }
    });
  }

  if (status === "out_for_delivery") {
    return createResult({
      intent: "track_order",
      order,
      decision: "order_out_for_delivery",
      allowed: true,
      reason:
        "Order is currently out for delivery and should reach the customer soon.",
      nextAction: "show_out_for_delivery_status",
      extra: {
        trackingId,
        estimatedDeliveryDate,
        currentStatus: "out_for_delivery"
      }
    });
  }

  if (status === "shipped" || status === "dispatched") {
    return createResult({
      intent: "track_order",
      order,
      decision:
        rules.delivery?.decisionCodes?.trackingAvailable || "tracking_available",
      allowed: true,
      reason: estimatedDeliveryDate
        ? `Order has been ${status}. Estimated delivery date is ${estimatedDeliveryDate}.`
        : `Order has been ${status}. Tracking is available for this order.`,
      nextAction: "share_tracking_details",
      extra: {
        trackingId,
        estimatedDeliveryDate,
        currentStatus: status
      }
    });
  }

  if (
    status === "placed" ||
    status === "confirmed" ||
    status === "processing"
  ) {
    return createResult({
      intent: "track_order",
      order,
      decision: "order_not_dispatched_yet",
      allowed: true,
      reason: estimatedDeliveryDate
        ? `Order is ${status} and has not been dispatched yet. Estimated delivery date is ${estimatedDeliveryDate}.`
        : `Order is ${status} and has not been dispatched yet. Tracking usually becomes available after dispatch.`,
      nextAction: "wait_until_dispatch",
      extra: {
        trackingId: null,
        estimatedDeliveryDate,
        currentStatus: status
      }
    });
  }

  if (status === "cancelled") {
    return createResult({
      intent: "track_order",
      order,
      decision: "order_cancelled",
      allowed: false,
      reason:
        "This order has been cancelled, so delivery tracking is not available.",
      nextAction: "check_refund_status_if_prepaid",
      extra: {
        currentStatus: "cancelled"
      }
    });
  }

  if (status === "returned_to_origin") {
    return applyCommonEscalation(
      createResult({
        intent: "delivery_issue",
        order,
        decision: "returned_to_origin",
        allowed: false,
        reason:
          "This order is marked as returned to origin. Delivery could not be completed.",
        requiresEscalation: true,
        escalationTriggers: ["order_status_unclear"],
        nextAction: "create_delivery_support_ticket",
        extra: {
          currentStatus: "returned_to_origin"
        }
      }),
      order
    );
  }

  if (status === "delivery_failed") {
    return applyCommonEscalation(
      createResult({
        intent: "delivery_issue",
        order,
        decision:
          rules.delivery?.decisionCodes?.deliveryFailedEscalate ||
          "delivery_failed_escalate",
        allowed: false,
        reason: "Delivery has failed and requires support review.",
        requiresEscalation: true,
        escalationTriggers: ["order_status_unclear"],
        nextAction: "create_delivery_support_ticket",
        extra: {
          currentStatus: "delivery_failed"
        }
      }),
      order
    );
  }

  if (status === "lost_in_transit") {
    return applyCommonEscalation(
      createResult({
        intent: "delivery_issue",
        order,
        decision:
          rules.delivery?.decisionCodes?.lostInTransitEscalate ||
          "lost_in_transit_escalate",
        allowed: false,
        reason: "Order appears to be lost in transit. This requires escalation.",
        requiresEscalation: true,
        escalationTriggers: ["order_status_unclear"],
        nextAction: "create_delivery_support_ticket",
        extra: {
          currentStatus: "lost_in_transit"
        }
      }),
      order
    );
  }

  return applyCommonEscalation(
    createResult({
      intent: "track_order",
      order,
      decision:
        rules.delivery?.decisionCodes?.trackingNotAvailable ||
        "tracking_not_available",
      allowed: false,
      reason:
        "Tracking status is not clear for this order. This may need support review.",
      requiresEscalation: true,
      escalationTriggers: ["order_status_unclear"],
      nextAction: "human_review",
      extra: {
        currentStatus: status || "unknown"
      }
    }),
    order
  );
}

// ===============================
// MAIN RULE ROUTER
// Supports both:
// applyRules({ intent, order, issueType })
// applyRules(intent, order, issueType)
// ===============================

function applyRules(input, maybeOrder = null, maybeIssueType = "general") {
  let intent;
  let order;
  let issueType;

  if (typeof input === "object" && input !== null) {
    intent = input.intent;
    order = input.order;
    issueType = input.issueType || "general";
  } else {
    intent = input;
    order = maybeOrder;
    issueType = maybeIssueType || "general";
  }

  intent = normalize(intent);

  if (!intent) {
    return createResult({
      intent: null,
      order: null,
      decision: rules.commonErrors?.unsupportedIntent || "unsupported_intent",
      allowed: false,
      reason: "Intent is missing or unsupported.",
      nextAction: "ask_clarifying_question"
    });
  }

  switch (intent) {
    case "greeting":
      return evaluateGreeting();

    case "non_commerce_request":
      return evaluateNonCommerceRequest();

    case "unsafe_request":
      return evaluateUnsafeRequest();

    case "human_support":
      return evaluateHumanSupport(order);

    case "delivery_policy":
    case "refund_policy":
    case "return_policy":
    case "replacement_policy":
    case "cancellation_policy":
      return evaluatePolicyInfo(intent);

    case "order_reference_only":
      return createResult({
        intent,
        order,
        decision: "order_reference_only_needs_context",
        allowed: false,
        reason:
          "Only an order ID was provided. Please tell me whether you want to track, cancel, return, replace, exchange, or check refund/payment status.",
        nextAction: "ask_customer_intent"
      });

    default:
      break;
  }

  if (!order) {
    return createResult({
      intent,
      order: null,
      decision: rules.commonErrors?.orderNotFound || "order_not_found",
      allowed: false,
      reason: "Order was not found. Please check the order ID.",
      nextAction: "ask_valid_order_id"
    });
  }

  switch (intent) {
    case "cancel_order":
      return evaluateCancellation(order);

    case "return_order":
      return evaluateReturn(order);

    case "replace_order":
    case "damaged_item":
    case "wrong_item":
    case "missing_item":
      return evaluateReplacement(order, issueType || order.issueType || "general");

    case "refund_status":
      return evaluateRefund(order);

    case "exchange_order":
      return evaluateExchange(order);

    case "payment_issue":
      return evaluatePayment(order);

    case "track_order":
    case "order_status":
    case "delivery_issue":
      return evaluateDelivery(order);

    default:
      return createResult({
        intent,
        order,
        decision: rules.commonErrors?.unsupportedIntent || "unsupported_intent",
        allowed: false,
        reason: "This support intent is not supported by the current rule engine.",
        nextAction: "fallback_llm_or_human_review"
      });
  }
}

module.exports = {
  applyRules,
  _internal: {
    normalize,
    normalizeStatus,
    normalizePaymentStatus,
    normalizePaymentMethod,
    getOrderValue,
    isPrepaid,
    isPaid,
    hasPaymentConflict,
    isHighValue,
    isVeryHighValue,
    isInsideWindow,
    createResult,
    shouldApplyValueEscalation,
    applyCommonEscalation,
    evaluatePolicyInfo,
    evaluateNonCommerceRequest,
    evaluateGreeting,
    evaluateUnsafeRequest,
    evaluateHumanSupport,
    evaluateCancellation,
    evaluateReturn,
    evaluateReplacement,
    evaluateRefund,
    evaluatePayment,
    evaluateExchange,
    evaluateDelivery
  }
};