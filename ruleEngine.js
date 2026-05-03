const rules = require("./rules.json");

function isPrepaid(order) {
  return ["upi", "card", "netbanking", "wallet", "pay_later", "emi"].includes(
    order.paymentMethod
  );
}

function hasPaymentConflict(order) {
  return rules.payment.paymentConflictStatuses.includes(order.paymentStatus);
}

function isHighValue(order) {
  return order.orderValue >= rules.thresholds.highValueOrder;
}

function isVeryHighValue(order) {
  return order.orderValue >= rules.thresholds.veryHighValueOrder;
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
    escalationTriggers,
    nextAction,
    ...extra
  };
}

function applyCommonEscalation(result, order) {
  if (!order) return result;

  if (isVeryHighValue(order)) {
    result.requiresEscalation = true;
    result.escalationTriggers.push("very_high_value_order");
  } else if (isHighValue(order)) {
    result.requiresEscalation = true;
    result.escalationTriggers.push("high_value_order");
  }

  if (hasPaymentConflict(order)) {
    result.requiresEscalation = true;
    result.escalationTriggers.push("payment_conflict");
  }

  if (order.fraudRisk === true || order.isHighRiskUser === true) {
    result.requiresEscalation = true;
    result.escalationTriggers.push("fraud_risk");
  }

  if (order.repeatedFailures >= rules.thresholds.maxRepeatedFailures) {
    result.requiresEscalation = true;
    result.escalationTriggers.push("repeated_low_confidence");
  }

  result.escalationTriggers = [...new Set(result.escalationTriggers)];

  return result;
}

