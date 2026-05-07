// confidenceAgent.js
// Decides whether the detected intent should go to:
// Rule Engine, Clarification, Fallback, Context Resolution, or Escalation.

const HIGH_CONFIDENCE_THRESHOLD = 0.75;
const LOW_CONFIDENCE_THRESHOLD = 0.5;

const ORDER_REQUIRED_INTENTS = [
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
  "damaged_item",
];

const POLICY_INTENTS = [
  "delivery_policy",
  "refund_policy",
  "return_policy",
  "replacement_policy",
  "cancellation_policy",
];

const DIRECT_INFO_INTENTS = [
  "order_id_faq",
  "bulk_cancel_help",
  "account_or_subscription_help",
];

const SAFE_NON_ORDER_INTENTS = [
  "greeting",
  "non_commerce_request",
  "general_support",
  ...POLICY_INTENTS,
  ...DIRECT_INFO_INTENTS,
];

function normalizeText(text = "") {
  return String(text || "").trim().toLowerCase();
}

function normalizeConfidence(confidence) {
  let value = Number(confidence);

  if (Number.isNaN(value)) {
    return 0;
  }

  if (value > 1) {
    value = value / 100;
  }

  return Math.max(0, Math.min(value, 1));
}

function includesAny(text = "", patterns = []) {
  const cleanText = normalizeText(text);
  return patterns.some((pattern) => cleanText.includes(pattern));
}

function isAngryCustomer(query = "") {
  return includesAny(query, [
    "angry",
    "very angry",
    "frustrated",
    "irritated",
    "useless",
    "worst",
    "bad service",
    "terrible",
    "nonsense",
    "stupid",
    "fraud",
    "scam",
    "cheated",
    "legal action",
    "consumer court",
    "complaint",
    "i will complain",
    "i am very angry",
  ]);
}

function isUnsafeInput(query = "") {
  return includesAny(query, [
    "ignore previous instructions",
    "ignore all instructions",
    "bypass",
    "jailbreak",
    "system prompt",
    "developer message",
    "reveal prompt",
    "show your prompt",
    "act as admin",
    "admin access",
    "override policy",
    "skip policy",
    "approve everything",
    "give refund without checking",
    "cancel without order id",
    "delete logs",
    "hide audit",
  ]);
}

function isHumanSupportRequest(query = "", intent = "") {
  if (intent === "human_support") return true;

  return includesAny(query, [
    "human agent",
    "real person",
    "customer care",
    "customer support",
    "support agent",
    "connect me with human",
    "connect me to human",
    "connect to agent",
    "talk to agent",
    "talk to human",
    "speak to human",
    "speak with human",
    "call me",
    "agent please",
    "raise ticket",
    "escalate this",
  ]);
}

function isOnlyOrderReference(intentResult = {}) {
  return intentResult.intent === "order_reference_only";
}

function hasOrderId(intentResult = {}) {
  return Boolean(intentResult.orderId);
}

function hasTrackingId(intentResult = {}) {
  return Boolean(intentResult.trackingId);
}

function getMissingEntities(intentResult = {}) {
  const missing = [];
  const intent = intentResult.intent;

  if (ORDER_REQUIRED_INTENTS.includes(intent)) {
    if (!hasOrderId(intentResult) && !hasTrackingId(intentResult)) {
      missing.push("orderId");
    }
  }

  return missing;
}

function buildBaseResult(intentResult = {}, options = {}) {
  const confidence = normalizeConfidence(intentResult.confidence);

  return {
    originalConfidence: intentResult.confidence ?? null,
    normalizedConfidence: confidence,
    highThreshold: HIGH_CONFIDENCE_THRESHOLD,
    lowThreshold: LOW_CONFIDENCE_THRESHOLD,

    intent: intentResult.intent || "general_support",
    route: null,
    decision: null,

    allowedToUseRuleEngine: false,
    requiresFallback: false,
    requiresClarification: false,
    requiresEscalation: false,

    missingEntities: [],
    riskSignals: [],

    reason: null,

    metadata: {
      orderId: intentResult.orderId || null,
      trackingId: intentResult.trackingId || null,
      issueType: intentResult.issueType || "general",
      source: intentResult.source || null,
      query: options.query || null,
    },
  };
}

function addRiskSignal(result, signal) {
  if (!result.riskSignals.includes(signal)) {
    result.riskSignals.push(signal);
  }
}

