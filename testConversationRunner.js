const BASE_URL = process.env.CARTGENIE_API_URL || "http://localhost:5001/api/support";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function printHeader(title) {
  console.log("\n==================================================");
  console.log(`🧪 ${title}`);
  console.log("==================================================");
}

function printStep(stepNumber, query) {
  console.log(`\n➡️ Step ${stepNumber}: ${query}`);
}

function getCustomerMessage(data) {
  return (
    data?.response?.customerMessage ||
    data?.response?.message ||
    data?.fallback?.customerMessage ||
    data?.message ||
    "No customer message found"
  );
}

function getIntent(data) {
  return data?.intentResult?.intent || null;
}

function getOrderId(data) {
  return data?.intentResult?.orderId || data?.ruleResult?.orderId || null;
}

function getRoute(data) {
  return data?.confidenceResult?.route || null;
}

function getDecision(data) {
  return (
    data?.ruleResult?.decision ||
    data?.confidenceResult?.decision ||
    data?.response?.internal?.decision ||
    null
  );
}

function getStatus(data) {
  return data?.response?.status || null;
}

function getEscalationRequired(data) {
  return (
    data?.escalation?.ticketRequired === true ||
    data?.ruleResult?.requiresEscalation === true ||
    data?.response?.internal?.requiresEscalation === true
  );
}

function containsAny(text = "", keywords = []) {
  const lower = String(text).toLowerCase();
  return keywords.some((word) => lower.includes(String(word).toLowerCase()));
}

async function sendQuery(sessionId, query) {
  const response = await fetch(BASE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      sessionId,
      query,
    }),
  });

  const data = await response.json();

  return {
    httpStatus: response.status,
    data,
  };
}

function evaluateExpectation(data, expected) {
  const customerMessage = getCustomerMessage(data);
  const actualIntent = getIntent(data);
  const actualOrderId = getOrderId(data);
  const actualRoute = getRoute(data);
  const actualDecision = getDecision(data);
  const actualStatus = getStatus(data);
  const escalationRequired = getEscalationRequired(data);

  const failures = [];

  if (expected.intent && actualIntent !== expected.intent) {
    failures.push(`Expected intent "${expected.intent}", got "${actualIntent}"`);
  }

  if (expected.orderId !== undefined && actualOrderId !== expected.orderId) {
    failures.push(`Expected orderId "${expected.orderId}", got "${actualOrderId}"`);
  }

  if (expected.route && actualRoute !== expected.route) {
    failures.push(`Expected route "${expected.route}", got "${actualRoute}"`);
  }

  if (expected.decision && actualDecision !== expected.decision) {
    failures.push(`Expected decision "${expected.decision}", got "${actualDecision}"`);
  }

  if (expected.status && actualStatus !== expected.status) {
    failures.push(`Expected status "${expected.status}", got "${actualStatus}"`);
  }

  if (
    expected.escalationRequired !== undefined &&
    escalationRequired !== expected.escalationRequired
  ) {
    failures.push(
      `Expected escalationRequired "${expected.escalationRequired}", got "${escalationRequired}"`
    );
  }

  if (
    expected.messageShouldInclude &&
    !containsAny(customerMessage, expected.messageShouldInclude)
  ) {
    failures.push(
      `Customer message should include one of: ${expected.messageShouldInclude.join(", ")}`
    );
  }

  return {
    passed: failures.length === 0,
    failures,
    actual: {
      intent: actualIntent,
      orderId: actualOrderId,
      route: actualRoute,
      decision: actualDecision,
      status: actualStatus,
      escalationRequired,
      customerMessage,
    },
  };
}

async function runScenario(scenario) {
  printHeader(scenario.name);

  let passedSteps = 0;
  let failedSteps = 0;

  for (let i = 0; i < scenario.steps.length; i++) {
    const step = scenario.steps[i];

    printStep(i + 1, step.query);

    try {
      const result = await sendQuery(scenario.sessionId, step.query);
      const data = result.data;

      const evaluation = evaluateExpectation(data, step.expected || {});

      console.log("\nCustomer Message:");
      console.log(getCustomerMessage(data));

      console.log("\nTrace:");
      console.log({
        intent: getIntent(data),
        orderId: getOrderId(data),
        route: getRoute(data),
        decision: getDecision(data),
        status: getStatus(data),
        escalationRequired: getEscalationRequired(data),
      });

      if (evaluation.passed) {
        console.log("\n✅ PASS");
        passedSteps++;
      } else {
        console.log("\n❌ FAIL");
        evaluation.failures.forEach((failure) => console.log(`   - ${failure}`));
        failedSteps++;
      }

      if (process.env.SHOW_FULL_RESPONSE === "true") {
        console.log("\nFull Response:");
        console.dir(data, { depth: null });
      }

      await sleep(500);
    } catch (error) {
      console.log("\n❌ ERROR");
      console.log(error.message);
      failedSteps++;
    }
  }

  return {
    scenario: scenario.name,
    passedSteps,
    failedSteps,
    totalSteps: scenario.steps.length,
  };
}

