const orders = require("./orders.json");
const { applyRules } = require("./ruleEngine");

function findOrder(orderId) {
  return orders.find((order) => order.orderId === orderId);
}

const tests = [
  {
    name: "Cancellation allowed",
    intent: "cancel_order",
    orderId: "ORD101"
  },
  {
    name: "Cancellation blocked because shipped",
    intent: "cancel_order",
    orderId: "ORD102"
  },
  {
    name: "Return allowed",
    intent: "return_order",
    orderId: "ORD103"
  },
  {
    name: "Return window expired",
    intent: "return_order",
    orderId: "ORD104"
  },
  {
    name: "Smartphone DOA replacement",
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

  const result = applyRules({
    intent: test.intent,
    order,
    issueType: test.issueType
  });

  console.log("\n==============================");
  console.log(`🧪 ${test.name}`);
  console.log("==============================");
  console.log("Order Found:", order ? order.orderId : "NOT FOUND");
  console.log("Decision:", result.decision);
  console.log("Allowed:", result.allowed);
  console.log("Reason:", result.reason);
  console.log("Escalation:", result.requiresEscalation);
  console.log("Full Result:", result);
}