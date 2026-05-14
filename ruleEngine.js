"use strict";

/**
 * ruleEngine.js
 *
 * CartGenie deterministic business rule engine.
 *
 * Responsibilities:
 * - Validate order-based intents using order status + policy fields.
 * - Keep eligibility checks separate from action execution.
 * - Return structured decisions for responseAgent.
 * - Support:
 *   track/status by order ID or tracking ID
 *   cancel eligibility + confirmation requirement
 *   return/replacement/exchange eligibility
 *   refund/payment escalation
 *   reorder status-aware guidance
 *   delivery/lost/delayed handling
 */

const CANCELLABLE_STATUSES = new Set([
  "placed",
  "confirmed",
  "processing",
  "pending",
]);

const ACTIVE_NOT_DELIVERED_STATUSES = new Set([
  "placed",
  "confirmed",
  "processing",
  "packed",
  "ready_to_ship",
  "shipped",
  "in_transit",
  "out_for_delivery",
]);

const SHIPPED_STATUSES = new Set([
  "shipped",
  "in_transit",
]);

const DELIVERED_STATUSES = new Set([
  "delivered",
  "completed",
]);

const TERMINAL_CANCELLED_STATUSES = new Set([
  "cancelled",
  "canceled",
]);

const RETURNED_OR_REFUNDED_STATUSES = new Set([
  "returned",
  "return_completed",
  "refunded",
  "refund_completed",
]);

const DELAYED_STATUSES = new Set([
  "delayed",
  "delivery_delayed",
]);

const LOST_STATUSES = new Set([
  "lost",
  "lost_in_transit",
]);

const OUT_FOR_DELIVERY_STATUSES = new Set([
  "out_for_delivery",
  "ofd",
]);

const RETURN_WINDOW_DAYS = 7;
const EXCHANGE_WINDOW_DAYS = 7;
const REPLACEMENT_WINDOW_DAYS = 7;

// =====================================================
// HELPERS
// =====================================================

function normalizeText(value = "") {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, "_");
}

