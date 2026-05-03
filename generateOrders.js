const fs = require("fs");

const TOTAL_RANDOM_ORDERS = 200;

const demoOrders = [
  {
    orderId: "ORD101",
    customerId: "CUST_DEMO_1",
    status: "placed",
    paymentMethod: "upi",
    paymentStatus: "paid",
    orderValue: 1299,
    category: "fashion",
    subcategory: "tshirt",
    issueType: "general",
    returnable: true,
    exchangeable: true,
    replacementEligible: true,
    returnWindowDays: 10,
    replacementWindowDays: 10,
    exchangeWindowDays: 10,
    deliveryDaysAgo: null,
    qualityCheckPassed: null,
    correctProduct: true,
    completeProduct: true,
    unusedProduct: true,
    undamagedProduct: true,
    originalPackaging: true,
    tagsIntact: true,
    accessoriesPresent: true,
    deviceFormatted: null,
    screenLockRemoved: null,
    icloudRemovedIfApple: null,
    isHighRiskUser: false,
    fraudRisk: false,
    repeatedFailures: 0,
    replacementCount: 0,
    exchangeCount: 0,
    isAlteredProduct: false,
    stockAvailableForExchange: true,
    addressServiceable: true,
    trackingId: null
  },
  {
    orderId: "ORD102",
    customerId: "CUST_DEMO_2",
    status: "shipped",
    paymentMethod: "card",
    paymentStatus: "paid",
    orderValue: 2499,
    category: "electronics",
    subcategory: "headphones",
    issueType: "general",
    returnable: false,
    exchangeable: false,
    replacementEligible: true,
    returnWindowDays: 0,
    replacementWindowDays: 7,
    exchangeWindowDays: 0,
    deliveryDaysAgo: null,
    qualityCheckPassed: null,
    correctProduct: true,
    completeProduct: true,
    unusedProduct: true,
    undamagedProduct: true,
    originalPackaging: true,
    tagsIntact: true,
    accessoriesPresent: true,
    deviceFormatted: true,
    screenLockRemoved: true,
    icloudRemovedIfApple: null,
    isHighRiskUser: false,
    fraudRisk: false,
    repeatedFailures: 0,
    replacementCount: 0,
    exchangeCount: 0,
    isAlteredProduct: false,
    stockAvailableForExchange: false,
    addressServiceable: true,
    trackingId: "TRK102"
  },
  {
    orderId: "ORD103",
    customerId: "CUST_DEMO_3",
    status: "delivered",
    paymentMethod: "upi",
    paymentStatus: "paid",
    orderValue: 1499,
    category: "fashion",
    subcategory: "kurti",
    issueType: "general",
    returnable: true,
    exchangeable: true,
    replacementEligible: true,
    returnWindowDays: 10,
    replacementWindowDays: 10,
    exchangeWindowDays: 10,
    deliveryDaysAgo: 3,
    qualityCheckPassed: null,
    correctProduct: true,
    completeProduct: true,
    unusedProduct: true,
    undamagedProduct: true,
    originalPackaging: true,
    tagsIntact: true,
    accessoriesPresent: true,
    deviceFormatted: null,
    screenLockRemoved: null,
    icloudRemovedIfApple: null,
    isHighRiskUser: false,
    fraudRisk: false,
    repeatedFailures: 0,
    replacementCount: 0,
    exchangeCount: 0,
    isAlteredProduct: false,
    stockAvailableForExchange: true,
    addressServiceable: true,
    trackingId: "TRK103"
  },
  {
    orderId: "ORD104",
    customerId: "CUST_DEMO_4",
    status: "delivered",
    paymentMethod: "upi",
    paymentStatus: "paid",
    orderValue: 1499,
    category: "fashion",
    subcategory: "jeans",
    issueType: "general",
    returnable: true,
    exchangeable: true,
    replacementEligible: true,
    returnWindowDays: 10,
    replacementWindowDays: 10,
    exchangeWindowDays: 10,
    deliveryDaysAgo: 14,
    qualityCheckPassed: null,
    correctProduct: true,
    completeProduct: true,
    unusedProduct: true,
    undamagedProduct: true,
    originalPackaging: true,
    tagsIntact: true,
    accessoriesPresent: true,
    deviceFormatted: null,
    screenLockRemoved: null,
    icloudRemovedIfApple: null,
    isHighRiskUser: false,
    fraudRisk: false,
    repeatedFailures: 0,
    replacementCount: 0,
    exchangeCount: 0,
    isAlteredProduct: false,
    stockAvailableForExchange: true,
    addressServiceable: true,
    trackingId: "TRK104"
  },
  {
    orderId: "ORD105",
    customerId: "CUST_DEMO_5",
    status: "delivered",
    paymentMethod: "card",
    paymentStatus: "paid",
    orderValue: 68999,
    category: "smartphone",
    subcategory: "mobile",
    issueType: "dead_on_arrival",
    returnable: false,
    exchangeable: false,
    replacementEligible: true,
    returnWindowDays: 0,
    replacementWindowDays: 7,
    exchangeWindowDays: 0,
    deliveryDaysAgo: 2,
    qualityCheckPassed: null,
    correctProduct: true,
    completeProduct: true,
    unusedProduct: true,
    undamagedProduct: true,
    originalPackaging: true,
    tagsIntact: true,
    accessoriesPresent: true,
    deviceFormatted: true,
    screenLockRemoved: true,
    icloudRemovedIfApple: true,
    isHighRiskUser: false,
    fraudRisk: false,
    repeatedFailures: 0,
    replacementCount: 0,
    exchangeCount: 0,
    isAlteredProduct: false,
    stockAvailableForExchange: false,
    addressServiceable: true,
    trackingId: "TRK105"
  },
  {
    orderId: "ORD106",
    customerId: "CUST_DEMO_6",
    status: "delivered",
    paymentMethod: "upi",
    paymentStatus: "double_charged",
    orderValue: 3499,
    category: "electronics",
    subcategory: "speaker",
    issueType: "payment_conflict",
    returnable: false,
    exchangeable: false,
    replacementEligible: true,
    returnWindowDays: 0,
    replacementWindowDays: 7,
    exchangeWindowDays: 0,
    deliveryDaysAgo: 2,
    qualityCheckPassed: null,
    correctProduct: true,
    completeProduct: true,
    unusedProduct: true,
    undamagedProduct: true,
    originalPackaging: true,
    tagsIntact: true,
    accessoriesPresent: true,
    deviceFormatted: true,
    screenLockRemoved: true,
    icloudRemovedIfApple: null,
    isHighRiskUser: false,
    fraudRisk: false,
    repeatedFailures: 1,
    replacementCount: 0,
    exchangeCount: 0,
    isAlteredProduct: false,
    stockAvailableForExchange: false,
    addressServiceable: true,
    trackingId: "TRK106"
  }
];

