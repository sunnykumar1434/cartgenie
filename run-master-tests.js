// run-master-tests.js

const testCases = require("./cartgenie-master-test-cases");

const API_URL = "http://localhost:5001/api/support";

function normalizeText(value) {
  return String(value || "").toLowerCase();
}

function getBotMessage(data) {
  if (!data) return "";

  if (typeof data === "string") return data;

  if (data.customerMessage) return data.customerMessage;
  if (data.message) return data.message;
  if (data.reply) return data.reply;

  if (data.response && typeof data.response === "string") {
    return data.response;
  }

  if (data.response && data.response.customerMessage) {
    return data.response.customerMessage;
  }

  if (data.data && data.data.customerMessage) {
    return data.data.customerMessage;
  }

  if (data.data && data.data.message) {
    return data.data.message;
  }

  return JSON.stringify(data);
}

function checkIncludesAny(botMessage, includesAny = []) {
  if (!includesAny || includesAny.length === 0) {
    return {
      pass: true,
      detail: "No includesAny check"
    };
  }

  const text = normalizeText(botMessage);

  const matched = includesAny.find((item) =>
    text.includes(normalizeText(item))
  );

  return {
    pass: Boolean(matched),
    detail: matched
      ? `Matched includesAny: "${matched}"`
      : `None matched. Expected any of: ${includesAny.join(", ")}`
  };
}

function checkExcludes(botMessage, excludes = []) {
  if (!excludes || excludes.length === 0) {
    return {
      pass: true,
      detail: "No excludes check"
    };
  }

  const text = normalizeText(botMessage);

  const matched = excludes.find((item) =>
    text.includes(normalizeText(item))
  );

  return {
    pass: !matched,
    detail: matched
      ? `Found excluded text: "${matched}"`
      : "No excluded text found"
  };
}

async function sendMessage(sessionId, query) {
  const response = await fetch(API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      sessionId,
      query
    })
  });

  const raw = await response.text();

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    data = raw;
  }

  if (!response.ok) {
    throw new Error(
      `API failed with status ${response.status}: ${JSON.stringify(data)}`
    );
  }

  return data;
}

async function runTests() {
  console.log("========================================");
  console.log("CartGenie Master Test Runner Started");
  console.log("API:", API_URL);
  console.log("Total test cases:", testCases.length);
  console.log("========================================\n");

  let totalTurns = 0;
  let passedTurns = 0;
  let failedTurns = 0;
  const failures = [];

  for (const testCase of testCases) {
    const sessionId = `test_${testCase.id}_${Date.now()}_${Math.random()
      .toString(16)
      .slice(2)}`;

    console.log(`\n[${testCase.id}] ${testCase.title}`);
    console.log(`Category: ${testCase.category}`);
    console.log("----------------------------------------");

    for (let i = 0; i < testCase.turns.length; i++) {
      totalTurns++;

      const turn = testCase.turns[i];
      const userQuery = turn.user;
      const expected = turn.expect || {};

      try {
        const data = await sendMessage(sessionId, userQuery);
        const botMessage = getBotMessage(data);

        const includeCheck = checkIncludesAny(
          botMessage,
          expected.includesAny || []
        );

        const excludeCheck = checkExcludes(
          botMessage,
          expected.excludes || []
        );

        const passed = includeCheck.pass && excludeCheck.pass;

        if (passed) {
          passedTurns++;
          console.log(`✅ Turn ${i + 1}`);
        } else {
          failedTurns++;
          console.log(`❌ Turn ${i + 1}`);

          failures.push({
            testId: testCase.id,
            title: testCase.title,
            turn: i + 1,
            userQuery,
            botMessage,
            includeCheck,
            excludeCheck
          });
        }

        console.log("User:", userQuery);
        console.log("Bot :", botMessage);
        console.log("Include:", includeCheck.detail);
        console.log("Exclude:", excludeCheck.detail);
        console.log("");
      } catch (error) {
        failedTurns++;

        console.log(`❌ Turn ${i + 1} crashed`);
        console.log("User:", userQuery);
        console.log("Error:", error.message);

        failures.push({
          testId: testCase.id,
          title: testCase.title,
          turn: i + 1,
          userQuery,
          error: error.message
        });
      }
    }
  }

  console.log("\n========================================");
  console.log("Test Summary");
  console.log("========================================");
  console.log("Total turns :", totalTurns);
  console.log("Passed      :", passedTurns);
  console.log("Failed      :", failedTurns);

  const accuracy =
    totalTurns === 0 ? 0 : ((passedTurns / totalTurns) * 100).toFixed(2);

  console.log("Accuracy    :", `${accuracy}%`);

  if (failures.length > 0) {
    console.log("\n========================================");
    console.log("Failures");
    console.log("========================================");

    failures.forEach((failure, index) => {
      console.log(`\n#${index + 1}`);
      console.log("Test ID :", failure.testId);
      console.log("Title   :", failure.title);
      console.log("Turn    :", failure.turn);
      console.log("User    :", failure.userQuery);

      if (failure.error) {
        console.log("Error   :", failure.error);
      } else {
        console.log("Bot     :", failure.botMessage);
        console.log("Include :", failure.includeCheck.detail);
        console.log("Exclude :", failure.excludeCheck.detail);
      }
    });
  }

  console.log("\nDone.");
}

runTests().catch((error) => {
  console.error("Runner crashed:", error);
});