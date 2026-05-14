"use strict";

/**
 * confidenceAgent.js
 *
 * Purpose:
 * - Decide whether a query should go to rule engine, clarification, fallback, or escalation.
 * - Keep deterministic ecommerce flows stable.
 * - Do NOT block valid order intents like reorder_order or trackingId-only tracking.
 * - Detect risk/customer sentiment signals for escalation priority.
 */

const DEFAULT_LOW_CONFIDENCE_THRESHOLD = 0.5;
const DEFAULT_RULE_ENGINE_THRESHOLD = 0.65;

const ORDER_REQUIRED_INTENTS = new Set([
  "track_order",
  "cancel_order",
  "return_order",
  "replace_order",
  "exchange_order",
  "reorder_order",
  "refund_status",
  "payment_issue",
  "delivery_issue",
  "missing_item",
  "wrong_item",
  "damaged_item",
]);

const DIRECT_INFO_INTENTS = new Set([
  "greeting",
  "conversation_end",
  "context_reset",
  "order_id_help",
  "trust_question",
  "tone_feedback",
  "context_complaint",
  "customer_frustration",
  "abusive_user",
  "rude_user",
  "human_support",
  "negative_correction",
  "unsafe_request",
  "off_topic",
]);

const ESCALATION_INTENTS = new Set([
  "human_support",
  "payment_issue",
  "missing_item",
  "wrong_item",
  "damaged_item",
]);

const FALLBACK_SAFE_INTENTS = new Set([
  "general_support",
  "off_topic",
]);

// =====================================================
// HELPERS
// =====================================================

function normalizeText(value = "") {
  return String(value || "").toLowerCase().trim().replace(/\s+/g, " ");
}

function includesAny(text = "", patterns = []) {
  const clean = normalizeText(text);
  return patterns.some((pattern) => clean.includes(normalizeText(pattern)));
}

function clampConfidence(value, fallback = DEFAULT_LOW_CONFIDENCE_THRESHOLD) {
  const parsed = Number(value);

  if (!Number.isFinite(parsed)) return fallback;

  if (parsed < 0) return 0;
  if (parsed > 1) return 1;

  return parsed;
}

function hasOrderId(intentResult = {}) {
  return Boolean(intentResult.orderId || intentResult.entities?.orderId);
}

function hasTrackingId(intentResult = {}) {
  return Boolean(intentResult.trackingId || intentResult.entities?.trackingId);
}

function getOrderId(intentResult = {}) {
  return intentResult.orderId || intentResult.entities?.orderId || null;
}

function getTrackingId(intentResult = {}) {
  return intentResult.trackingId || intentResult.entities?.trackingId || null;
}

function normalizeIntent(intentResult = {}) {
  return String(intentResult.intent || "general_support").trim();
}

function detectRiskSignals(intentResult = {}, context = {}) {
  const query = normalizeText(context.query || intentResult.rawText || "");
  const metadataSignals = intentResult.metadata?.riskSignals || [];

  const riskSignals = new Set(metadataSignals);

  if (
    includesAny(query, [
      "angry",
      "frustrated",
      "upset",
      "annoyed",
      "irritated",
      "bad experience",
      "not happy",
    ])
  ) {
    riskSignals.add("angry_customer");
  }

  if (
    includesAny(query, [
      "dumb",
      "stupid",
      "idiot",
      "shit",
      "bullshit",
      "useless",
      "trash",
      "get lost",
      "shut up",
    ])
  ) {
    riskSignals.add("abusive_or_rude_language");
    riskSignals.add("angry_customer");
  }

  if (
    includesAny(query, [
      "connect me to human",
      "human support",
      "human agent",
      "talk to human",
      "real person",
      "raise ticket",
      "create ticket",
      "escalate",
    ])
  ) {
    riskSignals.add("customer_requested_human_support");
  }

  if (
    includesAny(query, [
      "charged twice",
      "double charged",
      "money deducted",
      "amount deducted",
      "paid but order not placed",
      "payment successful but order not placed",
    ])
  ) {
    riskSignals.add("payment_risk");
  }

  if (
    includesAny(query, [
      "lost in transit",
      "lost order",
      "not delivered",
      "missing item",
      "wrong item",
      "damaged",
      "broken",
    ])
  ) {
    riskSignals.add("fulfillment_risk");
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
      "jailbreak",
    ])
  ) {
    riskSignals.add("unsafe_request");
  }

  return Array.from(riskSignals);
}

function buildResult({
  route,
  decision,
  confidence,
  requiresClarification = false,
  requiresFallback = false,
  requiresEscalation = false,
  missingEntities = [],
  riskSignals = [],
  reason = null,
}) {
  return {
    route,
    decision,
    confidence: clampConfidence(confidence),
    requiresClarification,
    requiresFallback,
    requiresEscalation,
    missingEntities,
    riskSignals,
    reason,
  };
}

// =====================================================
// MAIN EVALUATOR
// =====================================================