const categories = [
  {
    category: "fashion",
    subcategories: ["tshirt", "shirt", "jeans", "kurti", "sari", "shoes"],
    returnable: true,
    exchangeable: true,
    replacementEligible: true,
    returnWindowDays: 10,
    replacementWindowDays: 10,
    exchangeWindowDays: 10,
    minValue: 499,
    maxValue: 4999
  },
  {
    category: "home",
    subcategories: ["bedsheet", "furnishing", "home_decor", "utensils"],
    returnable: true,
    exchangeable: true,
    replacementEligible: true,
    returnWindowDays: 7,
    replacementWindowDays: 7,
    exchangeWindowDays: 7,
    minValue: 299,
    maxValue: 7999
  },
  {
    category: "electronics",
    subcategories: ["headphones", "speaker", "smartwatch", "tablet"],
    returnable: false,
    exchangeable: false,
    replacementEligible: true,
    returnWindowDays: 0,
    replacementWindowDays: 7,
    exchangeWindowDays: 0,
    minValue: 999,
    maxValue: 49999
  },
  {
    category: "smartphone",
    subcategories: ["mobile"],
    returnable: false,
    exchangeable: false,
    replacementEligible: true,
    returnWindowDays: 0,
    replacementWindowDays: 7,
    exchangeWindowDays: 0,
    minValue: 7999,
    maxValue: 120000
  },
  {
    category: "personal_care",
    subcategories: ["toothbrush", "soap", "sanitary_product"],
    returnable: false,
    exchangeable: false,
    replacementEligible: false,
    returnWindowDays: 0,
    replacementWindowDays: 0,
    exchangeWindowDays: 0,
    minValue: 99,
    maxValue: 1999
  },
  {
    category: "grocery_regular",
    subcategories: ["atta", "rice", "pulses", "oil"],
    returnable: true,
    exchangeable: false,
    replacementEligible: false,
    returnWindowDays: 7,
    replacementWindowDays: 0,
    exchangeWindowDays: 0,
    minValue: 99,
    maxValue: 2999
  }
];

