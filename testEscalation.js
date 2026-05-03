const orders = require("./orders.json");
const { applyRules } = require("./ruleEngine");
const { generateResponse } = require("./responseAgent");
const { handleEscalation } = require("./escalationAgent");

function findOrder(orderId) {
  return orders.find((order) => order.orderId === orderId);
}

const tests = [
  {
    name: "No escalation - cancellation allowed",
    intent: "cancel_order",
    orderId: "ORD101"
  },
  {
    name: "Smartphone DOA escalation",
    intent: "replace_order",
    orderId: "ORD105",
    issueType: "dead_on_arrival"
  },
  {
    name: "Payment conflict escalation",
    intent: "payment_issue",
    orderId: "ORD106"
  }
];

for (const test of tests) {
  const order = findOrder(test.orderId);

  const ruleResult = applyRules({
    intent: test.intent,
    order,
    issueType: test.issueType
  });

  const response = generateResponse(ruleResult);

  const escalation = handleEscalation(ruleResult, {
    query: test.name,
    customerTone: "neutral",
    source: "testEscalation"
  });

  console.log("\n==============================");
  console.log(`🧪 ${test.name}`);
  console.log("==============================");
  console.log("Rule Decision:", ruleResult.decision);
  console.log("Response Status:", response.status);
  console.log("Customer Message:", response.customerMessage);
  console.log("Escalation:", escalation);
}