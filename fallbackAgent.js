// fallbackAgent.js
// Handles greeting, conversation end, general support, policy FAQs,
// unclear queries, unsafe requests, and polite redirection when the request
// should not go to the rule engine.

function normalizeText(text = "") {
  return String(text || "").trim().toLowerCase();
}

function includesAny(text = "", patterns = []) {
  const cleanText = normalizeText(text);
  return patterns.some((pattern) => cleanText.includes(pattern));
}

function isGreetingQuery(query = "") {
  const cleanText = normalizeText(query);

  return /^(hi|hii|hiii|hello|helo|helloo|hey|heyy|he|hy|good morning|good afternoon|good evening|namaste|namaskar)$/i.test(
    cleanText
  );
}

function isConversationEndQuery(query = "") {
  const cleanText = normalizeText(query);

  return [
    "thanks",
    "thank you",
    "thankyou",
    "thanks a lot",
    "thank you so much",
    "okay thanks",
    "ok thanks",
    "ok thank you",
    "okay thank you",
    "done",
    "okay done",
    "ok done",
    "got it",
    "understood",
    "fine",
    "cool",
    "great",
    "nice",
    "perfect",
    "that helps",
    "helpful",
  ].includes(cleanText);
}

function getIntentFriendlyName(intent = "") {
  const map = {
    greeting: "greeting",
    conversation_end: "conversation end",
    general_support: "order support",
    non_commerce_request: "general query",
    unsafe_request: "safety-sensitive request",

    cancel_order: "cancellation",
    return_order: "return",
    replace_order: "replacement",
    refund_status: "refund",
    refund_policy: "refund",
    exchange_order: "exchange",
    track_order: "tracking",
    delivery_issue: "delivery",
    delivery_policy: "delivery",
    payment_issue: "payment",
    missing_item: "missing item",
    wrong_item: "wrong item",
    damaged_item: "damaged item",

    return_policy: "return policy",
    replacement_policy: "replacement policy",
    cancellation_policy: "cancellation policy",
    human_support: "human support",
    order_reference_only: "order reference",
  };

  return map[intent] || "order support";
}

function getOrderIdText(orderId) {
  return orderId ? ` for order ${orderId}` : "";
}

function buildResponse(status, customerMessage, internal = {}) {
  return {
    success: true,
    status,
    message: customerMessage,
    customerMessage,
    internal,
  };
}

// ===============================
// POLICY / FAQ RESPONSES
// ===============================

function getPolicyMessage(intent = "", intentResult = {}) {
  const orderText = getOrderIdText(intentResult.orderId);

  switch (intent) {
    case "delivery_policy":
      return `Sure, I can help with delivery details. Most orders are delivered within 3-7 business days depending on the product, seller, courier partner, and delivery location. For exact delivery tracking${orderText}, please share your order ID, like ORD101.`;

    case "refund_policy":
      return `Sure, I can help with refund tracking. Refunds usually take 3-7 business days after cancellation or return approval. Card or bank refunds can sometimes take 7-10 business days depending on the bank. Please share your order ID, like ORD101, so I can check the exact refund status.`;

    case "return_policy":
      return `Sure, I can help with return eligibility. Returns depend on the product category, return window, item condition, pickup availability, and quality check. Please share your order ID, like ORD101, and I’ll check the exact return eligibility for you.`;

    case "replacement_policy":
      return `Sure, I can help with replacement eligibility. Replacement is usually checked for damaged, defective, wrong, missing, incomplete, technical issue, or dead-on-arrival cases within the allowed replacement window. Please share your order ID, like ORD101, so I can check the exact policy for your order.`;

    case "cancellation_policy":
      return `Sure, I can help with cancellation. Cancellation is usually possible before the order is dispatched or shipped. Once it is shipped, out for delivery, or delivered, direct cancellation may no longer be available. Please share your order ID, like ORD101, and I’ll check the exact status for you.`;

    default:
      return `Sure, I can help with this. Please share your order ID, like ORD101, so I can check the exact details and guide you correctly.`;
  }
}

// ===============================
// FALLBACK RESPONSE GENERATOR
// ===============================

