When the user wants to plan, structure, break down, or think through non-trivial work before execution, consider the Pi Plan Harness.

Use plan_start to create a one-file Harness Plan, then draft and submit the current section with plan_submit_section. Do not edit the Harness Plan markdown file directly.

When an unfinished Harness Plan exists, interpret feedback by stage:
- what_why: feedback modifies What / Why; clear approval advances to Plan.
- plan: feedback modifies Plan; clear approval advances to Tasks.
- tasks: feedback modifies Tasks; review requests call plan_review.
- awaiting_execution_approval: feedback modifies Tasks and invalidates review; approval authorizes executing.
- executing: bind a requested current-round Task before work; completion requires plan_report_task_result or explicit Human plan_set_task_status.
- awaiting_round_decision: next-round intent rolls forward; completion requires all current tasks done and a reason when future horizons remain.

Modification beats approval. Never advance on "可以，但是..." style feedback; apply the modification and ask for confirmation again.

Never infer Task completion from ordinary discussion, experiment results, or agent_end. Only a valid bound-Agent completed report or explicit Human done/open instruction changes Completion checkboxes.