const statuses = [
  "placed",
  "confirmed",
  "processing",
  "shipped",
  "out_for_delivery",
  "delivered",
  "return_picked",
  "return_received",
  "quality_check_passed",
  "refund_initiated",
  "refund_completed",
  "delivery_failed",
  "lost_in_transit"
];

const paymentMethods = ["upi", "card", "netbanking", "wallet", "cod"];
const normalPaymentStatuses = ["paid", "pending", "refunded"];
const issueTypes = [
  "general",
  "defective_product",
  "damaged_product",
  "wrong_product",
  "missing_item",
  "technical_issue",
  "payment_conflict",
  "refund_dispute"
];

function randomItem(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randomNumber(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomBoolean(prob = 0.5) {
  return Math.random() < prob;
}

function generateRandomOrder(index) {
  const product = randomItem(categories);
  const status = randomItem(statuses);
  const paymentMethod = randomItem(paymentMethods);
  const issueType = randomItem(issueTypes);

  let paymentStatus = randomItem(normalPaymentStatuses);

  if (issueType === "payment_conflict") {
    paymentStatus = randomItem([
      "double_charged",
      "refund_failed",
      "refund_not_received",
      "payment_pending_but_debited"
    ]);
  }

  const deliveredStatuses = [
    "delivered",
    "return_picked",
    "return_received",
    "quality_check_passed",
    "refund_initiated",
    "refund_completed"
  ];

  const deliveryDaysAgo = deliveredStatuses.includes(status)
    ? randomNumber(1, 20)
    : null;

  return {
    orderId: `ORD${String(index).padStart(3, "0")}`,
    customerId: `CUST${String(randomNumber(1, 80)).padStart(3, "0")}`,
    status,
    paymentMethod,
    paymentStatus,
    orderValue: randomNumber(product.minValue, product.maxValue),
    category: product.category,
    subcategory: randomItem(product.subcategories),
    issueType,
    returnable: product.returnable,
    exchangeable: product.exchangeable,
    replacementEligible: product.replacementEligible,
    returnWindowDays: product.returnWindowDays,
    replacementWindowDays: product.replacementWindowDays,
    exchangeWindowDays: product.exchangeWindowDays,
    deliveryDaysAgo,
    qualityCheckPassed: ["quality_check_passed", "refund_initiated", "refund_completed"].includes(status)
      ? true
      : status === "return_received"
      ? randomBoolean(0.7)
      : null,
    correctProduct: randomBoolean(0.95),
    completeProduct: randomBoolean(0.95),
    unusedProduct: randomBoolean(0.9),
    undamagedProduct: randomBoolean(0.9),
    originalPackaging: randomBoolean(0.9),
    tagsIntact: randomBoolean(0.9),
    accessoriesPresent: randomBoolean(0.92),
    deviceFormatted: ["electronics", "smartphone"].includes(product.category)
      ? randomBoolean(0.8)
      : null,
    screenLockRemoved: ["electronics", "smartphone"].includes(product.category)
      ? randomBoolean(0.8)
      : null,
    icloudRemovedIfApple: product.category === "smartphone" ? randomBoolean(0.85) : null,
    isHighRiskUser: randomBoolean(0.05),
    fraudRisk: randomBoolean(0.03),
    repeatedFailures: randomNumber(0, 2),
    replacementCount: randomBoolean(0.08) ? 1 : 0,
    exchangeCount: randomBoolean(0.06) ? 1 : 0,
    isAlteredProduct: product.category === "fashion" ? randomBoolean(0.04) : false,
    stockAvailableForExchange: randomBoolean(0.8),
    addressServiceable: randomBoolean(0.92),
    trackingId: ["shipped", "out_for_delivery", "delivered", "delivery_failed", "lost_in_transit"].includes(status)
      ? `TRK${String(index).padStart(3, "0")}`
      : null
  };
}

const randomOrders = [];

let index = 107;

while (randomOrders.length < TOTAL_RANDOM_ORDERS) {
  randomOrders.push(generateRandomOrder(index));
  index++;
}

const allOrders = [...demoOrders, ...randomOrders];

fs.writeFileSync("./orders.json", JSON.stringify(allOrders, null, 2));

console.log("✅ orders.json regenerated with CartGenie schema");
console.log(`📦 Total orders: ${allOrders.length}`);
console.log("Demo orders:");
console.log("ORD101 → cancel allowed");
console.log("ORD102 → cancel blocked shipped");
console.log("ORD103 → return allowed");
console.log("ORD104 → return window expired");
console.log("ORD105 → smartphone DOA replacement");
console.log("ORD106 → payment conflict escalation");