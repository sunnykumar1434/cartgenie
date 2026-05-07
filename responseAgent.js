// responseAgent.js
// Converts rule-engine output into clear, polite, user-friendly customer messages.
// Aligned with CartGenie pipeline:
// Intent Agent -> Confidence Agent -> Rule Engine/Fallback -> Response Agent -> Escalation Agent

function formatOrderId(orderId) {
  return orderId ? `order ${orderId}` : "your order";
}

function capitalize(text = "") {
  if (!text) return text;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function cleanMessage(message) {
  return String(message || "")
    .replace(/\s+/g, " ")
    .replace(/\s+\./g, ".")
    .replace(/\s+,/g, ",")
    .trim();
}

function hasValue(value) {
  return value !== undefined && value !== null && String(value).trim() !== "";
}

function formatDate(value) {
  if (!hasValue(value)) return null;
  return String(value);
}

function formatStatus(status = "") {
  if (!status) return null;

  return String(status)
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

// ===============================
// STATUS LABEL
// ===============================

function getStatusLabel(result) {
  if (!result) return "ERROR";

  const informationalDecisions = [
    "greeting_detected",
    "non_commerce_request",
    "delivery_policy_info",
    "refund_policy_info",
    "return_policy_info",
    "replacement_policy_info",
    "cancellation_policy_info",
    "order_reference_only_needs_context",
    "order_delivered",
    "order_out_for_delivery",
    "order_not_dispatched_yet",
    "tracking_available",
    "order_cancelled",
    "refund_not_started",
    "refund_completed",
    "refund_initiated",
    "refund_pending_after_cancellation",
    "payment_successful",
    "payment_pending",
    "payment_refunded"
  ];

  if (informationalDecisions.includes(result.decision)) {
    if (result.decision === "greeting_detected") return "GREETING";

    if (result.decision === "non_commerce_request") {
      return "OFF_TOPIC_OR_UNCLEAR";
    }

    if (result.decision === "order_reference_only_needs_context") {
      return "CLARIFICATION_REQUIRED";
    }

    return "APPROVED";
  }

  if (result.requiresEscalation) return "ESCALATION_REQUIRED";
  if (result.allowed) return "APPROVED";

  return "BLOCKED";
}

// ===============================
// ESCALATION NOTE
// ===============================

function getEscalationNote(result) {
  if (!result || !result.requiresEscalation) return "";

  const triggers = result.escalationTriggers || [];

  if (triggers.includes("payment_conflict")) {
    return " I’ll make sure this is marked for payment verification so the transaction can be checked safely.";
  }

  if (triggers.includes("refund_dispute")) {
    return " I’ll mark this for refund support review so the refund and transaction details can be verified properly.";
  }

  if (triggers.includes("smartphone_doa_claim")) {
    return " I’ll mark this for specialist verification so the DOA claim can be reviewed correctly.";
  }

  if (triggers.includes("brand_verification_required")) {
    return " The verification team may need to check the brand or service-center proof before final approval.";
  }

  if (triggers.includes("unboxing_proof_required")) {
    return " Once you share the required proof, the team can review it and confirm the next step.";
  }

  if (
    triggers.includes("very_high_value_order") ||
    triggers.includes("high_value_order")
  ) {
    return " Since this is a high-value order, an additional verification step may be required for your safety.";
  }

  if (triggers.includes("fraud_risk")) {
    return " Manual verification is required before moving ahead.";
  }

  if (triggers.includes("angry_customer")) {
    return " I’m also marking this for support attention so your concern is handled carefully.";
  }

  if (triggers.includes("customer_requested_human_support")) {
    return " I’ll route this to a human support specialist for further help.";
  }

  if (triggers.includes("order_status_unclear")) {
    return " I’ll mark this for support review because the current order status needs manual checking.";
  }

  if (
    triggers.includes("unsafe_input_detected") ||
    triggers.includes("prompt_injection_detected")
  ) {
    return " This request has been marked for safety review.";
  }

  if (triggers.includes("policy_conflict")) {
    return " I’ll mark this for manual review so the policy conditions can be checked properly.";
  }

  return " I’ll mark this case for support review so it can be checked properly.";
}

// ===============================
// NEXT STEP MESSAGE
// ===============================

function getNextStepMessage(result = {}) {
  switch (result.nextAction) {
    // Cancellation
    case "cancel_order_and_initiate_refund":
      return "I’ll move this ahead for cancellation and start the refund process to the original payment method.";
    case "cancel_order":
      return "I’ll move this ahead for cancellation.";
    case "suggest_reject_at_doorstep_or_return_if_eligible":
      return "You may reject the order at delivery if that option is available. After delivery, we can also check return or replacement options if the product is eligible.";
    case "suggest_reject_at_doorstep":
      return "You may reject the order at the doorstep if the delivery partner allows it.";
    case "suggest_return_or_replacement_if_eligible":
      return "Since cancellation is no longer possible, I can help check return or replacement eligibility if there is any issue with the product.";

    // Return
    case "create_return_request_and_schedule_pickup":
      return "I’ll move this ahead for return request creation and pickup scheduling.";
    case "wait_until_delivery":
      return "Please wait until the order is delivered. After delivery, I can help check return, replacement, or exchange eligibility based on the policy.";
    case "escalate_only_if_exception_claim":
      return "If you received a damaged, wrong, expired, or missing item, this can still be reviewed as an exception.";
    case "manual_quality_check_review":
      return "This needs a manual quality-check review before the next step can be confirmed.";
    case "check_replacement_if_damaged_wrong_or_defective":
      return "If the product is damaged, defective, wrong, missing, or not working, I can help check replacement eligibility.";

    // Replacement
    case "collect_doa_certificate_and_unboxing_video":
      return "Please share the brand DOA certificate and clear unboxing proof so the claim can be verified.";
    case "collect_brand_verification_or_service_center_details":
      return "Please share the brand or service-center verification details so the replacement request can be reviewed.";
    case "collect_unboxing_proof":
      return "Please share clear unboxing proof so the claim can be verified properly.";
    case "create_replacement_request":
      return "I’ll move this ahead for replacement request creation.";
    case "brand_service_or_human_review":
      return "You may still check with the brand service center, or we can route this for support review if needed.";
    case "ask_customer_for_issue_details":
      return "Please tell me what exactly is wrong with the product so I can check the correct policy for you.";

    // Payment / refund
    case "create_payment_support_ticket":
      return "I’ll move this ahead as a payment support ticket for verification.";
    case "collect_bank_details":
      return "Please provide your bank details securely so the COD refund can be processed.";
    case "initiate_refund":
      return "I’ll move this ahead for refund initiation.";
    case "wait_for_bank_processing":
      return "Please allow the bank or payment provider processing timeline to complete.";
    case "wait_for_quality_check":
      return "Please wait until the quality check is completed. The next step depends on that result.";
    case "wait_for_seller_to_receive_return":
      return "The refund can move ahead once the seller receives the returned product.";
    case "check_cancellation_or_return_status":
      return "Refund usually starts only after successful cancellation or after return pickup and verification.";
    case "check_refund_processing_status":
      return "I can help check the latest refund processing status for this order.";
    case "share_refund_reference_if_available":
      return "You can also check the refund reference or transaction details if available.";
    case "no_refund_action_required":
      return "No refund action is required right now.";
    case "suggest_prepaid_payment_method":
      return "Please choose a prepaid payment method to continue with this order.";
    case "collect_pan_verification":
      return "Please complete PAN verification before further payment processing.";
    case "no_payment_action_required":
      return "No payment action is required right now.";

    // Exchange
    case "create_exchange_request":
      return "I’ll move this ahead for exchange request creation.";
    case "offer_return_if_eligible":
      return "I can also help check whether this product is eligible for return.";
    case "check_return_or_replacement_if_eligible":
      return "I can help check return or replacement eligibility based on the product policy.";
    case "human_review_if_customer_disputes":
      return "This can be reviewed further if you believe there is a valid exception.";
    case "human_review_if_issue_continues":
      return "This can be reviewed by support if the issue still continues.";
    case "human_review_or_alternate_address":
      return "Support can review this further, or you may try an alternate serviceable address.";
    case "check_return_or_human_review":
      return "I can help check return eligibility or route this for support review if needed.";

    // Tracking / delivery
    case "share_tracking_details":
      return "You can use this tracking ID to follow the latest courier updates.";
    case "show_delivered_status":
      return "If you are facing any issue with the delivered product, I can help check return or replacement eligibility.";
    case "show_out_for_delivery_status":
      return "Please keep your phone available, as the delivery partner may contact you during delivery.";
    case "wait_until_dispatch":
      return "Tracking details usually become available once the order is dispatched.";
    case "check_refund_status_if_prepaid":
      return "If this was a prepaid order, I can also help check the refund status.";
    case "create_delivery_support_ticket":
      return "I’ll move this ahead to the delivery support team for review.";

    // Policy info
    case "ask_order_id_for_exact_tracking":
      return "For exact tracking, please share your order ID, like ORD101.";
    case "ask_order_id_for_refund_status":
      return "For exact refund status, please share your order ID, like ORD101.";
    case "ask_order_id_for_return_eligibility":
      return "For exact return eligibility, please share your order ID, like ORD101.";
    case "ask_order_id_for_replacement_eligibility":
      return "For exact replacement eligibility, please share your order ID, like ORD101.";
    case "ask_order_id_for_cancellation_eligibility":
      return "For exact cancellation eligibility, please share your order ID, like ORD101.";

    // General / safety
    case "ask_customer_support_need":
      return "Please tell me what you need help with, and share your order ID if you have it.";
    case "redirect_to_order_support":
      return "Please share your order ID or tell me your order-related issue, and I’ll help you right away.";
    case "ask_customer_intent":
      return "Please tell me what you would like to do next: track, cancel, return, replace, exchange, or check refund/payment status.";
    case "ask_valid_order_id":
      return "Please check the order ID once and share a valid order ID, like ORD101.";
    case "ask_clarifying_question":
      return "Please share a little more detail so I can guide you correctly.";
    case "fallback_llm_or_human_review":
      return "This request needs additional support review before we can proceed.";
    case "safety_review":
      return "This request cannot be processed automatically and needs safety review.";
    case "create_human_support_ticket":
      return "I’ll route this to a human support specialist.";

    default:
      return result.requiresEscalation
        ? "This should be reviewed by the support team before moving ahead."
        : "No additional action is required right now.";
  }
}

// ===============================
// DECISION MESSAGE
// ===============================

function getDecisionMessage(result = {}) {
  const orderText = formatOrderId(result.orderId);
  const trackingId = result.trackingId;
  const deliveryDate = formatDate(result.deliveryDate);
  const estimatedDeliveryDate = formatDate(result.estimatedDeliveryDate);
  const currentStatus = result.currentStatus
    ? formatStatus(result.currentStatus)
    : null;

  switch (result.decision) {
    // General
    case "greeting_detected":
      return "Hi, welcome to CartGenie AI. How can I help you today? I can help with order tracking, cancellation, returns, refunds, replacement, exchange, delivery, and payment issues.";

    case "non_commerce_request":
      return "I understand, but I’m mainly here to help with order-related concerns such as tracking, cancellation, returns, refunds, replacement, exchange, delivery, and payment issues.";

    case "unsafe_input_detected":
      return "I’m sorry, but I cannot follow requests that try to bypass support rules or safety checks. I can still help with any genuine order-related concern.";

    case "customer_requested_human_support":
      return "Of course. I can help you connect with human support.";

    case "order_reference_only_needs_context":
      return result.orderId
        ? `Thanks for sharing order ${result.orderId}. I found this order.`
        : "Thanks for sharing the order details.";

    // Policy info
    case "delivery_policy_info":
    case "refund_policy_info":
    case "return_policy_info":
    case "replacement_policy_info":
    case "cancellation_policy_info":
      return result.reason || "Sure, I can explain this policy for you.";

    case "policy_info_unavailable":
      return "Sure, I can help with order policies, but I need a little more detail about what you want to know.";

    // Cancellation
    case "cancel_allowed":
      return `Sure, I checked this for you. ${capitalize(orderText)} is eligible for cancellation because it has not been dispatched yet.`;

    case "cancel_allowed_refund_initiated":
      return `Sure, I checked this for you. ${capitalize(orderText)} is eligible for cancellation. Since this is a prepaid order, the refund will be processed back to the original payment method.`;

    case "cancel_blocked_dispatched":
      return `I understand you want to cancel this order. I checked ${orderText}, and it has already been dispatched, so cancellation is not available at this stage.`;

    case "cancel_blocked_shipped":
      return `I understand you want to cancel this order. I checked ${orderText}, and it has already been shipped, so cancellation is not available at this stage.`;

    case "cancel_blocked_out_for_delivery":
      return `I understand you want to cancel this order. I checked ${orderText}, and it is already out for delivery, so cancellation is not available now.`;

    case "cancel_blocked_delivered":
      return `I understand you want to cancel this order. I checked ${orderText}, and it has already been delivered, so cancellation is not possible now.`;

    case "cancel_already_done":
      return `${capitalize(orderText)} is already cancelled.`;

    case "cancel_requires_escalation":
      return `I checked ${orderText}, but the cancellation decision needs a manual review because the order status is not clear enough.`;

    // Return
    case "return_allowed":
      return `Sure, I checked this for you. ${capitalize(orderText)} is eligible for return. Pickup and quality check may be required before the refund is processed.`;

    case "return_blocked_not_delivered":
      return `I checked ${orderText}. A return can be requested only after the order is delivered, so it is not eligible for return yet.`;

    case "return_blocked_window_expired":
      return `I checked the eligibility for ${orderText}. The return window has expired, so a normal return is not available now.`;

    case "return_blocked_non_returnable":
      return `I checked ${orderText}. This product category is not eligible for a normal return under the current policy.`;

    case "return_blocked_quality_check_failed":
      return `${capitalize(orderText)} cannot be approved automatically because the product did not satisfy the quality-check requirements.`;

    case "return_blocked_altered_product":
      return `${capitalize(orderText)} is not eligible for return because altered products are not returnable or refundable under the current policy.`;

    case "return_quality_check_required":
      return `${capitalize(orderText)} needs a manual quality-check review before return approval.`;

    // Replacement
    case "replacement_allowed":
      return `Sure, I checked this for you. ${capitalize(orderText)} is eligible for replacement based on the reported issue and replacement window.`;

    case "replacement_requires_brand_verification":
      return `${capitalize(orderText)} may be eligible for replacement, but brand or service-center verification is required first.`;

    case "replacement_requires_unboxing_proof":
      return `${capitalize(orderText)} may be eligible for replacement, but clear unboxing proof is required before approval.`;

    case "replacement_requires_doa_certificate":
      return `I’m sorry to hear that the product is not working. ${capitalize(orderText)} may be eligible for DOA replacement, but a brand DOA certificate and clear unboxing proof are required before approval.`;

    case "replacement_blocked_window_expired":
      return `I checked the eligibility for ${orderText}. The replacement window has expired, so automatic replacement is not available now.`;

    case "replacement_blocked_already_replaced":
      return `${capitalize(orderText)} is not eligible for another replacement because one replacement has already been used.`;

    case "replacement_blocked_issue_not_eligible":
      return `I checked ${orderText}. Based on the current issue details, this product does not qualify for automatic replacement under the current policy.`;

    case "replacement_blocked_not_delivered":
      return `I checked ${orderText}. Replacement can be requested only after the order is delivered.`;

    // Refund
    case "refund_initiated":
      return `I checked ${orderText}. The refund has been initiated.`;

    case "refund_completed":
      return `I checked ${orderText}. The refund has already been completed.`;

    case "refund_pending_after_cancellation":
      return `${capitalize(orderText)} is cancelled, and the refund status is being checked based on the payment details.`;

    case "refund_pending_pickup":
    case "refund_pending_return_pickup":
      return `I checked ${orderText}. The refund is pending because the return pickup has not been completed yet.`;

    case "refund_pending_return_received":
      return `I checked ${orderText}. The refund is pending because the seller has not received the returned product yet.`;

    case "refund_pending_quality_check":
      return `I checked ${orderText}. The refund is pending because the quality check has not been completed yet.`;

    case "refund_pending_bank_details":
      return `I checked ${orderText}. The refund is pending because bank details are required for the COD refund.`;

    case "refund_not_started":
      return `I checked ${orderText}. No active refund has started for this order yet.`;

    case "refund_not_applicable_cod_or_unpaid":
      return `I checked ${orderText}. Based on the current payment details, no prepaid refund is applicable.`;

    case "refund_discrepancy_escalate":
      return `I checked ${orderText}, and I can see a refund or payment discrepancy. This needs support review and verification before we can confirm the final status.`;

    // Payment
    case "payment_issue_escalate":
      return `I understand this is a payment-related concern. I checked ${orderText}, and this payment issue needs support review and verification.`;

    case "payment_successful":
      return `I checked ${orderText}. The payment is marked as successful.`;

    case "payment_pending":
      return `I checked ${orderText}. The payment is currently pending.`;

    case "payment_refunded":
      return `I checked ${orderText}. The payment has already been refunded.`;

    case "payment_status_unclear":
      return `I checked ${orderText}, but the payment status is not clear enough for automatic resolution.`;

    case "cod_not_available":
      return `COD is not available for ${orderText} due to order value or payment policy limits.`;

    case "pan_verification_required":
      return `${capitalize(orderText)} requires PAN verification because it is a very high-value order.`;

    case "payment_method_supported":
      return `I checked ${orderText}. The payment method is supported, and no payment conflict is detected.`;

    // Exchange
    case "exchange_allowed":
      return `Sure, I checked this for you. ${capitalize(orderText)} is eligible for exchange. Pickup and quality check may be required.`;

    case "exchange_blocked_not_delivered":
      return `I checked ${orderText}. Exchange can be requested only after the order is delivered.`;

    case "exchange_blocked_not_exchangeable":
    case "exchange_blocked_non_exchangeable":
      return `I checked ${orderText}. This product is not eligible for exchange under the current policy.`;

    case "exchange_blocked_stock_unavailable":
      return `${capitalize(orderText)} cannot be exchanged right now because exchange stock is unavailable.`;

    case "exchange_blocked_address_not_serviceable":
      return `${capitalize(orderText)} cannot be exchanged because the address is not serviceable for exchange pickup or delivery.`;

    case "exchange_blocked_window_expired":
      return `I checked the eligibility for ${orderText}. The exchange window has expired.`;

    case "exchange_blocked_already_exchanged":
      return `${capitalize(orderText)} is not eligible for another exchange because one exchange has already been used.`;

    // Tracking / Delivery
    case "tracking_available": {
      let message = `I checked ${orderText}.`;

      if (currentStatus) {
        message += ` Current status: ${currentStatus}.`;
      }

      message += " Tracking is available for this order.";

      if (trackingId) {
        message += ` Tracking ID: ${trackingId}.`;
      }

      if (estimatedDeliveryDate) {
        message += ` Estimated delivery date: ${estimatedDeliveryDate}.`;
      }

      return message;
    }

    case "tracking_not_available":
      return `I checked ${orderText}. Tracking is not available yet. It usually becomes available after dispatch.`;

    case "order_delivered": {
      let message = `I checked ${orderText}. Current status: Delivered.`;

      if (deliveryDate) {
        message += ` Delivery date: ${deliveryDate}.`;
      }

      if (trackingId) {
        message += ` Tracking ID: ${trackingId}.`;
      }

      return message;
    }

    case "order_out_for_delivery": {
      let message = `I checked ${orderText}. Current status: Out For Delivery.`;

      if (trackingId) {
        message += ` Tracking ID: ${trackingId}.`;
      }

      if (estimatedDeliveryDate) {
        message += ` Estimated delivery date: ${estimatedDeliveryDate}.`;
      }

      return message;
    }

    case "order_not_dispatched_yet": {
      let message = `I checked ${orderText}. Current status: ${
        currentStatus || "Not Dispatched Yet"
      }.`;

      message += " It has not been dispatched yet.";

      if (estimatedDeliveryDate) {
        message += ` Estimated delivery date: ${estimatedDeliveryDate}.`;
      }

      return message;
    }

    case "order_cancelled":
      return `I checked ${orderText}. Current status: Cancelled. Delivery tracking is not available for this order.`;

    case "returned_to_origin":
    case "order_rto":
      return `I checked ${orderText}. Current status: Returned To Origin. This means the delivery could not be completed.`;

    case "delivery_failed_escalate":
      return `I checked ${orderText}. Delivery has failed, so this needs support review.`;

    case "lost_in_transit_escalate":
      return `I checked ${orderText}. It appears to be lost in transit, so this needs logistics support review.`;

    // Common
    case "order_not_found":
      return "I’m sorry, I could not find this order in the demo records. Please check the order ID once and share it again.";

    case "missing_order_id":
      return "Sure, I can help with that. Please share your order ID, like ORD101, so I can check the latest status and guide you correctly.";

    case "unsupported_intent":
      return "I’m here to help with order-related support such as cancellation, returns, refunds, replacement, delivery, tracking, exchange, and payment issues. Please share your order-related concern and I’ll guide you.";

    case "low_confidence":
      return "I want to make sure I understand your request correctly. Could you please share a little more detail?";

    default:
      return (
        result.reason ||
        "I checked this for you and prepared the next best step based on the current policy."
      );
  }
}

// ===============================
// PUBLIC FUNCTION
// ===============================

function generateResponse(ruleResult) {
  if (!ruleResult) {
    return {
      success: false,
      status: "ERROR",
      message:
        "Sorry, I could not process this request right now. Please try again in a moment.",
      customerMessage:
        "Sorry, I could not process this request right now. Please try again in a moment.",
      internal: {
        decision: null,
        allowed: false,
        requiresEscalation: false
      }
    };
  }

  const decisionMessage = getDecisionMessage(ruleResult);
  const nextStep = getNextStepMessage(ruleResult);
  const escalationNote = getEscalationNote(ruleResult);

  const customerMessage = cleanMessage(
    `${decisionMessage} ${nextStep}${escalationNote}`
  );

  return {
    success: true,
    status: getStatusLabel(ruleResult),
    message: customerMessage,
    customerMessage,
    internal: {
      intent: ruleResult.intent,
      orderId: ruleResult.orderId,
      decision: ruleResult.decision,
      allowed: ruleResult.allowed,
      refundRequired: ruleResult.refundRequired,
      requiresEscalation: ruleResult.requiresEscalation,
      escalationTriggers: ruleResult.escalationTriggers || [],
      nextAction: ruleResult.nextAction,
      rawReason: ruleResult.reason,
      trackingId: ruleResult.trackingId || null,
      currentStatus: ruleResult.currentStatus || null,
      estimatedDeliveryDate: ruleResult.estimatedDeliveryDate || null,
      deliveryDate: ruleResult.deliveryDate || null
    }
  };
}

module.exports = {
  generateResponse,

  _internal: {
    formatOrderId,
    capitalize,
    cleanMessage,
    hasValue,
    formatDate,
    formatStatus,
    getStatusLabel,
    getEscalationNote,
    getNextStepMessage,
    getDecisionMessage
  }
};