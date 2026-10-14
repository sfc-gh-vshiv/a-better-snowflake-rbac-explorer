---
name: demo-sales-skill
description: Answer sales questions with the demo sales agent, and run a quick revenue forecast. Demo skill for Role Explorer v2.
---

# Demo sales skill

Use this skill when someone asks about revenue, orders or regions in the demo sales data.

1. For questions in plain English, ask the agent `DEMO_SALES_DB.CORE.DEMO_SALES_AGENT`.
2. For a forecast, call the custom tool directly:

   ```sql
   CALL DEMO_SALES_DB.CORE.DEMO_FORECAST(3);
   ```

3. For a quick check of raw numbers, query the semantic view or the orders table:

   ```sql
   SELECT * FROM SEMANTIC_VIEW(DEMO_SALES_DB.CORE.DEMO_SALES_SV METRICS orders.revenue DIMENSIONS customers.region);
   SELECT COUNT(*) FROM DEMO_SALES_DB.CORE.ORDERS;
   ```

Run queries on warehouse: COMPUTE_WH.