function normalizeLooseText(value = "") {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function toBool(value, fallback = false) {
  if (typeof value === "boolean") return value;
  if (value === undefined || value === null) return fallback;

  const clean = normalizeLooseText(value);

  if (["true", "yes", "y", "1", "allowed", "eligible"].includes(clean)) {
    return true;
  }

  if (["false", "no", "n", "0", "blocked", "not eligible"].includes(clean)) {
    return false;
  }

  return fallback;
}

function getOrderId(order) {
  return order?.orderId || order?.id || null;
}

function getTrackingId(order) {
  return (
    order?.trackingId ||
    order?.awb ||
    order?.shipmentId ||
    order?.courierTrackingId ||
    null
  );
}

function getStatus(order) {
  return normalizeText(order?.status || order?.orderStatus || "unknown");
}

function getDisplayStatus(order) {
  const raw = order?.status || order?.orderStatus || "Unknown";
  return String(raw)
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function getPaymentMethod(order) {
  return normalizeText(order?.paymentMethod || order?.paymentMode || "");
}

function getPaymentStatus(order) {
  return normalizeText(order?.paymentStatus || "");
}

function isPrepaid(order) {
  const method = getPaymentMethod(order);
  const paymentStatus = getPaymentStatus(order);

  if (
    ["paid", "successful", "success", "captured"].includes(paymentStatus)
  ) {
    return true;
  }

  return [
    "upi",
    "card",
    "credit_card",
    "debit_card",
    "netbanking",
    "wallet",
    "pay_later",
    "emi",
  ].includes(method);
}

function getDeliveryDaysAgo(order) {
  const raw =
    order?.deliveryDaysAgo ??
    order?.daysSinceDelivery ??
    order?.deliveredDaysAgo ??
    null;

  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function isWithinWindow(daysAgo, windowDays) {
  if (daysAgo === null || daysAgo === undefined) return true;
  return Number(daysAgo) <= windowDays;
}

function isDelivered(order) {
  return DELIVERED_STATUSES.has(getStatus(order));
}

function isCancelled(order) {
  return TERMINAL_CANCELLED_STATUSES.has(getStatus(order));
}

function isReturnedOrRefunded(order) {
  return RETURNED_OR_REFUNDED_STATUSES.has(getStatus(order));
}

function isCancellable(order) {
  return CANCELLABLE_STATUSES.has(getStatus(order));
}

function isActiveNotDelivered(order) {
  return ACTIVE_NOT_DELIVERED_STATUSES.has(getStatus(order));
}

function isShipped(order) {
  return SHIPPED_STATUSES.has(getStatus(order));
}

function isOutForDelivery(order) {
  return OUT_FOR_DELIVERY_STATUSES.has(getStatus(order));
}

function isDelayed(order) {
  return DELAYED_STATUSES.has(getStatus(order));
}

function isLost(order) {
  return LOST_STATUSES.has(getStatus(order));
}

function buildBaseResult({ intent, order, issueType = "general" }) {
  return {
    intent,
    issueType,

    order,
    orderId: getOrderId(order),
    trackingId: getTrackingId(order),
    orderStatus: getStatus(order),
    displayStatus: getDisplayStatus(order),

    allowed: false,
    decision: "unknown",
    status: "UNKNOWN",

    refundRequired: false,
    requiresEscalation: false,
    escalationTriggers: [],

    nextAction: null,
    reason: null,
    policy: null,

    courierPartner: order?.courierPartner || order?.courier || null,
    currentLocation:
      order?.currentLocation ||
      order?.lastKnownLocation ||
      order?.location ||
      order?.hub ||
      null,
    estimatedDelivery:
      order?.estimatedDelivery ||
      order?.eta ||
      order?.expectedDelivery ||
      null,
    lastTrackingUpdate:
      order?.lastTrackingUpdate ||
      order?.lastUpdated ||
      order?.trackingUpdatedAt ||
      null,
    trackingUrl:
      order?.trackingUrl ||
      order?.trackingLink ||
      null,
    shipmentStatusNote:
      order?.shipmentStatusNote ||
      order?.statusNote ||
      null,
  };
}

function orderNotFound(intent, issueType = "general") {
  return {
    intent,
    issueType,
    order: null,
    orderId: null,
    trackingId: null,
    orderStatus: null,
    displayStatus: null,

    allowed: false,
    decision: "order_not_found",
    status: "ORDER_NOT_FOUND",

    refundRequired: false,
    requiresEscalation: false,
    escalationTriggers: [],

    nextAction: "ask_valid_order_id",
    reason:
      "Order was not found in the available demo records.",
    policy: null,
  };
}

function addEscalation(result, trigger, priority = "MEDIUM") {
  result.requiresEscalation = true;
  result.escalationTriggers = Array.from(
    new Set([...(result.escalationTriggers || []), trigger])
  );
  result.priority = result.priority || priority;
  return result;
}

// =====================================================
// TRACKING / STATUS
// =====================================================

function evaluateTracking(order, issueType = "tracking") {
  if (!order) return orderNotFound("track_order", issueType);

  const result = buildBaseResult({
    intent: "track_order",
    order,
    issueType,
  });

  const status = getStatus(order);
  const trackingId = getTrackingId(order);

  if (isCancelled(order)) {
    return {
      ...result,
      allowed: false,
      decision: "tracking_cancelled_order",
      status: "CANCELLED",
      nextAction: "no_tracking_cancelled_order",
      reason:
        "The order is cancelled, so tracking is not available.",
    };
  }

  if (isReturnedOrRefunded(order)) {
    return {
      ...result,
      allowed: true,
      decision: "tracking_returned_or_refunded",
      status: "RETURNED_OR_REFUNDED",
      nextAction: "show_terminal_status",
      reason:
        "The order is already returned/refunded.",
    };
  }

  if (isLost(order)) {
    return addEscalation(
      {
        ...result,
        allowed: false,
        decision: "tracking_lost_in_transit",
        status: "LOST_IN_TRANSIT",
        nextAction: "support_review_required",
        reason:
          "The order appears to be lost in transit and requires support review.",
      },
      "lost_in_transit",
      "HIGH"
    );
  }

  if (isDelayed(order)) {
    return addEscalation(
      {
        ...result,
        allowed: true,
        decision: "tracking_delayed",
        status: "DELAYED",
        nextAction: "show_delay_status",
        reason:
          "The shipment is delayed and should be monitored or reviewed.",
      },
      "delivery_delay",
      "MEDIUM"
    );
  }

  if (isOutForDelivery(order)) {
    return {
      ...result,
      allowed: true,
      decision: "tracking_out_for_delivery",
      status: "OUT_FOR_DELIVERY",
      nextAction: "show_out_for_delivery_status",
      reason:
        "The order is out for delivery.",
    };
  }

  if (isDelivered(order)) {
    return {
      ...result,
      allowed: true,
      decision: "tracking_delivered",
      status: "DELIVERED",
      nextAction: "show_delivered_status",
      reason:
        "The order has been delivered.",
    };
  }

  if (isShipped(order)) {
    return {
      ...result,
      allowed: true,
      decision: "tracking_shipped",
      status: "SHIPPED",
      nextAction: "show_tracking_status",
      reason:
        "The order has been shipped and is on the way.",
    };
  }

  if (["placed", "confirmed", "processing", "packed", "ready_to_ship"].includes(status)) {
    return {
      ...result,
      allowed: Boolean(trackingId),
      decision: trackingId
        ? "tracking_available_pre_dispatch"
        : "tracking_not_available_pre_dispatch",
      status: "NOT_DISPATCHED",
      nextAction: trackingId
        ? "show_tracking_status"
        : "wait_for_dispatch",
      reason: trackingId
        ? "Tracking exists, but order has not fully moved into shipment stage."
        : "Tracking usually becomes available after dispatch.",
    };
  }

  return {
    ...result,
    allowed: Boolean(trackingId),
    decision: trackingId
      ? "tracking_available_unknown_status"
      : "tracking_not_available",
    status: status.toUpperCase(),
    nextAction: trackingId ? "show_tracking_status" : "support_review_required",
    reason: trackingId
      ? "Tracking is available for this order."
      : "Tracking is not available for this order status.",
    requiresEscalation: !trackingId,
    escalationTriggers: trackingId ? [] : ["tracking_unavailable_unknown_status"],
  };
}

// =====================================================
// CANCEL ORDER
// =====================================================

function evaluateCancellation(order, issueType = "cancellation") {
  if (!order) return orderNotFound("cancel_order", issueType);

  const result = buildBaseResult({
    intent: "cancel_order",
    order,
    issueType,
  });

  if (isCancelled(order)) {
    return {
      ...result,
      allowed: false,
      decision: "already_cancelled",
      status: "ALREADY_CANCELLED",
      nextAction: "no_action_needed",
      refundRequired: isPrepaid(order),
      reason:
        "The order is already cancelled.",
    };
  }

  if (isDelivered(order)) {
    return {
      ...result,
      allowed: false,
      decision: "cancellation_not_allowed_delivered",
      status: "DELIVERED",
      nextAction: "offer_return_replacement_exchange",
      refundRequired: false,
      reason:
        "Delivered orders cannot be cancelled. Return/replacement/exchange may be checked if eligible.",
    };
  }

  if (isShipped(order) || isOutForDelivery(order)) {
    return {
      ...result,
      allowed: false,
      decision: "cancellation_not_allowed_shipped",
      status: isOutForDelivery(order) ? "OUT_FOR_DELIVERY" : "SHIPPED",
      nextAction: "offer_reject_delivery_or_post_delivery_options",
      refundRequired: false,
      reason:
        "The order has already been shipped/out for delivery, so cancellation is not available at this stage.",
    };
  }

  if (isLost(order) || isDelayed(order)) {
    return addEscalation(
      {
        ...result,
        allowed: false,
        decision: "cancellation_manual_review_required",
        status: isLost(order) ? "LOST_IN_TRANSIT" : "DELAYED",
        nextAction: "support_review_required",
        refundRequired: isPrepaid(order),
        reason:
          "Cancellation needs support review because shipment status is abnormal.",
      },
      isLost(order) ? "lost_in_transit" : "delivery_delay",
      "HIGH"
    );
  }

  if (isCancellable(order)) {
    return {
      ...result,
      allowed: true,
      decision: "cancellation_confirmation_required",
      status: "ELIGIBLE_FOR_CANCELLATION",
      nextAction: "ask_cancellation_confirmation",
      refundRequired: isPrepaid(order),
      reason:
        "The order has not been dispatched yet, so it is eligible for cancellation. Confirmation is required before action.",
      policy:
        "Sensitive actions should be confirmed by the customer before execution.",
    };
  }

  return addEscalation(
    {
      ...result,
      allowed: false,
      decision: "cancellation_status_manual_review",
      status: "MANUAL_REVIEW_REQUIRED",
      nextAction: "support_review_required",
      refundRequired: isPrepaid(order),
      reason:
        "Cancellation eligibility is unclear for the current order status.",
    },
    "unclear_cancellation_status",
    "MEDIUM"
  );
}

// =====================================================
// RETURN ORDER
// =====================================================

function evaluateReturn(order, issueType = "return") {
  if (!order) return orderNotFound("return_order", issueType);

  const result = buildBaseResult({
    intent: "return_order",
    order,
    issueType,
  });

  const returnable = toBool(order.returnable, true);
  const daysAgo = getDeliveryDaysAgo(order);
  const withinWindow = isWithinWindow(daysAgo, order.returnWindowDays || RETURN_WINDOW_DAYS);

  if (isCancelled(order)) {
    return {
      ...result,
      allowed: false,
      decision: "return_not_allowed_cancelled",
      status: "CANCELLED",
      nextAction: "no_return_for_cancelled_order",
      reason:
        "Cancelled orders cannot be returned.",
    };
  }

  if (!isDelivered(order)) {
    return {
      ...result,
      allowed: false,
      decision: "return_not_allowed_before_delivery",
      status: "NOT_DELIVERED",
      nextAction: "wait_until_delivered",
      reason:
        "Return can be requested only after the order is delivered.",
    };
  }

  if (!returnable) {
    return {
      ...result,
      allowed: false,
      decision: "return_not_allowed_policy",
      status: "NOT_RETURNABLE",
      nextAction: "offer_replacement_or_support_if_applicable",
      reason:
        "This item is not returnable as per policy.",
    };
  }

  if (!withinWindow) {
    return {
      ...result,
      allowed: false,
      decision: "return_window_expired",
      status: "RETURN_WINDOW_EXPIRED",
      nextAction: "support_review_if_exception",
      reason:
        "The return window has expired.",
    };
  }

  return {
    ...result,
    allowed: true,
    decision: "return_eligible",
    status: "RETURN_ELIGIBLE",
    nextAction: "create_return_request_after_confirmation",
    refundRequired: true,
    reason:
      "The order is delivered, returnable, and within the return window.",
  };
}

// =====================================================
// REPLACEMENT ORDER
// =====================================================

function evaluateReplacement(order, issueType = "replacement") {
  if (!order) return orderNotFound("replace_order", issueType);

  const result = buildBaseResult({
    intent: "replace_order",
    order,
    issueType,
  });

  const replacementEligible = toBool(
    order.replacementEligible ?? order.replaceable,
    true
  );

  const daysAgo = getDeliveryDaysAgo(order);
  const withinWindow = isWithinWindow(
    daysAgo,
    order.replacementWindowDays || REPLACEMENT_WINDOW_DAYS
  );

  if (isCancelled(order)) {
    return {
      ...result,
      allowed: false,
      decision: "replacement_not_allowed_cancelled",
      status: "CANCELLED",
      nextAction: "no_replacement_for_cancelled_order",
      reason:
        "Cancelled orders cannot be replaced.",
    };
  }

  if (!isDelivered(order)) {
    return {
      ...result,
      allowed: false,
      decision: "replacement_not_allowed_before_delivery",
      status: "NOT_DELIVERED",
      nextAction: "wait_until_delivered",
      reason:
        "Replacement can be requested only after the order is delivered.",
    };
  }

  if (!replacementEligible) {
    return {
      ...result,
      allowed: false,
      decision: "replacement_not_allowed_policy",
      status: "NOT_REPLACEMENT_ELIGIBLE",
      nextAction: "offer_return_or_support_if_applicable",
      reason:
        "This item is not eligible for replacement as per policy.",
    };
  }

  if (!withinWindow) {
    return {
      ...result,
      allowed: false,
      decision: "replacement_window_expired",
      status: "REPLACEMENT_WINDOW_EXPIRED",
      nextAction: "support_review_if_exception",
      reason:
        "The replacement window has expired.",
    };
  }

  return {
    ...result,
    allowed: true,
    decision: "replacement_eligible",
    status: "REPLACEMENT_ELIGIBLE",
    nextAction: "create_replacement_request_after_confirmation",
    reason:
      "The order is delivered and eligible for replacement.",
  };
}

// =====================================================
// EXCHANGE ORDER
// =====================================================

function evaluateExchange(order, issueType = "exchange") {
  if (!order) return orderNotFound("exchange_order", issueType);

  const result = buildBaseResult({
    intent: "exchange_order",
    order,
    issueType,
  });

  const exchangeable = toBool(order.exchangeable, true);
  const daysAgo = getDeliveryDaysAgo(order);
  const withinWindow = isWithinWindow(
    daysAgo,
    order.exchangeWindowDays || EXCHANGE_WINDOW_DAYS
  );

  if (isCancelled(order)) {
    return {
      ...result,
      allowed: false,
      decision: "exchange_not_allowed_cancelled",
      status: "CANCELLED",
      nextAction: "no_exchange_for_cancelled_order",
      reason:
        "Cancelled orders cannot be exchanged.",
    };
  }

  if (!isDelivered(order)) {
    return {
      ...result,
      allowed: false,
      decision: "exchange_not_allowed_before_delivery",
      status: "NOT_DELIVERED",
      nextAction: "wait_until_delivered",
      reason:
        "Exchange can be requested only after the order is delivered.",
    };
  }

  if (!exchangeable) {
    return {
      ...result,
      allowed: false,
      decision: "exchange_not_allowed_policy",
      status: "NOT_EXCHANGEABLE",
      nextAction: "offer_return_or_replacement_if_applicable",
      reason:
        "This item is not exchangeable as per policy.",
    };
  }

  if (!withinWindow) {
    return {
      ...result,
      allowed: false,
      decision: "exchange_window_expired",
      status: "EXCHANGE_WINDOW_EXPIRED",
      nextAction: "support_review_if_exception",
      reason:
        "The exchange window has expired.",
    };
  }

  return {
    ...result,
    allowed: true,
    decision: "exchange_eligible",
    status: "EXCHANGE_ELIGIBLE",
    nextAction: "create_exchange_request_after_confirmation",
    reason:
      "The order is delivered and eligible for exchange.",
  };
}

// =====================================================
// REORDER
// =====================================================

function evaluateReorder(order, issueType = "reorder") {
  if (!order) return orderNotFound("reorder_order", issueType);

  const result = buildBaseResult({
    intent: "reorder_order",
    order,
    issueType,
  });

  if (isDelivered(order)) {
    return {
      ...result,
      allowed: true,
      decision: "reorder_allowed_delivered",
      status: "REORDER_GUIDANCE",
      nextAction: "guide_reorder_from_order_history",
      reason:
        "The order has already been delivered, so the customer can place the same product again if it is still available.",
    };
  }

  if (isCancelled(order)) {
    return {
      ...result,
      allowed: true,
      decision: "reorder_allowed_cancelled",
      status: "REORDER_GUIDANCE",
      nextAction: "guide_fresh_order",
      reason:
        "The order was cancelled, so the customer may place a fresh order for the same product if available.",
    };
  }

  if (isReturnedOrRefunded(order)) {
    return {
      ...result,
      allowed: true,
      decision: "reorder_allowed_returned_refunded",
      status: "REORDER_GUIDANCE",
      nextAction: "guide_fresh_order",
      reason:
        "The previous order was returned/refunded, so the customer can place a fresh order if the product is available.",
    };
  }

  if (isOutForDelivery(order)) {
    return {
      ...result,
      allowed: false,
      decision: "reorder_not_needed_out_for_delivery",
      status: "ACTIVE_ORDER",
      nextAction: "offer_tracking_or_fresh_quantity",
      reason:
        "The current order is out for delivery, so reorder is not needed unless the customer wants another quantity.",
    };
  }

  if (isShipped(order)) {
    return {
      ...result,
      allowed: false,
      decision: "reorder_not_needed_shipped",
      status: "ACTIVE_ORDER",
      nextAction: "offer_tracking_or_fresh_quantity",
      reason:
        "The current order is shipped and still on the way, so reorder is not needed for the same order yet.",
    };
  }

  if (isActiveNotDelivered(order)) {
    return {
      ...result,
      allowed: false,
      decision: "reorder_not_needed_active_order",
      status: "ACTIVE_ORDER",
      nextAction: "offer_status_or_cancel_if_eligible",
      reason:
        "The current order is still active and not completed yet.",
    };
  }

  return {
    ...result,
    allowed: true,
    decision: "reorder_general_guidance",
    status: "REORDER_GUIDANCE",
    nextAction: "guide_fresh_order",
    reason:
      "The customer can place a fresh order if the product is still available.",
  };
}

// =====================================================
// REFUND
// =====================================================

function evaluateRefund(order, issueType = "refund") {
  if (!order) return orderNotFound("refund_status", issueType);

  const result = buildBaseResult({
    intent: "refund_status",
    order,
    issueType,
  });

  const paymentStatus = getPaymentStatus(order);
  const refundStatus = normalizeText(order.refundStatus || "");

  if (isCancelled(order) && isPrepaid(order)) {
    return {
      ...result,
      allowed: true,
      decision: "refund_expected_after_cancellation",
      status: "REFUND_PROCESSING_OR_EXPECTED",
      nextAction: "show_refund_timeline",
      refundRequired: true,
      reason:
        "The order is cancelled and appears prepaid, so refund processing should follow the payment timeline.",
    };
  }

  if (isReturnedOrRefunded(order)) {
    return {
      ...result,
      allowed: true,
      decision: "refund_completed_or_returned",
      status: refundStatus === "refunded" ? "REFUNDED" : "RETURNED_OR_REFUNDED",
      nextAction: "show_refund_status",
      refundRequired: false,
      reason:
        "The order is already returned/refunded.",
    };
  }

  if (refundStatus) {
    return {
      ...result,
      allowed: true,
      decision: "refund_status_available",
      status: refundStatus.toUpperCase(),
      nextAction: "show_refund_status",
      refundRequired: !["refunded", "completed"].includes(refundStatus),
      reason:
        "Refund status is available for this order.",
    };
  }

  if (["failed", "pending", "initiated"].includes(paymentStatus)) {
    return addEscalation(
      {
        ...result,
        allowed: false,
        decision: "refund_payment_review_required",
        status: "PAYMENT_REVIEW_REQUIRED",
        nextAction: "support_review_required",
        refundRequired: true,
        reason:
          "Payment/refund state needs support review.",
      },
      "payment_review_required",
      "HIGH"
    );
  }

  return {
    ...result,
    allowed: false,
    decision: "refund_not_applicable_yet",
    status: "REFUND_NOT_APPLICABLE_YET",
    nextAction: "explain_refund_conditions",
    refundRequired: false,
    reason:
      "Refund is usually applicable after cancellation, return, or payment failure confirmation.",
  };
}

// =====================================================
// PAYMENT ISSUE
// =====================================================

function evaluatePaymentIssue(order, issueType = "payment") {
  if (!order) return orderNotFound("payment_issue", issueType);

  const result = buildBaseResult({
    intent: "payment_issue",
    order,
    issueType,
  });

  return addEscalation(
    {
      ...result,
      allowed: false,
      decision: "payment_issue_support_review",
      status: "PAYMENT_REVIEW_REQUIRED",
      nextAction: "support_review_required",
      refundRequired: true,
      reason:
        "Payment issues such as double charge or money deducted require support/payment team review.",
    },
    "payment_issue",
    "HIGH"
  );
}

// =====================================================
// DELIVERY ISSUE
// =====================================================

function evaluateDeliveryIssue(order, issueType = "delivery") {
  if (!order) return orderNotFound("delivery_issue", issueType);

  const status = getStatus(order);
  const base = buildBaseResult({
    intent: "delivery_issue",
    order,
    issueType,
  });

  if (isLost(order)) {
    return addEscalation(
      {
        ...base,
        allowed: false,
        decision: "delivery_lost_in_transit",
        status: "LOST_IN_TRANSIT",
        nextAction: "support_review_required",
        reason:
          "The order appears to be lost in transit and needs support intervention.",
      },
      "lost_in_transit",
      "HIGH"
    );
  }

  if (isDelayed(order)) {
    return addEscalation(
      {
        ...base,
        allowed: true,
        decision: "delivery_delayed",
        status: "DELAYED",
        nextAction: "show_delay_and_support_option",
        reason:
          "The order is delayed and can be reviewed by support if needed.",
      },
      "delivery_delay",
      "MEDIUM"
    );
  }

  if (isOutForDelivery(order)) {
    return {
      ...base,
      allowed: true,
      decision: "delivery_out_for_delivery",
      status: "OUT_FOR_DELIVERY",
      nextAction: "show_out_for_delivery_status",
      reason:
        "The order is currently out for delivery.",
    };
  }

  if (isDelivered(order)) {
    return {
      ...base,
      allowed: true,
      decision: "delivery_delivered",
      status: "DELIVERED",
      nextAction: "confirm_delivery_or_raise_issue",
      reason:
        "The order is marked delivered.",
    };
  }

  return {
    ...base,
    allowed: true,
    decision: "delivery_status_available",
    status: status.toUpperCase(),
    nextAction: "show_delivery_status",
    reason:
      "Delivery status is available for this order.",
  };
}

// =====================================================
// ITEM ISSUES
// =====================================================

function evaluateItemIssue(order, intent, issueType) {
  if (!order) return orderNotFound(intent, issueType);

  const result = buildBaseResult({
    intent,
    order,
    issueType,
  });

  if (!isDelivered(order)) {
    return {
      ...result,
      allowed: false,
      decision: `${issueType}_not_allowed_before_delivery`,
      status: "NOT_DELIVERED",
      nextAction: "wait_until_delivered_or_support_review",
      reason:
        "Item issues are usually raised after delivery. If the package is missing or delivery is incorrect, support can review it.",
      requiresEscalation: issueType === "missing_item",
      escalationTriggers:
        issueType === "missing_item" ? ["missing_item_before_delivery"] : [],
    };
  }

  return addEscalation(
    {
      ...result,
      allowed: true,
      decision: `${issueType}_support_review`,
      status: "SUPPORT_REVIEW_REQUIRED",
      nextAction: "support_review_required",
      reason:
        "This item issue should be reviewed by the support team.",
    },
    issueType,
    "MEDIUM"
  );
}

// =====================================================
// MAIN ENTRY
// =====================================================

function applyRules(input = {}) {
  const intent = input.intent || input.intentResult?.intent || "general_support";
  const order = input.order || null;
  const issueType =
    input.issueType ||
    input.intentResult?.issueType ||
    "general";

  switch (intent) {
    case "track_order":
      return evaluateTracking(order, issueType);

    case "cancel_order":
      return evaluateCancellation(order, issueType);

    case "return_order":
      return evaluateReturn(order, issueType);

    case "replace_order":
      return evaluateReplacement(order, issueType);

    case "exchange_order":
      return evaluateExchange(order, issueType);

    case "reorder_order":
      return evaluateReorder(order, issueType);

    case "refund_status":
      return evaluateRefund(order, issueType);

    case "payment_issue":
      return evaluatePaymentIssue(order, issueType);

    case "delivery_issue":
      return evaluateDeliveryIssue(order, issueType);

    case "missing_item":
      return evaluateItemIssue(order, "missing_item", "missing_item");

    case "wrong_item":
      return evaluateItemIssue(order, "wrong_item", "wrong_item");

    case "damaged_item":
      return evaluateItemIssue(order, "damaged_item", "damaged_item");

    default:
      return {
        intent,
        issueType,
        order,
        orderId: getOrderId(order),
        trackingId: getTrackingId(order),
        orderStatus: order ? getStatus(order) : null,
        displayStatus: order ? getDisplayStatus(order) : null,

        allowed: false,
        decision: "unsupported_intent",
        status: "UNSUPPORTED_INTENT",

        refundRequired: false,
        requiresEscalation: false,
        escalationTriggers: [],

        nextAction: "ask_clarification",
        reason:
          "This intent is not handled by the rule engine.",
        policy: null,
      };
  }
}

// =====================================================
// COMPATIBILITY ALIASES
// =====================================================

function applyBusinessRules(input = {}) {
  return applyRules(input);
}

function runRuleEngine(input = {}) {
  return applyRules(input);
}

function evaluateRules(input = {}) {
  return applyRules(input);
}

module.exports = {
  applyRules,
  applyBusinessRules,
  runRuleEngine,
  evaluateRules,

  evaluateTracking,
  evaluateCancellation,
  evaluateReturn,
  evaluateReplacement,
  evaluateExchange,
  evaluateReorder,
  evaluateRefund,
  evaluatePaymentIssue,
  evaluateDeliveryIssue,

  normalizeText,
  getStatus,
  getDisplayStatus,
  getOrderId,
  getTrackingId,
};