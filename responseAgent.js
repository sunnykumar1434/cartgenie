"use strict";

/**
 * responseAgent.js
 *
 * Converts ruleEngine decisions into clear, polite customer-facing messages.
 *
 * Goals:
 * - No "order null" / "undefined" in responses.
 * - Status-aware tracking responses.
 * - Reorder should never sound like cancel/return.
 * - Cancellation eligibility asks confirmation, not fake execution.
 * - Demo-safe wording for sensitive actions.
 * - Softer, more user-friendly tone.
 */

// =====================================================
// HELPERS
// =====================================================

function safe(value, fallback = "") {
  if (value === undefined || value === null) return fallback;
  return String(value);
}

function normalizeText(value = "") {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, "_");
}

function normalizeLooseText(value = "") {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function displayStatus(value = "") {
  const raw = safe(value, "Unknown");

  return raw
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function getOrderId(ruleResult = {}) {
  return ruleResult.orderId || ruleResult.order?.orderId || null;
}

function getTrackingId(ruleResult = {}) {
  return (
    ruleResult.trackingId ||
    ruleResult.order?.trackingId ||
    ruleResult.order?.awb ||
    ruleResult.order?.shipmentId ||
    ruleResult.order?.courierTrackingId ||
    null
  );
}

function getStatus(ruleResult = {}) {
  return (
    ruleResult.displayStatus ||
    displayStatus(ruleResult.orderStatus || ruleResult.order?.status || "Unknown")
  );
}

function hasValue(value) {
  return value !== undefined && value !== null && String(value).trim() !== "";
}

function buildResponse({
  status = "INFO",
  message,
  customerMessage,
  suggestedActions = [],
  metadata = {},
}) {
  const finalMessage =
    customerMessage ||
    message ||
    "I’m sorry, I could not generate a proper response. Please try again.";

  return {
    success: true,
    status,
    message: finalMessage,
    customerMessage: finalMessage,
    suggestedActions,
    metadata,
  };
}

function orderNotFoundMessage(ruleResult = {}) {
  const orderId = getOrderId(ruleResult);

  if (orderId) {
    return `I’m sorry, I could not find order ${orderId} in the demo records. Please check the order ID once and share it again.`;
  }

  return "I’m sorry, I could not find a valid order ID in your message. Please share an order ID like ORD101 so I can check it for you.";
}

function appendTrackingDetails(ruleResult = {}) {
  const pieces = [];

  if (hasValue(ruleResult.courierPartner)) {
    pieces.push(`Courier: ${ruleResult.courierPartner}`);
  }

  if (hasValue(ruleResult.currentLocation)) {
    pieces.push(`Current location: ${ruleResult.currentLocation}`);
  }

  if (hasValue(ruleResult.estimatedDelivery)) {
    pieces.push(`Estimated delivery: ${ruleResult.estimatedDelivery}`);
  }

  if (hasValue(ruleResult.lastTrackingUpdate)) {
    pieces.push(`Last update: ${ruleResult.lastTrackingUpdate}`);
  }

  if (hasValue(ruleResult.shipmentStatusNote)) {
    pieces.push(ruleResult.shipmentStatusNote);
  }

  if (hasValue(ruleResult.trackingUrl)) {
    pieces.push(`Tracking link: ${ruleResult.trackingUrl}`);
  }

  if (pieces.length === 0) return "";

  return ` ${pieces.join(". ")}.`;
}

function refundTimelineText(ruleResult = {}) {
  if (!ruleResult.refundRequired) return "";

  return " Since this appears to be a prepaid/payment-related case, refund processing will follow the payment method timeline.";
}

// =====================================================
// TRACKING / STATUS RESPONSES
// =====================================================

function trackingResponse(ruleResult = {}) {
  const orderId = getOrderId(ruleResult);
  const trackingId = getTrackingId(ruleResult);
  const status = getStatus(ruleResult);
  const decision = ruleResult.decision;

  if (!orderId) {
    return buildResponse({
      status: "ORDER_NOT_FOUND",
      message: orderNotFoundMessage(ruleResult),
    });
  }

  if (decision === "tracking_cancelled_order") {
    return buildResponse({
      status: "CANCELLED",
      message: `I checked order ${orderId}. This order is cancelled, so tracking is not available now.`,
      suggestedActions: ["Check refund status", "Start a new query"],
    });
  }

  if (decision === "tracking_returned_or_refunded") {
    return buildResponse({
      status: "RETURNED_OR_REFUNDED",
      message: `I checked order ${orderId}. Current status: ${status}. This order has already reached a return/refund stage, so shipment tracking may no longer show active movement.`,
      suggestedActions: ["Check refund status", "Contact support"],
    });
  }

  if (decision === "tracking_lost_in_transit") {
    return buildResponse({
      status: "ESCALATION_REQUIRED",
      message: `I checked order ${orderId}. The shipment appears to be lost in transit or has no reliable movement update. I’ll mark this for support review so the team can check it carefully.`,
      suggestedActions: ["Human support review"],
      metadata: {
        requiresEscalation: true,
      },
    });
  }

  if (decision === "tracking_delayed") {
    const trackText = trackingId ? ` Tracking ID: ${trackingId}.` : "";
    return buildResponse({
      status: "DELAYED",
      message: `I checked order ${orderId}. Current status: ${status}.${trackText} The shipment looks delayed, so I’ll keep this marked for support review if the delay continues.${appendTrackingDetails(
        ruleResult
      )}`,
      suggestedActions: ["Track again later", "Contact support"],
      metadata: {
        requiresEscalation: true,
      },
    });
  }

  if (decision === "tracking_out_for_delivery") {
    const trackText = trackingId ? ` Tracking ID: ${trackingId}.` : "";
    return buildResponse({
      status: "OUT_FOR_DELIVERY",
      message: `I checked order ${orderId}. Current status: Out For Delivery.${trackText} Your order should be delivered soon, usually by the end of the delivery day.${appendTrackingDetails(
        ruleResult
      )}`,
      suggestedActions: ["Wait for delivery", "Contact delivery support"],
    });
  }

  if (decision === "tracking_delivered") {
    const trackText = trackingId ? ` Tracking ID: ${trackingId}.` : "";
    return buildResponse({
      status: "DELIVERED",
      message: `I checked order ${orderId}. Current status: Delivered.${trackText} If you have any issue with the product, I can help check return, replacement, or exchange eligibility.`,
      suggestedActions: ["Return", "Replacement", "Exchange"],
    });
  }

  if (decision === "tracking_shipped") {
    const trackText = trackingId ? ` Tracking ID: ${trackingId}.` : "";
    return buildResponse({
      status: "SHIPPED",
      message: `I checked order ${orderId}. Current status: Shipped.${trackText} Your order is on the way.${appendTrackingDetails(
        ruleResult
      )}`,
      suggestedActions: ["Track again later", "Check delivery status"],
    });
  }

  if (decision === "tracking_available_pre_dispatch") {
    const trackText = trackingId ? ` Tracking ID: ${trackingId}.` : "";
    return buildResponse({
      status: "PROCESSING",
      message: `I checked order ${orderId}. Current status: ${status}.${trackText} The order has not fully moved into shipment yet, so courier updates may appear after dispatch.${appendTrackingDetails(
        ruleResult
      )}`,
      suggestedActions: ["Track again later", "Cancel if eligible"],
    });
  }

  if (decision === "tracking_not_available_pre_dispatch") {
    return buildResponse({
      status: "PROCESSING",
      message: `I checked order ${orderId}. Current status: ${status}. Tracking is not available yet because the order has not been dispatched. Tracking details usually become available after dispatch.`,
      suggestedActions: ["Track later", "Cancel if eligible"],
    });
  }

  if (trackingId) {
    return buildResponse({
      status: "TRACKING_AVAILABLE",
      message: `I checked order ${orderId}. Current status: ${status}. Tracking ID: ${trackingId}.${appendTrackingDetails(
        ruleResult
      )}`,
      suggestedActions: ["Track again later", "Contact support"],
    });
  }

  return buildResponse({
    status: "TRACKING_UNAVAILABLE",
    message: `I checked order ${orderId}. Current status: ${status}. Tracking is not available for this order right now. If this looks incorrect, I can mark it for support review.`,
    suggestedActions: ["Contact support", "Try again later"],
  });
}

// =====================================================
// CANCELLATION RESPONSES
// =====================================================

function cancellationResponse(ruleResult = {}) {
  const orderId = getOrderId(ruleResult);
  const status = getStatus(ruleResult);
  const decision = ruleResult.decision;

  if (!orderId) {
    return buildResponse({
      status: "ORDER_NOT_FOUND",
      message: orderNotFoundMessage(ruleResult),
    });
  }

  if (decision === "already_cancelled") {
    return buildResponse({
      status: "ALREADY_CANCELLED",
      message: `I checked order ${orderId}. This order is already cancelled.${refundTimelineText(
        ruleResult
      )}`,
      suggestedActions: ["Check refund status", "Start new query"],
    });
  }

  if (decision === "cancellation_not_allowed_delivered") {
    return buildResponse({
      status: "NOT_ALLOWED",
      message: `I checked order ${orderId}. It has already been delivered, so cancellation is not available now. If there is a product issue, I can help check return, replacement, or exchange eligibility.`,
      suggestedActions: ["Return", "Replacement", "Exchange"],
    });
  }

  if (decision === "cancellation_not_allowed_shipped") {
    return buildResponse({
      status: "NOT_ALLOWED",
      message: `I understand you want to cancel this order. I checked order ${orderId}, and it has already been ${status.toLowerCase()}, so cancellation is not available at this stage. You may reject the delivery if that option is available. After delivery, I can also help check return, replacement, or exchange eligibility.`,
      suggestedActions: ["Track order", "Check return eligibility", "Check replacement eligibility"],
    });
  }

  if (decision === "cancellation_manual_review_required") {
    return buildResponse({
      status: "ESCALATION_REQUIRED",
      message: `I checked order ${orderId}. Cancellation needs manual support review because the current shipment status is ${status}. I’ll mark this for support review before moving ahead.${refundTimelineText(
        ruleResult
      )}`,
      suggestedActions: ["Human support review"],
      metadata: {
        requiresEscalation: true,
      },
    });
  }

  if (decision === "cancellation_confirmation_required") {
    return buildResponse({
      status: "CONFIRMATION_REQUIRED",
      message: `Sure, I checked this for you. Order ${orderId} is eligible for cancellation because it has not been dispatched yet. Would you like me to confirm the cancellation request now?`,
      suggestedActions: ["Yes, cancel it", "No, do not cancel"],
      metadata: {
        pendingAction: "confirm_cancel_order",
        orderId,
      },
    });
  }

  if (decision === "cancellation_status_manual_review") {
    return buildResponse({
      status: "ESCALATION_REQUIRED",
      message: `I checked order ${orderId}. The current status is ${status}, so cancellation eligibility needs manual review. I’ll mark this for support review.`,
      suggestedActions: ["Human support review"],
      metadata: {
        requiresEscalation: true,
      },
    });
  }

  return buildResponse({
    status: "INFO",
    message: `I checked order ${orderId}. Current status: ${status}. I could not clearly confirm cancellation eligibility, so this should be reviewed by support.`,
    suggestedActions: ["Human support review"],
  });
}

// =====================================================
// RETURN RESPONSES
// =====================================================

function returnResponse(ruleResult = {}) {
  const orderId = getOrderId(ruleResult);
  const decision = ruleResult.decision;

  if (!orderId) {
    return buildResponse({
      status: "ORDER_NOT_FOUND",
      message: orderNotFoundMessage(ruleResult),
    });
  }

  if (decision === "return_not_allowed_cancelled") {
    return buildResponse({
      status: "NOT_ALLOWED",
      message: `I checked order ${orderId}. Since this order is cancelled, a return request is not applicable.`,
      suggestedActions: ["Check refund status", "Start new query"],
    });
  }

  if (decision === "return_not_allowed_before_delivery") {
    return buildResponse({
      status: "NOT_ALLOWED",
      message: `I checked order ${orderId}. A return can be requested only after the order is delivered, so it is not eligible for return yet. Please wait until delivery. After delivery, I can help check return, replacement, or exchange eligibility based on policy.`,
      suggestedActions: ["Track order", "Check again after delivery"],
    });
  }

  if (decision === "return_not_allowed_policy") {
    return buildResponse({
      status: "NOT_ALLOWED",
      message: `I checked order ${orderId}. This item is not returnable as per policy. If there is a defect or damage issue, I can help check replacement or support review options.`,
      suggestedActions: ["Replacement", "Human support"],
    });
  }

  if (decision === "return_window_expired") {
    return buildResponse({
      status: "NOT_ALLOWED",
      message: `I checked order ${orderId}. The return window has expired, so a normal return request is not available. If there is an exceptional issue, I can mark it for support review.`,
      suggestedActions: ["Human support review"],
    });
  }

  if (decision === "return_eligible") {
    return buildResponse({
      status: "ELIGIBLE",
      message: `I checked order ${orderId}. This order looks eligible for return. In a real integrated system, I would ask for confirmation and then create a return request.`,
      suggestedActions: ["Confirm return request", "Ask return policy"],
    });
  }

  return buildResponse({
    status: "INFO",
    message: `I checked order ${orderId}. I could not clearly confirm return eligibility, so I can mark this for support review if needed.`,
    suggestedActions: ["Human support review"],
  });
}

// =====================================================
// REPLACEMENT RESPONSES
// =====================================================

function replacementResponse(ruleResult = {}) {
  const orderId = getOrderId(ruleResult);
  const decision = ruleResult.decision;

  if (!orderId) {
    return buildResponse({
      status: "ORDER_NOT_FOUND",
      message: orderNotFoundMessage(ruleResult),
    });
  }

  if (decision === "replacement_not_allowed_cancelled") {
    return buildResponse({
      status: "NOT_ALLOWED",
      message: `I checked order ${orderId}. Since this order is cancelled, replacement is not applicable.`,
      suggestedActions: ["Check refund status", "Start new query"],
    });
  }

  if (decision === "replacement_not_allowed_before_delivery") {
    return buildResponse({
      status: "NOT_ALLOWED",
      message: `I checked order ${orderId}. Replacement can be requested only after the order is delivered. Please wait until delivery, and then I can help check replacement eligibility based on policy.`,
      suggestedActions: ["Track order", "Check again after delivery"],
    });
  }

  if (decision === "replacement_not_allowed_policy") {
    return buildResponse({
      status: "NOT_ALLOWED",
      message: `I checked order ${orderId}. This item is not eligible for replacement as per policy. If needed, I can help check return/exchange options or mark it for support review.`,
      suggestedActions: ["Return", "Exchange", "Human support"],
    });
  }

  if (decision === "replacement_window_expired") {
    return buildResponse({
      status: "NOT_ALLOWED",
      message: `I checked order ${orderId}. The replacement window has expired. If there is an exceptional issue, I can mark this for support review.`,
      suggestedActions: ["Human support review"],
    });
  }

  if (decision === "replacement_eligible") {
    return buildResponse({
      status: "ELIGIBLE",
      message: `I checked order ${orderId}. This order looks eligible for replacement. In a real integrated system, I would ask for confirmation and then create a replacement request.`,
      suggestedActions: ["Confirm replacement request"],
    });
  }

  return buildResponse({
    status: "INFO",
    message: `I checked order ${orderId}. I could not clearly confirm replacement eligibility, so I can mark this for support review if needed.`,
    suggestedActions: ["Human support review"],
  });
}

// =====================================================
// EXCHANGE RESPONSES
// =====================================================

function exchangeResponse(ruleResult = {}) {
  const orderId = getOrderId(ruleResult);
  const decision = ruleResult.decision;

  if (!orderId) {
    return buildResponse({
      status: "ORDER_NOT_FOUND",
      message: orderNotFoundMessage(ruleResult),
    });
  }

  if (decision === "exchange_not_allowed_cancelled") {
    return buildResponse({
      status: "NOT_ALLOWED",
      message: `I checked order ${orderId}. Since this order is cancelled, exchange is not applicable.`,
      suggestedActions: ["Check refund status", "Start new query"],
    });
  }

  if (decision === "exchange_not_allowed_before_delivery") {
    return buildResponse({
      status: "NOT_ALLOWED",
      message: `I checked order ${orderId}. Exchange can be requested only after the order is delivered. Please wait until delivery, and then I can help check return, replacement, or exchange eligibility based on policy.`,
      suggestedActions: ["Track order", "Check again after delivery"],
    });
  }

  if (decision === "exchange_not_allowed_policy") {
    return buildResponse({
      status: "NOT_ALLOWED",
      message: `I checked order ${orderId}. This item is not exchangeable as per policy. I can help check return/replacement options if applicable.`,
      suggestedActions: ["Return", "Replacement"],
    });
  }

  if (decision === "exchange_window_expired") {
    return buildResponse({
      status: "NOT_ALLOWED",
      message: `I checked order ${orderId}. The exchange window has expired. If there is an exceptional issue, I can mark this for support review.`,
      suggestedActions: ["Human support review"],
    });
  }

  if (decision === "exchange_eligible") {
    return buildResponse({
      status: "ELIGIBLE",
      message: `I checked order ${orderId}. This order looks eligible for exchange. In a real integrated system, I would ask for confirmation and then create an exchange request.`,
      suggestedActions: ["Confirm exchange request"],
    });
  }

  return buildResponse({
    status: "INFO",
    message: `I checked order ${orderId}. I could not clearly confirm exchange eligibility, so I can mark this for support review if needed.`,
    suggestedActions: ["Human support review"],
  });
}

// =====================================================
// REORDER RESPONSES
// =====================================================

function reorderResponse(ruleResult = {}) {
  const orderId = getOrderId(ruleResult);
  const decision = ruleResult.decision;
  const status = getStatus(ruleResult);

  if (!orderId) {
    return buildResponse({
      status: "ORDER_NOT_FOUND",
      message: orderNotFoundMessage(ruleResult),
    });
  }

  if (decision === "reorder_allowed_delivered") {
    return buildResponse({
      status: "REORDER_GUIDANCE",
      message: `I checked order ${orderId}. This order has already been delivered, so you can place a fresh order for the same product if it is still available. You can usually do that from your order history or product page.`,
      suggestedActions: ["Place fresh order", "Check product availability"],
    });
  }

  if (decision === "reorder_allowed_cancelled") {
    return buildResponse({
      status: "REORDER_GUIDANCE",
      message: `I checked order ${orderId}. This order was cancelled, so you can place a fresh order for the same product if it is still available.`,
      suggestedActions: ["Place fresh order", "Check refund status"],
    });
  }

  if (decision === "reorder_allowed_returned_refunded") {
    return buildResponse({
      status: "REORDER_GUIDANCE",
      message: `I checked order ${orderId}. Since the previous order was returned/refunded, you can place a fresh order for the same product if it is still available.`,
      suggestedActions: ["Place fresh order"],
    });
  }

  if (decision === "reorder_not_needed_out_for_delivery") {
    return buildResponse({
      status: "ACTIVE_ORDER",
      message: `I checked order ${orderId}. It is currently out for delivery, so reorder is not needed for the same order yet. If you want an additional quantity, you can place a fresh order from the product page.`,
      suggestedActions: ["Track order", "Place fresh order"],
    });
  }

  if (decision === "reorder_not_needed_shipped") {
    return buildResponse({
      status: "ACTIVE_ORDER",
      message: `I checked order ${orderId}. It is currently shipped and still on the way, so reorder is not needed for the same order yet. If you want another quantity, you can place a fresh order from the product page.`,
      suggestedActions: ["Track order", "Place fresh order"],
    });
  }

  if (decision === "reorder_not_needed_active_order") {
    return buildResponse({
      status: "ACTIVE_ORDER",
      message: `I checked order ${orderId}. Current status: ${status}. This order is still active, so reorder is not needed for the same order yet. If you want another quantity, you can place a fresh order separately.`,
      suggestedActions: ["Track order", "Cancel if eligible", "Place fresh order"],
    });
  }

  return buildResponse({
    status: "REORDER_GUIDANCE",
    message: `I checked order ${orderId}. You can place a fresh order for the same product if it is still available. You can usually do this from the product page or order history.`,
    suggestedActions: ["Place fresh order"],
  });
}

// =====================================================
// REFUND RESPONSES
// =====================================================

function refundResponse(ruleResult = {}) {
  const orderId = getOrderId(ruleResult);
  const decision = ruleResult.decision;
  const status = getStatus(ruleResult);

  if (!orderId) {
    return buildResponse({
      status: "ORDER_NOT_FOUND",
      message: orderNotFoundMessage(ruleResult),
    });
  }

  if (decision === "refund_expected_after_cancellation") {
    return buildResponse({
      status: "REFUND_PROCESSING",
      message: `I checked order ${orderId}. Since this order is cancelled and appears prepaid, the refund should be processed as per the payment method timeline. If it takes longer than expected, I can mark it for support review.`,
      suggestedActions: ["Contact support", "Check again later"],
    });
  }

  if (decision === "refund_completed_or_returned") {
    return buildResponse({
      status: "REFUND_STATUS",
      message: `I checked order ${orderId}. Current status: ${status}. The order is already in a returned/refunded stage. If you have not received the refund, I can mark it for support/payment review.`,
      suggestedActions: ["Payment support review"],
    });
  }

  if (decision === "refund_status_available") {
    return buildResponse({
      status: "REFUND_STATUS",
      message: `I checked order ${orderId}. Refund status: ${status}. If this does not match your bank/payment statement, I can mark it for support review.`,
      suggestedActions: ["Payment support review"],
    });
  }

  if (decision === "refund_payment_review_required") {
    return buildResponse({
      status: "ESCALATION_REQUIRED",
      message: `I checked order ${orderId}. The refund/payment state needs support review. I’ll mark this for the payment support team to check carefully.`,
      suggestedActions: ["Payment support review"],
      metadata: {
        requiresEscalation: true,
      },
    });
  }

  if (decision === "refund_not_applicable_yet") {
    return buildResponse({
      status: "NOT_APPLICABLE_YET",
      message: `I checked order ${orderId}. A refund is usually applicable after cancellation, return, or payment failure confirmation. Right now, I don’t see a clear refund trigger for this order. If you believe money was deducted or refund is pending, I can mark it for support review.`,
      suggestedActions: ["Payment support review", "Check cancellation/return"],
    });
  }

  return buildResponse({
    status: "INFO",
    message: `I checked order ${orderId}. I could not clearly confirm refund status, so I can mark this for payment support review if needed.`,
    suggestedActions: ["Payment support review"],
  });
}

// =====================================================
// PAYMENT / DELIVERY / ITEM ISSUE RESPONSES
// =====================================================

function paymentIssueResponse(ruleResult = {}) {
  const orderId = getOrderId(ruleResult);

  if (!orderId) {
    return buildResponse({
      status: "ORDER_NOT_FOUND",
      message: orderNotFoundMessage(ruleResult),
    });
  }

  return buildResponse({
    status: "ESCALATION_REQUIRED",
    message: `I checked order ${orderId}. Payment issues such as double charge, money deducted, or failed transaction need payment team review. I’ll mark this for support review so the team can verify the transaction safely.`,
    suggestedActions: ["Payment support review"],
    metadata: {
      requiresEscalation: true,
    },
  });
}

function deliveryIssueResponse(ruleResult = {}) {
  const orderId = getOrderId(ruleResult);
  const decision = ruleResult.decision;
  const status = getStatus(ruleResult);
  const trackingId = getTrackingId(ruleResult);

  if (!orderId) {
    return buildResponse({
      status: "ORDER_NOT_FOUND",
      message: orderNotFoundMessage(ruleResult),
    });
  }

  if (decision === "delivery_lost_in_transit") {
    return buildResponse({
      status: "ESCALATION_REQUIRED",
      message: `I checked order ${orderId}. The shipment appears to be lost in transit. I’ll mark this for urgent support review so the team can investigate with the courier.`,
      suggestedActions: ["Human support review"],
      metadata: {
        requiresEscalation: true,
      },
    });
  }

  if (decision === "delivery_delayed") {
    return buildResponse({
      status: "DELAYED",
      message: `I checked order ${orderId}. Current status: Delayed.${
        trackingId ? ` Tracking ID: ${trackingId}.` : ""
      } I’ll keep this marked for support review if the delay continues.${appendTrackingDetails(
        ruleResult
      )}`,
      suggestedActions: ["Track again later", "Human support review"],
      metadata: {
        requiresEscalation: true,
      },
    });
  }

  if (decision === "delivery_out_for_delivery") {
    return buildResponse({
      status: "OUT_FOR_DELIVERY",
      message: `I checked order ${orderId}. It is out for delivery and should reach you soon.${appendTrackingDetails(
        ruleResult
      )}`,
      suggestedActions: ["Wait for delivery", "Contact delivery support"],
    });
  }

  if (decision === "delivery_delivered") {
    return buildResponse({
      status: "DELIVERED",
      message: `I checked order ${orderId}. It is marked as delivered. If you did not receive it or there is an issue with the product, I can mark it for support review.`,
      suggestedActions: ["Report delivery issue", "Return/Replacement"],
    });
  }

  return buildResponse({
    status: "DELIVERY_STATUS",
    message: `I checked order ${orderId}. Current delivery status: ${status}.${appendTrackingDetails(
      ruleResult
    )}`,
    suggestedActions: ["Track order", "Contact support"],
  });
}

function itemIssueResponse(ruleResult = {}) {
  const orderId = getOrderId(ruleResult);
  const issueType = ruleResult.issueType || "item issue";
  const decision = ruleResult.decision;

  if (!orderId) {
    return buildResponse({
      status: "ORDER_NOT_FOUND",
      message: orderNotFoundMessage(ruleResult),
    });
  }

  if (decision && decision.includes("not_allowed_before_delivery")) {
    return buildResponse({
      status: "NOT_ALLOWED_YET",
      message: `I checked order ${orderId}. This type of ${issueType.replace(
        /_/g,
        " "
      )} issue is usually raised after delivery. If the shipment itself looks incorrect, I can mark it for support review.`,
      suggestedActions: ["Track order", "Human support review"],
    });
  }

  return buildResponse({
    status: "ESCALATION_REQUIRED",
    message: `I checked order ${orderId}. This looks like a ${issueType.replace(
      /_/g,
      " "
    )} issue, so I’ll mark it for support review to avoid giving you the wrong next step.`,
    suggestedActions: ["Human support review"],
    metadata: {
      requiresEscalation: true,
    },
  });
}

// =====================================================
// UNSUPPORTED / FALLBACK RESPONSES
// =====================================================

function unsupportedIntentResponse(ruleResult = {}) {
  return buildResponse({
    status: "CLARIFICATION_REQUIRED",
    message:
      "I can help with order tracking, cancellation, returns, refunds, replacement, exchange, reorder, delivery, and payment issues. Please share your order-related concern, and if it is about a specific order, include the order ID like ORD101.",
    suggestedActions: ["Track order", "Cancel order", "Refund status"],
  });
}

// =====================================================
// MAIN GENERATOR
// =====================================================

function generateResponse(ruleResult = {}) {
  if (!ruleResult || typeof ruleResult !== "object") {
    return buildResponse({
      status: "INFO",
      message:
        "I’m sorry, I could not process that properly. Please share your order-related concern again, and include the order ID if available.",
    });
  }

  if (ruleResult.decision === "order_not_found") {
    return buildResponse({
      status: "ORDER_NOT_FOUND",
      message: orderNotFoundMessage(ruleResult),
    });
  }

  const intent = ruleResult.intent;

  switch (intent) {
    case "track_order":
      return trackingResponse(ruleResult);

    case "cancel_order":
      return cancellationResponse(ruleResult);

    case "return_order":
      return returnResponse(ruleResult);

    case "replace_order":
      return replacementResponse(ruleResult);

    case "exchange_order":
      return exchangeResponse(ruleResult);

    case "reorder_order":
      return reorderResponse(ruleResult);

    case "refund_status":
      return refundResponse(ruleResult);

    case "payment_issue":
      return paymentIssueResponse(ruleResult);

    case "delivery_issue":
      return deliveryIssueResponse(ruleResult);

    case "missing_item":
    case "wrong_item":
    case "damaged_item":
      return itemIssueResponse(ruleResult);

    default:
      return unsupportedIntentResponse(ruleResult);
  }
}

// =====================================================
// COMPATIBILITY ALIASES
// =====================================================

function buildCustomerResponse(ruleResult = {}) {
  return generateResponse(ruleResult);
}

function createResponse(ruleResult = {}) {
  return generateResponse(ruleResult);
}

function respond(ruleResult = {}) {
  return generateResponse(ruleResult);
}

module.exports = {
  generateResponse,
  buildCustomerResponse,
  createResponse,
  respond,

  trackingResponse,
  cancellationResponse,
  returnResponse,
  replacementResponse,
  exchangeResponse,
  reorderResponse,
  refundResponse,
  paymentIssueResponse,
  deliveryIssueResponse,
  itemIssueResponse,
};