function evaluateConfidence(intentResult = {}, options = {}) {
  const query = options.query || intentResult.rawText || "";
  const intent = intentResult.intent || "general_support";
  const confidence = normalizeConfidence(intentResult.confidence);
  const result = buildBaseResult(intentResult, options);

  // ===============================
  // Safety and human-support priority
  // ===============================

  if (isUnsafeInput(query) || intent === "unsafe_request") {
    addRiskSignal(result, "unsafe_input_detected");

    result.route = "fallback_llm";
    result.decision = "unsafe_input_detected";
    result.allowedToUseRuleEngine = false;
    result.requiresFallback = true;
    result.requiresClarification = false;
    result.requiresEscalation = false;
    result.reason =
      "Unsafe or policy-bypass input detected. The request should not be processed by the rule engine.";

    return result;
  }

  if (isHumanSupportRequest(query, intent)) {
    addRiskSignal(result, "customer_requested_human_support");

    result.route = "human_support";
    result.decision = "customer_requested_human_support";
    result.allowedToUseRuleEngine = false;
    result.requiresFallback = false;
    result.requiresClarification = false;
    result.requiresEscalation = true;
    result.reason = "Customer explicitly requested human support.";

    return result;
  }

  if (isAngryCustomer(query)) {
    addRiskSignal(result, "angry_customer");
  }

  // ===============================
  // Greeting / Direct Info / Policy / Off-topic
  // ===============================

  if (intent === "greeting") {
    result.route = "fallback_llm";
    result.decision = "greeting_detected";
    result.allowedToUseRuleEngine = false;
    result.requiresFallback = true;
    result.requiresClarification = false;
    result.requiresEscalation = false;
    result.reason = "Greeting detected. Respond politely without rule engine.";

    return result;
  }

  if (DIRECT_INFO_INTENTS.includes(intent)) {
    result.route = "direct_info";
    result.decision = intent;
    result.allowedToUseRuleEngine = false;
    result.requiresFallback = false;
    result.requiresClarification = false;
    result.requiresEscalation = false;
    result.reason = "Direct FAQ/help intent detected.";

    return result;
  }

  if (POLICY_INTENTS.includes(intent)) {
    result.route = "fallback_llm";
    result.decision = "general_policy_query";
    result.allowedToUseRuleEngine = false;
    result.requiresFallback = true;
    result.requiresClarification = false;
    result.requiresEscalation = false;
    result.reason =
      "General policy query detected. It can be answered without order-level rules.";

    return result;
  }

  if (intent === "non_commerce_request") {
    result.route = "fallback_llm";
    result.decision = "non_commerce_request";
    result.allowedToUseRuleEngine = false;
    result.requiresFallback = true;
    result.requiresClarification = false;
    result.requiresEscalation = false;
    result.reason =
      "The query is outside order support, so it should be redirected politely.";

    return result;
  }

  // ===============================
  // Context-only order reference
  // ===============================

  if (isOnlyOrderReference(intentResult)) {
    result.route = "context_resolution";
    result.decision = "order_reference_only";
    result.allowedToUseRuleEngine = false;
    result.requiresFallback = false;
    result.requiresClarification = false;
    result.requiresEscalation = false;
    result.reason =
      "Only an order ID was shared. The app context resolver should attach the pending or previous intent.";

    return result;
  }

  // ===============================
  // Missing entity handling
  // ===============================

  const missingEntities = getMissingEntities(intentResult);
  result.missingEntities = missingEntities;

  if (missingEntities.length > 0) {
    result.route = "clarification";
    result.decision = "missing_required_entity";
    result.allowedToUseRuleEngine = false;
    result.requiresFallback = false;
    result.requiresClarification = true;
    result.requiresEscalation = false;
    result.reason =
      "The intent is order-specific, but the required order ID or tracking ID is missing.";

    return result;
  }

  // ===============================
  // Low confidence handling
  // ===============================

  if (confidence < LOW_CONFIDENCE_THRESHOLD) {
    result.route = "fallback_llm";
    result.decision = "low_confidence";
    result.allowedToUseRuleEngine = false;
    result.requiresFallback = true;
    result.requiresClarification = false;
    result.requiresEscalation = false;
    result.reason =
      "Intent confidence is low, so the bot should respond carefully and ask for clarification if needed.";

    return result;
  }

  if (
    confidence >= LOW_CONFIDENCE_THRESHOLD &&
    confidence < HIGH_CONFIDENCE_THRESHOLD
  ) {
    // For safe general-support queries, a polite clarification is better than escalation.
    if (SAFE_NON_ORDER_INTENTS.includes(intent) || intent === "general_support") {
      result.route = "fallback_llm";
      result.decision = "medium_confidence_general_support";
      result.allowedToUseRuleEngine = false;
      result.requiresFallback = true;
      result.requiresClarification = false;
      result.requiresEscalation = false;
      result.reason =
        "Medium confidence general query. Use a polite fallback/help response.";

      return result;
    }

    result.route = "clarification";
    result.decision = "medium_confidence_needs_clarification";
    result.allowedToUseRuleEngine = false;
    result.requiresFallback = false;
    result.requiresClarification = true;
    result.requiresEscalation = false;
    result.reason =
      "Intent confidence is medium, so clarification is safer before applying rules.";

    return result;
  }

  // ===============================
  // High-confidence order intents
  // ===============================

  if (ORDER_REQUIRED_INTENTS.includes(intent)) {
    result.route = "rule_engine";
    result.decision = "high_confidence_order_intent";
    result.allowedToUseRuleEngine = true;
    result.requiresFallback = false;
    result.requiresClarification = false;
    result.requiresEscalation = result.riskSignals.includes("angry_customer");
    result.reason =
      "High-confidence order intent with required entity present. Safe to use rule engine.";

    return result;
  }

  // ===============================
  // General support
  // ===============================

  if (intent === "general_support") {
    result.route = "fallback_llm";
    result.decision = "general_support";
    result.allowedToUseRuleEngine = false;
    result.requiresFallback = true;
    result.requiresClarification = false;
    result.requiresEscalation = false;
    result.reason =
      "General support query detected. Respond politely with supported options.";

    return result;
  }

  // ===============================
  // Unknown but confident
  // ===============================

  result.route = "fallback_llm";
  result.decision = "unsupported_or_unclear_intent";
  result.allowedToUseRuleEngine = false;
  result.requiresFallback = true;
  result.requiresClarification = false;
  result.requiresEscalation = false;
  result.reason =
    "The intent is not supported by the current rule engine. Use polite fallback instead of harsh failure.";

  return result;
}

module.exports = {
  evaluateConfidence,

  _internal: {
    HIGH_CONFIDENCE_THRESHOLD,
    LOW_CONFIDENCE_THRESHOLD,
    ORDER_REQUIRED_INTENTS,
    POLICY_INTENTS,
    DIRECT_INFO_INTENTS,
    SAFE_NON_ORDER_INTENTS,
    normalizeText,
    normalizeConfidence,
    includesAny,
    isAngryCustomer,
    isUnsafeInput,
    isHumanSupportRequest,
    getMissingEntities,
    buildBaseResult,
  },
};