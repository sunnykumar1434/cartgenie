# CartGenie — Multi-Agent AI Customer Support System

CartGenie is a production-style multi-agent AI customer support backend for Indian e-commerce platforms. It handles customer queries related to order cancellation, returns, refunds, replacement, delivery, tracking, payment issues, and escalation.

The system is designed with a trust-layered architecture where the LLM understands the customer query, but final business decisions are controlled by deterministic policy rules.

---

## Problem Statement

Most customer support chatbots either:

- depend too much on LLMs,
- give generic responses,
- fail on policy-sensitive cases,
- do not handle escalation properly,
- cannot explain why a decision was made.

CartGenie solves this by combining LLM-based intent understanding with rule-based policy enforcement, confidence-based routing, session tracking, fallback handling, escalation, and audit logging.

---

## Key Features

- Multi-agent customer support pipeline
- LLM-powered intent and entity extraction using Groq
- Confidence-based routing
- Rule-based decision engine
- Policy-safe fallback handling
- Session-based repeated failure tracking
- Smart escalation for risky cases
- Audit logging for transparency
- REST API ready for frontend, WhatsApp, Postman, or n8n integration

---

## Final Architecture

```text
User Query
→ LLM Intent + Entity Agent
→ Confidence Agent
→ Rule Engine / Fallback Agent
→ Response Agent
→ Escalation Agent
→ Audit Logger
→ API Response