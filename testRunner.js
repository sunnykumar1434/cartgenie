const { processQuery } = require("./app");
const orders = require("./orders.json");

// =========================
// 🧠 ORDER CLASSIFIER
// =========================

function classifyOrder(o) {

  if (o.status === "delivered") {
    return "DELIVERED";
  }

  if (o.status === "shipped") {
    return "SHIPPED";
  }

  if (o.status === "out_for_delivery") {
    return "OUT_FOR_DELIVERY";
  }

  if (o.status === "RTO") {
    return "RTO";
  }

  if (o.status === "packed" || o.status === "confirmed") {
    return "PRE_SHIPMENT";
  }

  return "UNKNOWN";
}

// =========================
// 🧪 TEST GENERATOR
// =========================

function generateTests() {

  const tests = [];

  for (const order of orders) {

    const state = classifyOrder(order);

    // =========================
    // CANCEL FLOW TESTS
    // =========================

    if (state === "PRE_SHIPMENT") {
      tests.push({
        name: `Cancel Allowed - ${order.orderId}`,
        session: order.userId,
        input: `cancel ${order.orderId}`,
        expect: "success"
      });
    }

    if (state === "SHIPPED" || state === "DELIVERED") {
      tests.push({
        name: `Cancel Blocked - ${order.orderId}`,
        session: order.userId,
        input: `cancel ${order.orderId}`,
        expect: "guidance"
      });
    }

    // =========================
    // RETURN TESTS
    // =========================

    if (state === "DELIVERED") {
      tests.push({
        name: `Return Flow - ${order.orderId}`,
        session: order.userId,
        input: `return ${order.orderId}`,
        expect: "success"
      });
    }

    // =========================
    // REPLACEMENT TESTS
    // =========================

    if (order.delivered && order.defective) {
      tests.push({
        name: `Replacement Eligible - ${order.orderId}`,
        session: order.userId,
        input: `replace ${order.orderId}`,
        expect: "success"
      });
    }

    if (order.delivered && !order.defective) {
      tests.push({
        name: `Replacement Blocked - ${order.orderId}`,
        session: order.userId,
        input: `replace ${order.orderId}`,
        expect: "blocked"
      });
    }

    // =========================
    // PAYMENT EDGE CASES
    // =========================

    if (order.paymentStatus === "failed") {
      tests.push({
        name: `Payment Failure - ${order.orderId}`,
        session: order.userId,
        input: `payment status ${order.orderId}`,
        expectText: ["payment", "failed"]
      });
    }

    // =========================
    // RTO CASE
    // =========================

    if (state === "RTO") {
      tests.push({
        name: `RTO Refund - ${order.orderId}`,
        session: order.userId,
        input: `refund ${order.orderId}`,
        expectText: ["refund", "rto"]
      });
    }
  }

  return tests;
}

// =========================
// 🧪 RUNNER
// =========================

async function run() {

  console.log("\n🚀 DATA-DRIVEN PRODUCTION QA v4\n");

  const tests = generateTests();

  let pass = 0;
  let total = 0;

  for (const t of tests) {

    total++;

    const res = await processQuery(t.input, t.session);

    const output = (res?.response || res).toString().toLowerCase();

    let ok = false;

    if (t.expect === "success") {
      ok = output.includes("success") || output.includes("cancel");
    }

    if (t.expect === "blocked") {
      ok = output.includes("can") || output.includes("not");
    }

    if (t.expect === "guidance") {
      ok = output.includes("return") || output.includes("after");
    }

    if (t.expectText) {
      ok = t.expectText.some(k => output.includes(k));
    }

    if (ok) {
      console.log("✅ PASS", t.name);
      pass++;
    } else {
      console.log("❌ FAIL", t.name);
      console.log("   Response:", res);
    }
  }

  console.log("\n==============================");
  console.log("📊 DATA-DRIVEN QA REPORT");
  console.log("==============================");

  console.log(`Total Tests: ${total}`);
  console.log(`Passed: ${pass}`);
  console.log(`Accuracy: ${((pass / total) * 100).toFixed(2)}%`);

  if (pass / total >= 0.9) {
    console.log("🟢 PRODUCTION READY");
  } else if (pass / total >= 0.8) {
    console.log("🟡 STABLE BUT NEEDS IMPROVEMENT");
  } else {
    console.log("🔴 NOT READY");
  }
}

run();