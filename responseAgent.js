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
    .trim();
}

/**
 * Escalation note should be short.
 * Do not repeat proof/ticket details already mentioned in decision/next step.
 */
function getEscalationNote(result) {
  if (!result.requiresEscalation) return "";

  const triggers = result.escalationTriggers || [];

  if (triggers.includes("payment_conflict")) {
    return " The payments support team will review this transaction safely.";
  }

  if (triggers.includes("smartphone_doa_claim")) {
    return " I’m marking this for specialist verification so the replacement team can review it properly.";
  }

  if (triggers.includes("brand_verification_required")) {
    return " The verification team will check the brand or service-center proof before final approval.";
  }

  if (triggers.includes("unboxing_proof_required")) {
    return " The proof will be reviewed before the final replacement decision.";
  }

  if (
    triggers.includes("high_value_order") ||
    triggers.includes("very_high_value_order")
  ) {
    return " Since this is a high-value order, an additional verification step is required for safety.";
  }

  if (triggers.includes("fraud_risk")) {
    return " Manual verification is required before we proceed further.";
  }

  if (triggers.includes("angry_customer")) {
    return " I’m also marking this for support attention so your concern is handled carefully.";
  }

  return " I’m marking this case for support review so it can be checked properly.";
}

function getNextStepMessage(result) {
  switch (result.nextAction) {
    case "cancel_order_and_initiate_refund":
      return "I’ll move this ahead for cancellation and refund initiation.";

    case "cancel_order":
      return "I’ll move this ahead for cancellation.";

    case "suggest_reject_at_doorstep_or_return_if_eligible":
      return "You may reject the order at delivery if that option is available, or check return/replacement eligibility after delivery.";

    case "suggest_reject_at_doorstep":
      return "You may reject the order at the doorstep if the delivery partner allows it.";

    case "suggest_return_or_replacement_if_eligible":
      return "After delivery, we can check whether this order is eligible for return or replacement.";

    case "create_return_request_and_schedule_pickup":
      return "I’ll move this ahead for return request creation and pickup scheduling.";

    case "escalate_only_if_exception_claim":
      return "This can still be reviewed as an exception if you received a damaged, wrong, or missing item.";

    case "manual_quality_check_review":
      return "This needs a manual quality-check review before we can confirm the next action.";

    case "collect_doa_certificate_and_unboxing_video":
      return "Please share the brand DOA certificate and clear unboxing proof for verification.";

    case "collect_brand_verification_or_service_center_details":
      return "Please share the brand or service-center verification details so we can review the replacement request.";

    case "collect_unboxing_proof":
      return "Please share clear unboxing proof so we can verify the claim properly.";

    case "create_replacement_request":
      return "I’ll move this ahead for replacement request creation.";

    case "create_payment_support_ticket":
      return "I’ll move this ahead as a payment support ticket for verification.";

    case "collect_bank_details":
      return "Please provide your bank details so the COD refund can be processed securely.";

    case "initiate_refund":
      return "I’ll move this ahead for refund initiation.";

    case "wait_for_bank_processing":
      return "Please allow the bank or payment provider processing timeline to complete.";

    case "wait_for_quality_check":
      return "Please wait until the quality check is completed. The next step depends on that result.";

    case "wait_for_seller_to_receive_return":
      return "The refund can move ahead once the seller receives the returned product.";

    case "check_cancellation_or_return_status":
      return "Please check whether the cancellation or return request has already been completed.";

    case "create_exchange_request":
      return "I’ll move this ahead for exchange request creation.";

    case "offer_return_if_eligible":
      return "We can check whether this product is eligible for return.";

    case "human_review":
      return "This case needs human review before we can confirm the final action.";

    case "ask_valid_order_id":
      return "Please share a valid order ID so I can check the correct details.";

    case "ask_clarifying_question":
      return "Please share a little more detail so I can guide you correctly.";

    case "fallback_llm_or_human_review":
      return "This request needs additional support review before we can proceed.";

    case "share_tracking_details":
      return "I can share the tracking details for this order.";

    case "wait_until_dispatch":
      return "Tracking details will be available once the order is dispatched.";

    case "no_payment_action_required":
      return "No payment action is required right now.";

    default:
      return result.requiresEscalation
        ? "This should be reviewed by the support team before moving ahead."
        : "No additional action is required right now.";
  }
}