function evaluateConfidence(intentResult = {}, context = {}) {
  const intent = normalizeIntent(intentResult);
  const confidence = clampConfidence(intentResult.confidence, 0.5);
  const query = context.query || intentResult.rawText || "";

  const orderId = getOrderId(intentResult);
  const trackingId = getTrackingId(intentResult);

  const orderPresent = hasOrderId(intentResult);
  const trackingPresent = hasTrackingId(intentResult);

  const riskSignals = detectRiskSignals(intentResult, {
    ...context,
    query,
  });

  const hasHighRisk = riskSignals.some((signal) =>
    [
      "angry_customer",
      "abusive_or_rude_language",
      "customer_requested_human_support",
      "payment_risk",
      "fulfillment_risk",
      "unsafe_request",
    ].includes(signal)
  );

  // -----------------------------------------------------
  // 1. Safety / unsafe requests
  // -----------------------------------------------------
  if (intent === "unsafe_request" || riskSignals.includes("unsafe_request")) {
    return buildResult({
      route: "direct_info",
      decision: "unsafe_request_blocked",
      confidence,
      requiresEscalation: false,
      riskSignals,
      reason: "Unsafe or policy-bypass request detected.",
    });
  }

  // -----------------------------------------------------
  // 2. Direct conversational/meta intents
  // -----------------------------------------------------
  if (DIRECT_INFO_INTENTS.has(intent)) {
    return buildResult({
      route: "direct_info",
      decision: "direct_conversation_response",
      confidence,
      requiresEscalation:
        intent === "human_support" ||
        intent === "customer_frustration" ||
        intent === "abusive_user" ||
        intent === "rude_user",
      riskSignals,
      reason: "Direct non-rule-engine conversational intent.",
    });
  }

  // -----------------------------------------------------
  // 3. Tracking ID alone is enough for tracking
  // -----------------------------------------------------
  if (intent === "track_order" && trackingPresent) {
    return buildResult({
      route: "rule_engine",
      decision: "tracking_id_present",
      confidence: Math.max(confidence, 0.92),
      requiresClarification: false,
      requiresFallback: false,
      requiresEscalation: hasHighRisk,
      riskSignals,
      reason: "Tracking ID can resolve the order.",
    });
  }

  // -----------------------------------------------------
  // 4. Order-required intents missing order ID
  // -----------------------------------------------------
  if (ORDER_REQUIRED_INTENTS.has(intent) && !orderPresent && !trackingPresent) {
    return buildResult({
      route: "clarification",
      decision: "missing_required_entity",
      confidence,
      requiresClarification: true,
      requiresFallback: false,
      requiresEscalation: false,
      missingEntities: ["orderId"],
      riskSignals,
      reason: "Order-specific intent requires order ID or tracking ID.",
    });
  }

  // -----------------------------------------------------
  // 5. Order-required intents with order ID should go to rule engine
  // -----------------------------------------------------
  if (ORDER_REQUIRED_INTENTS.has(intent) && (orderPresent || trackingPresent)) {
    return buildResult({
      route: "rule_engine",
      decision: "order_entity_present",
      confidence: Math.max(confidence, 0.82),
      requiresClarification: false,
      requiresFallback: false,
      requiresEscalation:
        hasHighRisk || ESCALATION_INTENTS.has(intent),
      riskSignals,
      reason: "Order entity present for order-specific intent.",
    });
  }

  // -----------------------------------------------------
  // 6. Order reference only should ask what action user wants
  // -----------------------------------------------------
  if (intent === "order_reference_only") {
    if (orderPresent || trackingPresent) {
      return buildResult({
        route: "direct_info",
        decision: "order_reference_needs_action",
        confidence,
        requiresClarification: true,
        requiresFallback: false,
        requiresEscalation: false,
        missingEntities: ["intent"],
        riskSignals,
        reason: "Only order reference was provided; action is missing.",
      });
    }

    return buildResult({
      route: "clarification",
      decision: "missing_required_entity",
      confidence,
      requiresClarification: true,
      missingEntities: ["orderId", "intent"],
      riskSignals,
      reason: "Order reference intent without usable order ID.",
    });
  }

  // -----------------------------------------------------
  // 7. Low confidence generic fallback
  // -----------------------------------------------------
  if (confidence < DEFAULT_LOW_CONFIDENCE_THRESHOLD) {
    return buildResult({
      route: "fallback_llm",
      decision: "low_confidence",
      confidence,
      requiresFallback: true,
      requiresEscalation: false,
      riskSignals,
      reason: "Low confidence intent classification.",
    });
  }

  // -----------------------------------------------------
  // 8. General support / off-topic
  // -----------------------------------------------------
  if (FALLBACK_SAFE_INTENTS.has(intent)) {
    if (intent === "off_topic") {
      return buildResult({
        route: "direct_info",
        decision: "off_topic_redirect",
        confidence,
        requiresFallback: false,
        requiresEscalation: false,
        riskSignals,
        reason: "Off-topic query should be redirected politely.",
      });
    }

    return buildResult({
      route: "fallback_llm",
      decision: "general_support_needs_clarification",
      confidence,
      requiresFallback: true,
      requiresEscalation: false,
      riskSignals,
      reason: "General query needs clarification.",
    });
  }

  // -----------------------------------------------------
  // 9. Medium confidence known intent
  // -----------------------------------------------------
  if (confidence >= DEFAULT_RULE_ENGINE_THRESHOLD) {
    return buildResult({
      route: "rule_engine",
      decision: "sufficient_confidence",
      confidence,
      requiresClarification: false,
      requiresFallback: false,
      requiresEscalation: hasHighRisk,
      riskSignals,
      reason: "Confidence is sufficient for rule engine.",
    });
  }

  // -----------------------------------------------------
  // 10. Default fallback
  // -----------------------------------------------------
  return buildResult({
    route: "fallback_llm",
    decision: "default_fallback",
    confidence,
    requiresFallback: true,
    requiresEscalation: hasHighRisk,
    riskSignals,
    reason: "Default fallback route.",
  });
}

// =====================================================
// COMPATIBILITY HELPERS
// =====================================================

function analyzeConfidence(intentResult = {}, context = {}) {
  return evaluateConfidence(intentResult, context);
}

function getConfidenceDecision(intentResult = {}, context = {}) {
  return evaluateConfidence(intentResult, context);
}

module.exports = {
  evaluateConfidence,
  analyzeConfidence,
  getConfidenceDecision,

  clampConfidence,
  detectRiskSignals,

  ORDER_REQUIRED_INTENTS,
  DIRECT_INFO_INTENTS,
};