const scenarios = [
  {
    name: "Cancellation with order ID should go to Rule Engine",
    sessionId: "test_cancel_with_order_id",
    steps: [
      {
        query: "I want to cancel my order ORD101",
        expected: {
          intent: "cancel_order",
          orderId: "ORD101",
          route: "rule_engine",
          decision: "cancel_allowed_refund_initiated",
          status: "APPROVED",
          escalationRequired: false,
          messageShouldInclude: ["eligible", "cancellation", "refund"],
        },
      },
    ],
  },

  {
    name: "Cancellation without order ID should ask clarification",
    sessionId: "test_cancel_without_order_id",
    steps: [
      {
        query: "I want to cancel my order",
        expected: {
          intent: "cancel_order",
          orderId: null,
          route: "clarification",
          escalationRequired: false,
          messageShouldInclude: ["order id", "share your order", "please provide"],
        },
      },
    ],
  },

  {
    name: "Return without order ID should ask clarification",
    sessionId: "test_return_without_order_id",
    steps: [
      {
        query: "I want to return my product",
        expected: {
          intent: "return_order",
          orderId: null,
          route: "clarification",
          escalationRequired: false,
          messageShouldInclude: ["order id", "share your order", "please provide"],
        },
      },
    ],
  },

  {
    name: "Return with order ID should apply return policy",
    sessionId: "test_return_with_order_id",
    steps: [
      {
        query: "I want to return ORD103",
        expected: {
          intent: "return_order",
          orderId: "ORD103",
          route: "rule_engine",
          decision: "return_allowed",
          status: "APPROVED",
          escalationRequired: false,
          messageShouldInclude: ["eligible", "return", "pickup"],
        },
      },
    ],
  },

  {
    name: "Context switch: user starts cancellation, then switches to return",
    sessionId: "test_context_switch_cancel_to_return",
    steps: [
      {
        query: "I want to cancel my order",
        expected: {
          intent: "cancel_order",
          orderId: null,
          route: "clarification",
          escalationRequired: false,
          messageShouldInclude: ["order id", "share your order", "please provide"],
        },
      },
      {
        query: "Sorry, I want to return instead ORD103",
        expected: {
          intent: "return_order",
          orderId: "ORD103",
          route: "rule_engine",
          decision: "return_allowed",
          status: "APPROVED",
          escalationRequired: false,
          messageShouldInclude: ["eligible", "return"],
        },
      },
    ],
  },

  {
    name: "Context switch: user starts return, then switches to cancellation",
    sessionId: "test_context_switch_return_to_cancel",
    steps: [
      {
        query: "I want to return my product",
        expected: {
          intent: "return_order",
          orderId: null,
          route: "clarification",
          escalationRequired: false,
          messageShouldInclude: ["order id", "share your order", "please provide"],
        },
      },
      {
        query: "Actually cancel it ORD101",
        expected: {
          intent: "cancel_order",
          orderId: "ORD101",
          route: "rule_engine",
          decision: "cancel_allowed_refund_initiated",
          status: "APPROVED",
          escalationRequired: false,
          messageShouldInclude: ["eligible", "cancellation", "refund"],
        },
      },
    ],
  },

  {
    name: "Shipped order cancellation should be blocked",
    sessionId: "test_shipped_cancel_blocked",
    steps: [
      {
        query: "Cancel my order ORD102",
        expected: {
          intent: "cancel_order",
          orderId: "ORD102",
          route: "rule_engine",
          decision: "cancel_blocked_shipped",
          status: "BLOCKED",
          escalationRequired: false,
          messageShouldInclude: ["shipped", "cancellation", "not available"],
        },
      },
    ],
  },

  {
    name: "Return window expired should be blocked",
    sessionId: "test_return_window_expired",
    steps: [
      {
        query: "I want to return ORD104",
        expected: {
          intent: "return_order",
          orderId: "ORD104",
          route: "rule_engine",
          decision: "return_blocked_window_expired",
          status: "BLOCKED",
          escalationRequired: false,
          messageShouldInclude: ["window", "expired", "not eligible"],
        },
      },
    ],
  },

  {
    name: "Smartphone DOA replacement should escalate",
    sessionId: "test_smartphone_doa_escalation",
    steps: [
      {
        query: "My phone is dead on arrival, replace ORD105",
        expected: {
          intent: "replace_order",
          orderId: "ORD105",
          route: "rule_engine",
          decision: "replacement_requires_doa_certificate",
          status: "ESCALATION_REQUIRED",
          escalationRequired: true,
          messageShouldInclude: ["doa", "certificate", "unboxing", "verification"],
        },
      },
    ],
  },

  {
    name: "Payment conflict should escalate",
    sessionId: "test_payment_conflict_escalation",
    steps: [
      {
        query: "I was double charged for ORD106",
        expected: {
          intent: "payment_issue",
          orderId: "ORD106",
          route: "rule_engine",
          decision: "payment_issue_escalate",
          status: "ESCALATION_REQUIRED",
          escalationRequired: true,
          messageShouldInclude: ["payment", "verification", "ticket"],
        },
      },
    ],
  },

  {
    name: "Off-topic query should go to fallback",
    sessionId: "test_off_topic_fallback",
    steps: [
      {
        query: "Tell me a joke",
        expected: {
          route: "fallback_llm",
          escalationRequired: false,
          messageShouldInclude: ["support", "order", "help", "cartgenie"],
        },
      },
    ],
  },

  {
    name: "Garbage query should not reach Rule Engine",
    sessionId: "test_garbage_query",
    steps: [
      {
        query: "asdasd random blah",
        expected: {
          route: "fallback_llm",
          escalationRequired: false,
          messageShouldInclude: ["support", "order", "help", "understand"],
        },
      },
    ],
  },

  {
    name: "Unknown order ID should be handled safely",
    sessionId: "test_unknown_order_id",
    steps: [
      {
        query: "Cancel my order ORD999",
        expected: {
          intent: "cancel_order",
          orderId: "ORD999",
          route: "rule_engine",
          escalationRequired: false,
          messageShouldInclude: ["not found", "order id", "check"],
        },
      },
    ],
  },

  {
    name: "Repeated unclear queries should test production readiness",
    sessionId: "test_repeated_unclear_queries",
    steps: [
      {
        query: "I need help",
        expected: {
          route: "fallback_llm",
          escalationRequired: false,
          messageShouldInclude: ["order", "support", "help"],
        },
      },
      {
        query: "It is not working",
        expected: {
          route: "fallback_llm",
          escalationRequired: false,
          messageShouldInclude: ["order", "support", "help"],
        },
      },
      {
        query: "You are useless",
        expected: {
          escalationRequired: true,
          messageShouldInclude: ["support", "help", "escalated", "review"],
        },
      },
    ],
  },
];

