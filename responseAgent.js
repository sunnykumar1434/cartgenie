function formatOrderId(orderId) {
  return orderId ? `Order ${orderId}` : "Your order";
}

function getEscalationNote(result) {
  if (!result.requiresEscalation) return "";

  const triggers = result.escalationTriggers || [];

  if (triggers.includes("payment_conflict")) {
    return " This has been marked for payment support verification.";
  }

  if (triggers.includes("smartphone_doa_claim")) {
    return " This has been marked for specialist verification because it is a DOA-sensitive case.";
  }

  if (triggers.includes("brand_verification_required")) {
    return " Brand/service verification is required before final approval.";
  }

  if (triggers.includes("high_value_order") || triggers.includes("very_high_value_order")) {
    return " Additional verification is required because this is a high-value order.";
  }

  if (triggers.includes("fraud_risk")) {
    return " Manual verification is required before proceeding.";
  }

  return " This case has been marked for support review.";
}

function getNextStepMessage(result) {
  switch (result.nextAction) {
    case "cancel_order_and_initiate_refund":
      return "Next step: we can proceed with cancellation and start the refund process.";

    case "cancel_order":
      return "Next step: we can proceed with cancellation.";

    case "suggest_reject_at_doorstep_or_return_if_eligible":
      return "Next step: you may reject the order at delivery if possible, or check return/replacement eligibility after delivery.";

    case "suggest_reject_at_doorstep":
      return "Next step: you may reject the order at doorstep if the delivery partner allows it.";

    case "suggest_return_or_replacement_if_eligible":
      return "Next step: please check whether this order is eligible for return or replacement.";

    case "create_return_request_and_schedule_pickup":
      return "Next step: we can create a return request and schedule pickup.";

    case "escalate_only_if_exception_claim":
      return "Next step: this can be reviewed further only for valid exceptions such as damaged, wrong, or missing product claims.";

    case "manual_quality_check_review":
      return "Next step: this needs manual quality-check review.";

    case "collect_doa_certificate_and_unboxing_video":
      return "Next step: please provide the brand DOA certificate and clear unboxing proof.";

    case "collect_brand_verification_or_service_center_details":
      return "Next step: please provide brand/service-center verification details.";

    case "collect_unboxing_proof":
      return "Next step: please provide clear unboxing proof.";

    case "create_replacement_request":
      return "Next step: we can create a replacement request.";

    case "create_payment_support_ticket":
      return "Next step: we can create a payment support ticket.";

    case "collect_bank_details":
      return "Next step: please provide bank details to process the COD refund.";

    case "initiate_refund":
      return "Next step: we can initiate the refund.";

    case "wait_for_bank_processing":
      return "Next step: please wait for the bank or payment provider processing timeline.";

    case "wait_for_quality_check":
      return "Next step: please wait until quality check is completed.";

    case "wait_for_seller_to_receive_return":
      return "Next step: the refund can move ahead once the seller receives the returned product.";

    case "check_cancellation_or_return_status":
      return "Next step: please check whether cancellation or return has been completed.";

    case "create_exchange_request":
      return "Next step: we can create an exchange request.";

    case "offer_return_if_eligible":
      return "Next step: we can check return eligibility for this product.";

    case "human_review":
      return "Next step: this case needs human review.";

    case "ask_valid_order_id":
      return "Next step: please share a valid order ID.";

    case "ask_clarifying_question":
      return "Next step: please share a little more detail so I can help correctly.";

    case "fallback_llm_or_human_review":
      return "Next step: this request needs fallback support or human review.";

    case "share_tracking_details":
      return "Next step: we can share the tracking details.";

    case "wait_until_dispatch":
      return "Next step: tracking will be available once the order is dispatched.";

    case "no_payment_action_required":
      return "Next step: no payment action is required right now.";

    default:
      return result.requiresEscalation
        ? "Next step: this case should be reviewed by support."
        : "Next step: no additional action is required right now.";
  }
}