function getDecisionMessage(result) {
  const orderText = formatOrderId(result.orderId);

  switch (result.decision) {
    case "cancel_allowed":
      return `Sure, I can help with that. ${capitalize(orderText)} is eligible for cancellation because it has not been dispatched yet.`;

    case "cancel_allowed_refund_initiated":
      return `Sure, I can help with that. ${capitalize(orderText)} is eligible for cancellation. Since this was a prepaid order, the refund will be processed back to the original payment method.`;

    case "cancel_blocked_dispatched":
      return `I understand you want to cancel this order. However, ${orderText} has already been dispatched, so cancellation is not available at this stage.`;

    case "cancel_blocked_shipped":
      return `I understand you want to cancel this order. However, ${orderText} has already been shipped, so cancellation is not available at this stage.`;

    case "cancel_blocked_out_for_delivery":
      return `I understand you want to cancel this order. However, ${orderText} is already out for delivery, so it cannot be cancelled now.`;

    case "cancel_blocked_delivered":
      return `I understand you want to cancel this order. However, ${orderText} has already been delivered, so cancellation is not possible now.`;

    case "cancel_already_done":
      return `${capitalize(orderText)} is already cancelled.`;

    case "return_allowed":
      return `Sure, I can help with the return. ${capitalize(orderText)} is eligible for return. Pickup and quality check will be required before the refund is processed.`;

    case "return_blocked_not_delivered":
      return `I checked the eligibility for ${orderText}. A return can be requested only after the order is delivered, so it is not eligible for return yet.`;

    case "return_blocked_window_expired":
      return `I checked the eligibility for ${orderText}. Unfortunately, the return window has expired, so a normal return is not available now.`;

    case "return_blocked_non_returnable":
      return `I checked the eligibility for ${orderText}. This product category is non-returnable as per policy, so a normal return is not available.`;

    case "return_blocked_quality_check_failed":
      return `${capitalize(orderText)} cannot be approved automatically because the product may not satisfy the quality-check requirements.`;

    case "return_blocked_altered_product":
      return `${capitalize(orderText)} is not eligible for return because altered products are non-returnable and non-refundable.`;

    case "replacement_allowed":
      return `Sure, I can help with the replacement. ${capitalize(orderText)} is eligible for replacement based on the reported issue and replacement window.`;

    case "replacement_requires_brand_verification":
      return `${capitalize(orderText)} may be eligible for replacement, but brand or service-center verification is required first.`;

    case "replacement_requires_unboxing_proof":
      return `${capitalize(orderText)} may be eligible for replacement, but clear unboxing proof is required first.`;

    case "replacement_requires_doa_certificate":
      return `I’m sorry to hear that the product is not working. ${capitalize(orderText)} may be eligible for DOA replacement, but brand DOA certificate and clear unboxing proof are required before approval.`;

    case "replacement_blocked_window_expired":
      return `I checked the eligibility for ${orderText}. Unfortunately, the replacement window has expired, so replacement is not available now.`;

    case "replacement_blocked_already_replaced":
      return `${capitalize(orderText)} is not eligible for another replacement because one replacement has already been used.`;

    case "replacement_blocked_issue_not_eligible":
      return `I checked ${orderText}. Based on the selected issue type, this product is not eligible for replacement as per policy.`;

    case "refund_initiated":
      return `The refund for ${orderText} has been initiated.`;

    case "refund_completed":
      return `The refund for ${orderText} has already been completed.`;

    case "refund_pending_return_pickup":
      return `The refund for ${orderText} is pending because the return pickup has not been completed yet.`;

    case "refund_pending_return_received":
      return `The refund for ${orderText} is pending because the seller has not received the returned product yet.`;

    case "refund_pending_quality_check":
      return `The refund for ${orderText} is pending because the quality check has not been completed yet.`;

    case "refund_pending_bank_details":
      return `The refund for ${orderText} is pending because bank details are required for the COD refund.`;

    case "refund_discrepancy_escalate":
      return `I can see a refund or payment discrepancy for ${orderText}. This needs support verification before we can confirm the final status.`;

    case "payment_issue_escalate":
      return `I understand this is a payment-related concern. A payment issue has been detected for ${orderText}.`;

    case "cod_not_available":
      return `COD is not available for ${orderText} due to order value or payment policy limits.`;

    case "pan_verification_required":
      return `${capitalize(orderText)} requires PAN verification because it is a very high-value order.`;

    case "payment_method_supported":
      return `The payment method for ${orderText} is supported, and no payment conflict is detected.`;

    case "exchange_allowed":
      return `Sure, I can help with the exchange. ${capitalize(orderText)} is eligible for exchange. Pickup and quality check may be required.`;

    case "exchange_blocked_not_exchangeable":
      return `I checked ${orderText}. This product is not eligible for exchange as per policy.`;

    case "exchange_blocked_stock_unavailable":
      return `${capitalize(orderText)} cannot be exchanged right now because exchange stock is unavailable.`;

    case "exchange_blocked_address_not_serviceable":
      return `${capitalize(orderText)} cannot be exchanged because the address is not serviceable for exchange pickup or delivery.`;

    case "exchange_blocked_window_expired":
      return `I checked the eligibility for ${orderText}. Unfortunately, the exchange window has expired.`;

    case "tracking_available":
      return `Tracking is available for ${orderText}.`;

    case "tracking_not_available":
      return `Tracking is not available for ${orderText} yet. It usually becomes available after dispatch.`;

    case "delivery_failed_escalate":
      return `Delivery failed for ${orderText}. This needs support review so the issue can be checked properly.`;

    case "lost_in_transit_escalate":
      return `${capitalize(orderText)} appears to be lost in transit. This needs escalation so the logistics team can review it.`;

    case "order_not_found":
      return "I couldn’t find this order in our records. Please check the order ID once and share it again.";

    case "missing_order_id":
      return "Sure, I can help you with that. Please share your order ID so I can check the latest status and confirm the next step for you.";

    case "unsupported_intent":
      return "I’m not able to handle this request automatically yet, but I can help with order-related support such as cancellation, returns, refunds, replacement, delivery, and payment issues.";

    case "low_confidence":
      return "I want to make sure I understand your request correctly. Could you please share a little more detail?";

    default:
      return result.reason || "I checked the policy and prepared a decision for this request.";
  }
}

function getStatusLabel(result) {
  if (result.requiresEscalation) return "ESCALATION_REQUIRED";
  if (result.allowed) return "APPROVED";
  return "BLOCKED";
}

function generateResponse(ruleResult) {
  if (!ruleResult) {
    return {
      success: false,
      status: "ERROR",
      message: "Sorry, I couldn’t process this request right now. Please try again in a moment.",
      customerMessage: "Sorry, I couldn’t process this request right now. Please try again in a moment.",
      internal: {
        decision: null,
        allowed: false,
        requiresEscalation: false,
      },
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
    },
  };
}

module.exports = {
  generateResponse,
};