function generateFallbackResponse(
  confidenceResult = {},
  intentResult = {},
  sessionState = {}
) {
  const intent =
    intentResult.intent || confidenceResult.intent || "general_support";

  const decision = confidenceResult.decision || "fallback";
  const friendlyIntent = getIntentFriendlyName(intent);
  const orderId = intentResult.orderId || sessionState.lastOrderId || null;

  // Greeting
  if (
    intent === "greeting" ||
    decision === "greeting_detected" ||
    isGreetingQuery(intentResult.rawText)
  ) {
    return buildResponse(
      "GREETING",
      "Hi, welcome to CartGenie AI. How can I help you today? I can help with order tracking, cancellation, returns, refunds, replacement, exchange, delivery, and payment issues. If your request is related to an order, please share your order ID like ORD101.",
      {
        decision: "greeting_detected",
        intent,
      }
    );
  }

  // Conversation end / thanks
  if (
    intent === "conversation_end" ||
    decision === "conversation_end" ||
    isConversationEndQuery(intentResult.rawText)
  ) {
    return buildResponse(
      "CONVERSATION_END",
      "You’re welcome. I’m glad I could help. If you need anything else with your order later, just message me anytime.",
      {
        decision: "conversation_end",
        intent,
      }
    );
  }

  // Unsafe / prompt injection / bypass
  if (intent === "unsafe_request" || decision === "unsafe_input_detected") {
    return buildResponse(
      "SAFETY_REVIEW",
      "I’m sorry, but I cannot follow requests that try to bypass support rules, access admin features, or skip safety checks. I can still help you with a genuine order-related concern such as tracking, refund, cancellation, return, replacement, or payment issue.",
      {
        decision: "unsafe_input_detected",
        intent,
        riskSignals: confidenceResult.riskSignals || [],
      }
    );
  }

  // Policy FAQs
  const policyIntents = [
    "delivery_policy",
    "refund_policy",
    "return_policy",
    "replacement_policy",
    "cancellation_policy",
  ];

  if (policyIntents.includes(intent) || decision === "general_policy_query") {
    return buildResponse("INFO", getPolicyMessage(intent, intentResult), {
      decision: "general_policy_query",
      intent,
      pendingIntent: intent,
    });
  }

  // Off-topic / non-commerce
  if (intent === "non_commerce_request" || decision === "non_commerce_request") {
    return buildResponse(
      "OFF_TOPIC_OR_UNCLEAR",
      "I understand your message, but I’m mainly here to help with CartGenie order support. I can help with tracking, cancellation, returns, refunds, replacement, exchange, delivery, and payment issues. Please share your order-related concern, and I’ll guide you.",
      {
        decision: "non_commerce_request",
        intent,
      }
    );
  }

  // Medium confidence general support
  if (
    intent === "general_support" ||
    decision === "general_support" ||
    decision === "medium_confidence_general_support"
  ) {
    return buildResponse(
      "CLARIFICATION_REQUIRED",
      orderId
        ? `I can help with that. Since you already shared order ${orderId}, please tell me what you want to do next: track it, cancel it, return it, replace it, exchange it, or check refund/payment status.`
        : "Sure, I can help. Please tell me what you need help with, such as tracking an order, cancelling an order, checking refund status, returning a product, replacing a defective item, or resolving a payment issue. If you have an order ID, please share it in a format like ORD101.",
      {
        decision,
        intent,
        orderId,
      }
    );
  }

  // Low confidence
  if (decision === "low_confidence") {
    return buildResponse(
      "CLARIFICATION_REQUIRED",
      "I want to make sure I understand you correctly. Could you please share a little more detail about your order-related issue? For example, you can say: track my order ORD108, cancel my order ORD101, check refund status ORD106, or my product is damaged ORD112.",
      {
        decision,
        intent,
        confidence: intentResult.confidence,
      }
    );
  }

  // Unsupported or unclear
  if (
    decision === "unsupported_or_unclear_intent" ||
    decision === "fallback" ||
    decision === "medium_confidence_needs_clarification"
  ) {
    return buildResponse(
      "CLARIFICATION_REQUIRED",
      `I can help with your ${friendlyIntent} request, but I need a little more detail to guide you correctly. Please share your order ID, like ORD101, and tell me whether you want tracking, cancellation, return, replacement, exchange, refund, delivery, or payment support.`,
      {
        decision,
        intent,
        confidence: intentResult.confidence,
      }
    );
  }

  // Human support fallback message, in case routed here accidentally
  if (
    intent === "human_support" ||
    decision === "customer_requested_human_support"
  ) {
    return buildResponse(
      "ESCALATION_REQUIRED",
      "Of course. I’ll mark this conversation for human support review. If this is related to a specific order, please share the order ID so the support team can check it faster.",
      {
        decision: "customer_requested_human_support",
        intent,
      }
    );
  }

  // Default polite fallback
  return buildResponse(
    "CLARIFICATION_REQUIRED",
    "I’m here to help. Could you please share your complete order-related issue? You can ask about tracking, cancellation, return, replacement, exchange, refund, delivery, or payment. If you have an order ID, please share it in a format like ORD101.",
    {
      decision,
      intent,
      confidence: intentResult.confidence,
    }
  );
}