function evaluateCancellation(order) {
  const status = order.status;

  if (rules.cancellation.allowedStatuses.includes(status)) {
    const refundRequired = isPrepaid(order) && order.paymentStatus === "paid";

    const result = createResult({
      intent: "cancel_order",
      order,
      decision: refundRequired
        ? rules.cancellation.decisionCodes.allowedWithRefund
        : rules.cancellation.decisionCodes.allowed,
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
        decision: rules.cancellation.decisionCodes.blockedDispatched,
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
        decision: rules.cancellation.decisionCodes.blockedShipped,
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
        decision: rules.cancellation.decisionCodes.blockedOutForDelivery,
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
        decision: rules.cancellation.decisionCodes.blockedDelivered,
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
      decision: rules.cancellation.decisionCodes.alreadyCancelled,
      allowed: false,
      reason: "This order is already cancelled.",
      nextAction: "check_refund_status_if_prepaid"
    });
  }

  return applyCommonEscalation(
    createResult({
      intent: "cancel_order",
      order,
      decision: rules.cancellation.decisionCodes.requiresEscalation,
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

function evaluateReturn(order) {
  if (order.status !== "delivered") {
    return applyCommonEscalation(
      createResult({
        intent: "return_order",
        order,
        decision: rules.return.decisionCodes.blockedNotDelivered,
        allowed: false,
        reason: "Return can be requested only after the order is delivered.",
        nextAction: "wait_until_delivery"
      }),
      order
    );
  }

  if (order.isAlteredProduct || order.category === "altered_product") {
    return applyCommonEscalation(
      createResult({
        intent: "return_order",
        order,
        decision: rules.return.decisionCodes.blockedAlteredProduct,
        allowed: false,
        reason:
          "Altered products are non-returnable and non-refundable as per policy.",
        nextAction: "escalate_if_customer_disputes"
      }),
      order
    );
  }

  if (!order.returnable || rules.return.blockedCategories.includes(order.category)) {
    return applyCommonEscalation(
      createResult({
        intent: "return_order",
        order,
        decision: rules.return.decisionCodes.blockedNonReturnable,
        allowed: false,
        reason: "This product category is not eligible for return as per policy.",
        nextAction: "check_replacement_if_damaged_wrong_or_defective"
      }),
      order
    );
  }

  const windowDays = order.returnWindowDays || rules.return.defaultReturnWindowDays;

  if (!isInsideWindow(order.deliveryDaysAgo, windowDays)) {
    return applyCommonEscalation(
      createResult({
        intent: "return_order",
        order,
        decision: rules.return.decisionCodes.blockedWindowExpired,
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
        decision: rules.return.decisionCodes.blockedQualityCheckFailed,
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
      decision: rules.return.decisionCodes.allowed,
      allowed: true,
      reason:
        "Product is eligible for return within the return window. Pickup and quality check are required before refund.",
      refundRequired: true,
      nextAction: "create_return_request_and_schedule_pickup"
    }),
    order
  );
}

function evaluateReplacement(order, issueType = "general") {
  const windowDays =
    order.replacementWindowDays || rules.replacement.defaultReplacementWindowDays;

  const decisionCodes = rules.replacement.decisionCodes || {};

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
      decisionCodes.blockedWindowExpired ||
      "replacement_blocked_window_expired",
    blockedAlreadyReplaced:
      decisionCodes.blockedAlreadyReplaced ||
      "replacement_blocked_already_replaced",
    blockedIssueNotEligible:
      decisionCodes.blockedIssueNotEligible ||
      "replacement_blocked_issue_not_eligible",
    requiresEscalation:
      decisionCodes.requiresEscalation ||
      "replacement_requires_escalation"
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

  if (order.replacementCount >= 1 && rules.replacement.onlyOneReplacementAllowed) {
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

  if (!rules.replacement.allowedIssueTypes.includes(issueType)) {
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

  const requiresBrandVerification =
    rules.replacement.brandVerificationCategories.includes(order.category);

  const requiresDOA =
    issueType === "dead_on_arrival" &&
    rules.replacement.requiresDOACertificateFor.includes(order.category);

  const requiresUnboxingProof =
    rules.replacement.requiresUnboxingProofFor.includes(issueType) ||
    rules.replacement.requiresUnboxingProofFor.includes(`${order.category}_damage`);

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

  escalationTriggers = [...new Set(escalationTriggers)];

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

function evaluateRefund(order) {
  if (hasPaymentConflict(order)) {
    return applyCommonEscalation(
      createResult({
        intent: "refund_status",
        order,
        decision: rules.refund.decisionCodes.discrepancyEscalate,
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

  if (order.status === "refund_completed") {
    return createResult({
      intent: "refund_status",
      order,
      decision: rules.refund.decisionCodes.completed,
      allowed: true,
      reason: "Refund has already been completed.",
      nextAction: "share_refund_reference_if_available"
    });
  }

  if (order.status === "refund_initiated") {
    return createResult({
      intent: "refund_status",
      order,
      decision: rules.refund.decisionCodes.initiated,
      allowed: true,
      reason: `Refund has been initiated. Standard refund timeline is ${rules.refund.standardTimelineBusinessDays} business days.`,
      nextAction: "wait_for_bank_processing"
    });
  }

  if (order.status === "return_picked") {
    return createResult({
      intent: "refund_status",
      order,
      decision: rules.refund.decisionCodes.pendingReturnReceived,
      allowed: false,
      reason:
        "Refund is pending because the returned product has not yet been received by the seller.",
      nextAction: "wait_for_seller_to_receive_return"
    });
  }

  if (order.status === "return_received" && order.qualityCheckPassed !== true) {
    return createResult({
      intent: "refund_status",
      order,
      decision: rules.refund.decisionCodes.pendingQualityCheck,
      allowed: false,
      reason: "Refund is pending because quality check is not completed yet.",
      nextAction: "wait_for_quality_check"
    });
  }

  if (order.status === "quality_check_passed") {
    const codNeedsBank = order.paymentMethod === "cod";

    return createResult({
      intent: "refund_status",
      order,
      decision: codNeedsBank
        ? rules.refund.decisionCodes.pendingBankDetails
        : rules.refund.decisionCodes.initiated,
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
      decision: rules.refund.decisionCodes.pendingPickup,
      allowed: false,
      reason:
        "Refund can be processed only after cancellation or after return pickup and verification.",
      nextAction: "check_cancellation_or_return_status"
    }),
    order
  );
}

function evaluatePayment(order) {
  if (order.orderValue >= rules.payment.panRequiredAbove) {
    return createResult({
      intent: "payment_issue",
      order,
      decision: rules.payment.decisionCodes.panVerificationRequired,
      allowed: false,
      reason:
        "High-value order requires PAN verification before further payment processing.",
      requiresEscalation: true,
      escalationTriggers: ["pan_verification_required"],
      nextAction: "collect_pan_verification"
    });
  }

  if (order.paymentMethod === "cod" && order.orderValue > rules.payment.codMaxOrderValue) {
    return createResult({
      intent: "payment_issue",
      order,
      decision: rules.payment.decisionCodes.codNotAvailable,
      allowed: false,
      reason: `COD is not available for orders above ₹${rules.payment.codMaxOrderValue}.`,
      nextAction: "suggest_prepaid_payment_method"
    });
  }

  if (hasPaymentConflict(order)) {
    return createResult({
      intent: "payment_issue",
      order,
      decision: rules.payment.decisionCodes.paymentIssueEscalate,
      allowed: false,
      reason: "Payment conflict detected. This case should be escalated for verification.",
      requiresEscalation: true,
      escalationTriggers: ["payment_conflict"],
      nextAction: "create_payment_support_ticket"
    });
  }

  return createResult({
    intent: "payment_issue",
    order,
    decision: rules.payment.decisionCodes.paymentMethodSupported,
    allowed: true,
    reason: "Payment method is supported and no payment conflict is detected.",
    nextAction: "no_payment_action_required"
  });
}

function evaluateExchange(order) {
  if (!order.exchangeable) {
    return applyCommonEscalation(
      createResult({
        intent: "exchange_order",
        order,
        decision: rules.exchange.decisionCodes.blockedNotExchangeable,
        allowed: false,
        reason: "This product is not eligible for exchange as per policy.",
        nextAction: "check_return_or_replacement_if_eligible"
      }),
      order
    );
  }

  if (order.exchangeCount >= 1 && rules.exchange.onlyOneExchangeAllowed) {
    return applyCommonEscalation(
      createResult({
        intent: "exchange_order",
        order,
        decision: rules.exchange.decisionCodes.blockedAlreadyExchanged,
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
        decision: rules.exchange.decisionCodes.blockedStockUnavailable,
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
        decision: rules.exchange.decisionCodes.blockedAddressNotServiceable,
        allowed: false,
        reason: "Exchange pickup/delivery is not available for this address.",
        nextAction: "human_review_or_alternate_address"
      }),
      order
    );
  }

  const windowDays = order.exchangeWindowDays || rules.exchange.defaultExchangeWindowDays;

  if (!isInsideWindow(order.deliveryDaysAgo, windowDays)) {
    return applyCommonEscalation(
      createResult({
        intent: "exchange_order",
        order,
        decision: rules.exchange.decisionCodes.blockedWindowExpired,
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
      decision: rules.exchange.decisionCodes.allowed,
      allowed: true,
      reason: "Product is eligible for exchange. Pickup and quality check may be required.",
      nextAction: "create_exchange_request"
    }),
    order
  );
}

function evaluateDelivery(order) {
  if (rules.delivery.trackingStatuses.includes(order.status)) {
    return applyCommonEscalation(
      createResult({
        intent: "track_order",
        order,
        decision: rules.delivery.decisionCodes.trackingAvailable,
        allowed: true,
        reason: "Tracking is available for this order.",
        nextAction: "share_tracking_details",
        extra: {
          trackingId: order.trackingId
        }
      }),
      order
    );
  }

  if (order.status === "delivery_failed") {
    return applyCommonEscalation(
      createResult({
        intent: "delivery_issue",
        order,
        decision: rules.delivery.decisionCodes.deliveryFailedEscalate,
        allowed: false,
        reason: "Delivery has failed and requires support review.",
        requiresEscalation: true,
        escalationTriggers: ["order_status_unclear"],
        nextAction: "create_delivery_support_ticket"
      }),
      order
    );
  }

  if (order.status === "lost_in_transit") {
    return applyCommonEscalation(
      createResult({
        intent: "delivery_issue",
        order,
        decision: rules.delivery.decisionCodes.lostInTransitEscalate,
        allowed: false,
        reason: "Order appears to be lost in transit. This requires escalation.",
        requiresEscalation: true,
        escalationTriggers: ["order_status_unclear"],
        nextAction: "create_delivery_support_ticket"
      }),
      order
    );
  }

  return applyCommonEscalation(
    createResult({
      intent: "track_order",
      order,
      decision: rules.delivery.decisionCodes.trackingNotAvailable,
      allowed: false,
      reason:
        "Tracking is not available yet. It usually becomes available after dispatch.",
      nextAction: "wait_until_dispatch"
    }),
    order
  );
}

function applyRules({ intent, order, issueType }) {
  if (!intent) {
    return createResult({
      intent: null,
      order: null,
      decision: rules.commonErrors.unsupportedIntent,
      allowed: false,
      reason: "Intent is missing or unsupported.",
      nextAction: "ask_clarifying_question"
    });
  }

  if (!order) {
    return createResult({
      intent,
      order: null,
      decision: rules.commonErrors.orderNotFound,
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
    case "delivery_issue":
      return evaluateDelivery(order);

    default:
      return createResult({
        intent,
        order,
        decision: rules.commonErrors.unsupportedIntent,
        allowed: false,
        reason: "This support intent is not supported by the current rule engine.",
        nextAction: "fallback_llm_or_human_review"
      });
  }
}

module.exports = {
  applyRules
};