const rules = require("./rules.json");

function isMissing(value) {
  return value === undefined || value === null || value === "";
}

function normalizeConfidence(confidence) {
  if (typeof confidence !== "number") return 0;

  if (confidence > 1) {
    return Math.min(confidence / 100, 1);
  }

  if (confidence < 0) return 0;

  return confidence;
}

function hasRequiredEntities(intentResult = {}) {
  const { intent, orderId } = intentResult;

  const orderRequiredIntents = [
    "cancel_order",
    "return_order",
    "replace_order",
    "refund_status",
    "exchange_order",
    "track_order",
    "delivery_issue",
    "payment_issue",
    "missing_item",
    "wrong_item",
    "damaged_item"
  ];

  if (orderRequiredIntents.includes(intent) && isMissing(orderId)) {
    return {
      valid: false,
      missing: ["orderId"],
      reason: "Order ID is required for this intent."
    };
  }

  return {
    valid: true,
    missing: [],
    reason: "Required entities are present."
  };
}

function isSupportedIntent(intent) {
  return rules.supportedIntents.includes(intent);
}

function detectRiskSignals(intentResult = {}, context = {}) {
  const signals = [];

  const text = `${context.query || ""} ${intentResult.rawText || ""}`.toLowerCase();

  const angryWords = [
    "angry",
    "frustrated",
    "worst",
    "cheated",
    "scam",
    "fraud",
    "legal action",
    "consumer court",
    "complaint",
    "very bad",
    "terrible"
  ];

  const abuseWords = [
    "idiot",
    "stupid",
    "useless",
    "shut up"
  ];

  const promptInjectionWords = [
    "ignore previous instructions",
    "bypass rules",
    "forget policy",
    "act as admin",
    "approve my refund without checking"
  ];

  if (angryWords.some((word) => text.includes(word))) {
    signals.push("angry_customer");
  }

  if (abuseWords.some((word) => text.includes(word))) {
    signals.push("abusive_customer");
  }

  if (promptInjectionWords.some((word) => text.includes(word))) {
    signals.push("prompt_injection_detected");
  }

  return [...new Set(signals)];
}

function evaluateConfidence(intentResult = {}, context = {}) {
  const normalizedConfidence = normalizeConfidence(intentResult.confidence);

  const highThreshold = rules.thresholds.highConfidence || 0.75;
  const lowThreshold = rules.thresholds.lowConfidence || 0.5;

  const intent = intentResult.intent || null;
  const entityCheck = hasRequiredEntities(intentResult);
  const riskSignals = detectRiskSignals(intentResult, context);

  const result = {
    originalConfidence: intentResult.confidence,
    normalizedConfidence,
    highThreshold,
    lowThreshold,
    intent,
    route: null,
    decision: null,
    allowedToUseRuleEngine: false,
    requiresFallback: false,
    requiresClarification: false,
    requiresEscalation: false,
    missingEntities: [],
    riskSignals,
    reason: null,
    metadata: {
      orderId: intentResult.orderId || null,
      issueType: intentResult.issueType || null
    }
  };

  if (!intent) {
    result.route = "fallback_llm";
    result.decision = "missing_intent";
    result.requiresFallback = true;
    result.requiresClarification = true;
    result.reason = "Intent is missing.";
    return result;
  }

  if (!isSupportedIntent(intent)) {
    result.route = "fallback_llm";
    result.decision = "unsupported_intent";
    result.requiresFallback = true;
    result.reason = "Intent is not supported by the current system.";
    return result;
  }

  if (!entityCheck.valid) {
    result.route = "clarification";
    result.decision = "missing_required_entity";
    result.requiresClarification = true;
    result.missingEntities = entityCheck.missing;
    result.reason = entityCheck.reason;
    return result;
  }

  if (riskSignals.includes("prompt_injection_detected")) {
    result.route = "fallback_llm";
    result.decision = "unsafe_input_detected";
    result.requiresFallback = true;
    result.requiresEscalation = true;
    result.reason = "Prompt injection or unsafe instruction pattern detected.";
    return result;
  }

  if (normalizedConfidence >= highThreshold) {
    result.route = "rule_engine";
    result.decision = "high_confidence";
    result.allowedToUseRuleEngine = true;
    result.reason = "High confidence intent and required entities are available.";

    if (
      riskSignals.includes("angry_customer") ||
      riskSignals.includes("abusive_customer")
    ) {
      result.requiresEscalation = true;
    }

    return result;
  }

  if (normalizedConfidence >= lowThreshold) {
    result.route = "clarification";
    result.decision = "medium_confidence";
    result.requiresClarification = true;
    result.reason = "Intent confidence is medium. Clarification is recommended before applying policy rules.";
    return result;
  }

  result.route = "fallback_llm";
  result.decision = "low_confidence";
  result.requiresFallback = true;
  result.reason = "Intent confidence is too low for direct rule-engine decision.";
  return result;
}

module.exports = {
  evaluateConfidence
};