async function main() {
  console.log("\n🚀 CartGenie Production Conversation Test Runner");
  console.log(`🌐 API URL: ${BASE_URL}`);
  console.log("\nMake sure backend is running before running this file:");
  console.log("node app.js");

  const summary = [];

  for (const scenario of scenarios) {
    const result = await runScenario(scenario);
    summary.push(result);
  }

  const totalSteps = summary.reduce((sum, item) => sum + item.totalSteps, 0);
  const totalPassed = summary.reduce((sum, item) => sum + item.passedSteps, 0);
  const totalFailed = summary.reduce((sum, item) => sum + item.failedSteps, 0);
  const score = ((totalPassed / totalSteps) * 100).toFixed(2);

  console.log("\n\n==================================================");
  console.log("📊 CARTGENIE PRODUCTION TEST SUMMARY");
  console.log("==================================================");

  summary.forEach((item) => {
    const icon = item.failedSteps === 0 ? "✅" : "❌";
    console.log(
      `${icon} ${item.scenario} | Passed: ${item.passedSteps}/${item.totalSteps}`
    );
  });

  console.log("\n--------------------------------------------------");
  console.log(`Total Steps: ${totalSteps}`);
  console.log(`Passed: ${totalPassed}`);
  console.log(`Failed: ${totalFailed}`);
  console.log(`Score: ${score}%`);

  if (totalFailed === 0) {
    console.log("\n🎉 Excellent. CartGenie pipeline passed all production conversation tests.");
  } else if (score >= 80) {
    console.log("\n⚠️ Good, but some edge cases need improvement before final demo.");
  } else {
    console.log("\n❌ Needs improvement. Fix failed scenarios before judge demo.");
  }
}

main();