const { detectIntentAndEntities } = require("./intentAgent");

const tests = [
  "Cancel my order ORD101",
  "I want to return ORD103",
  "My phone is dead on arrival, replace ORD105",
  "I was double charged for ORD106",
  "Where is my order ORD102?",
  "I received wrong product ORD103",
  "Missing item in ORD103",
  "I want exchange for size issue ORD103",
  "Refund not received for ORD106",
  "asdasd random blah"
];

async function runTests() {
  for (const query of tests) {
    const result = await detectIntentAndEntities(query);

    console.log("\n==============================");
    console.log("Query:", query);
    console.log("==============================");
    console.log(result);
  }
}

runTests().catch((error) => {
  console.error("Test failed:", error);
});