// ===============================
// FALLBACK ESCALATION
// ===============================

function buildFallbackEscalation(confidenceResult = {}) {
  const triggers = confidenceResult.riskSignals || [];

  if (
    triggers.includes("unsafe_input_detected") ||
    confidenceResult.decision === "unsafe_input_detected"
  ) {
    const ticketId = `CG-SAFE-${Math.floor(100000 + Math.random() * 900000)}`;

    return {
      ticketRequired: true,
      ticketId,
      priority: "LOW",
      assignedTeam: "Safety Review",
      sla: "2 business days",
      title: "[LOW] Safety review required",
      reason: "Unsafe or policy-bypass input was detected and safely refused.",
      reasons: [
        {
          trigger: "unsafe_input_detected",
          reason:
            "Customer message attempted to bypass support rules or access restricted behavior.",
        },
      ],
      escalationTriggers: ["unsafe_input_detected"],
      customerMessage: `This request was safely refused and marked for safety review. Ticket ID: ${ticketId}.`,
      internalNotes: {
        createdAt: new Date().toISOString(),
      },
    };
  }

  if (
    triggers.includes("customer_requested_human_support") ||
    confidenceResult.decision === "customer_requested_human_support"
  ) {
    const ticketId = `CG-HUM-${Math.floor(100000 + Math.random() * 900000)}`;

    return {
      ticketRequired: true,
      ticketId,
      priority: "MEDIUM",
      assignedTeam: "General Support",
      sla: "1 business day",
      title: "[MEDIUM] Human support requested",
      reason: "Customer requested a human support agent.",
      reasons: [
        {
          trigger: "customer_requested_human_support",
          reason: "Customer explicitly asked to speak with human support.",
        },
      ],
      escalationTriggers: ["customer_requested_human_support"],
      customerMessage: `Your request has been marked for human support review. Expected review time: 1 business day. Ticket ID: ${ticketId}.`,
      internalNotes: {
        createdAt: new Date().toISOString(),
      },
    };
  }

  if (triggers.includes("angry_customer")) {
    const ticketId = `CG-ANG-${Math.floor(100000 + Math.random() * 900000)}`;

    return {
      ticketRequired: true,
      ticketId,
      priority: "MEDIUM",
      assignedTeam: "Customer Experience",
      sla: "1 business day",
      title: "[MEDIUM] Customer sentiment review required",
      reason: "Customer tone indicates frustration or dissatisfaction.",
      reasons: [
        {
          trigger: "angry_customer",
          reason:
            "Customer appears frustrated and may need careful support handling.",
        },
      ],
      escalationTriggers: ["angry_customer"],
      customerMessage: `I’ve marked this for careful support review. Expected review time: 1 business day. Ticket ID: ${ticketId}.`,
      internalNotes: {
        createdAt: new Date().toISOString(),
      },
    };
  }

  return {
    ticketRequired: false,
  };
}

module.exports = {
  generateFallbackResponse,
  buildFallbackEscalation,
  isGreetingQuery,
  isConversationEndQuery,

  _internal: {
    normalizeText,
    includesAny,
    getIntentFriendlyName,
    getOrderIdText,
    buildResponse,
    getPolicyMessage,
  },
};