function getDecisionMessage(result) {
  const orderText = formatOrderId(result.orderId);

  switch (result.decision) {
    case "cancel_allowed":
      return `${orderText} is eligible for cancellation because it has not been dispatched yet.`;

    case "cancel_allowed_refund_initiated":
      return `${orderText} is eligible for cancellation. Since it is a prepaid order, refund will be processed to the original payment source.`;

    case "cancel_blocked_dispatched":
      return `${orderText} has already been dispatched, so cancellation is not available now.`;

    case "cancel_blocked_shipped":
      return `${orderText} has already been shipped, so cancellation is not available now.`;

    case "cancel_blocked_out_for_delivery":
      return `${orderText} is already out for delivery, so it cannot be cancelled now.`;

    case "cancel_blocked_delivered":
      return `${orderText} has already been delivered, so cancellation is not possible.`;

    case "cancel_already_done":
      return `${orderText} is already cancelled.`;

    case "return_allowed":
      return `${orderText} is eligible for return. Pickup and quality check will be required before refund.`;

    case "return_blocked_not_delivered":
      return `${orderText} is not eligible for return yet because return can be requested only after delivery.`;

    case "return_blocked_window_expired":
      return `${orderText} is not eligible for return because the return window has expired.`;

    case "return_blocked_non_returnable":
      return `${orderText} is not eligible for return because this product category is non-returnable as per policy.`;

    case "return_blocked_quality_check_failed":
      return `${orderText} cannot be approved automatically because the product may not satisfy quality-check requirements.`;

    case "return_blocked_altered_product":
      return `${orderText} is not eligible for return because altered products are non-returnable and non-refundable.`;

    case "replacement_allowed":
      return `${orderText} is eligible for replacement based on the reported issue and replacement window.`;

    case "replacement_requires_brand_verification":
      return `${orderText} may be eligible for replacement, but brand/service verification is required first.`;

    case "replacement_requires_unboxing_proof":
      return `${orderText} may be eligible for replacement, but clear unboxing proof is required first.`;

    case "replacement_requires_doa_certificate":
      return `${orderText} may be eligible for DOA replacement, but brand DOA certificate and clear unboxing proof are required before approval.`;

    case "replacement_blocked_window_expired":
      return `${orderText} is not eligible for replacement because the replacement window has expired.`;

    case "replacement_blocked_already_replaced":
      return `${orderText} is not eligible for another replacement because one replacement has already been used.`;

    case "replacement_blocked_issue_not_eligible":
      return `${orderText} is not eligible for replacement for the selected issue type.`;

    case "refund_initiated":
      return `Refund for ${orderText} has been initiated.`;

    case "refund_completed":
      return `Refund for ${orderText} has already been completed.`;

    case "refund_pending_return_pickup":
      return `Refund for ${orderText} is pending because return pickup is not completed yet.`;

    case "refund_pending_return_received":
      return `Refund for ${orderText} is pending because the seller has not received the returned product yet.`;

    case "refund_pending_quality_check":
      return `Refund for ${orderText} is pending because quality check is not completed yet.`;

    case "refund_pending_bank_details":
      return `Refund for ${orderText} is pending because bank details are required for COD refund.`;

    case "refund_discrepancy_escalate":
      return `There is a refund or payment discrepancy for ${orderText}. This needs support verification.`;

    case "payment_issue_escalate":
      return `A payment issue has been detected for ${orderText}. This needs verification by the payment support team.`;

    case "cod_not_available":
      return `COD is not available for ${orderText} due to order value or payment policy limits.`;

    case "pan_verification_required":
      return `${orderText} requires PAN verification because it is a very high-value order.`;

    case "payment_method_supported":
      return `The payment method for ${orderText} is supported and no payment conflict is detected.`;

    case "exchange_allowed":
      return `${orderText} is eligible for exchange. Pickup and quality check may be required.`;

    case "exchange_blocked_not_exchangeable":
      return `${orderText} is not eligible for exchange as per policy.`;

    case "exchange_blocked_stock_unavailable":
      return `${orderText} cannot be exchanged right now because exchange stock is unavailable.`;

    case "exchange_blocked_address_not_serviceable":
      return `${orderText} cannot be exchanged because the address is not serviceable for exchange pickup/delivery.`;

    case "exchange_blocked_window_expired":
      return `${orderText} is not eligible for exchange because the exchange window has expired.`;

    case "tracking_available":
      return `Tracking is available for ${orderText}.`;

    case "tracking_not_available":
      return `Tracking is not available for ${orderText} yet. It usually becomes available after dispatch.`;

    case "delivery_failed_escalate":
      return `Delivery failed for ${orderText}. This needs support review.`;

    case "lost_in_transit_escalate":
      return `${orderText} appears to be lost in transit. This needs escalation.`;

    case "order_not_found":
      return "I could not find this order. Please check the order ID and try again.";

    case "missing_order_id":
      return "Please share your order ID so I can check this for you.";

    case "unsupported_intent":
      return "I’m not able to handle this request automatically yet.";

    case "low_confidence":
      return "I need a little more information to understand your request correctly.";

    default:
      return result.reason || "I checked the policy and prepared a decision for this request.";
  }
}

function getStatusLabel(result) {
  if (result.requiresEscalation) return "ESCALATION_REQUIRED";
  if (result.allowed) return "APPROVED";
  return "BLOCKED";
}

function cleanMessage(message) {
  return message
    .replace(/\s+/g, " ")
    .replace(/\s+\./g, ".")
    .trim();
}

function generateResponse(ruleResult) {
  if (!ruleResult) {
    return {
      success: false,
      status: "ERROR",
      message: "Sorry, I could not process this request right now.",
      customerMessage: "Sorry, I could not process this request right now.",
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
      rawReason: ruleResult.reason
    }
  };
}

module.exports = {
  generateResponse
};