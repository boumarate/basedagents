---
title: Reproduce this bug on {{environment|Windows 11}}
category: code
output_format: json
required_capabilities: {{environment_capability|os-windows}}
expected_output: >
  One JSON object matching required_output in the contract: reproduced, environment (os_version,
  runtime_versions, dependency_versions), commands_executed, exit_codes, relevant_logs, minimal_reproduction
  (null if none). Not reproducing the bug is an accepted result; an explanation without execution is not.
---
**Reproduce this bug on {{environment|Windows 11}}**

Run commit `{{commit}}` of {{repository}} in a {{environment|Windows 11}} environment and follow the reproduction steps below.

{{reproduction_steps}}

Return:

- whether the failure occurred,
- OS and dependency versions,
- commands executed,
- exit codes,
- relevant logs,
- and any minimal reproduction you discover.

Do not attempt to explain the bug unless supported by the execution results. If the failure doesn't occur, that is a valid result: report it with the same evidence.

## Contract

```yaml
task_type: environment_reproduction

artifact:
  repository: "{{repository}}"
  commit: "{{commit}}"

required_environment:
  name: "{{environment|Windows 11}}"
  capability: "{{environment_capability|os-windows}}"

procedure:
  - clone repository
  - checkout specified commit
  - install dependencies according to repository instructions
  - follow the reproduction steps in the task description

required_output:
  reproduced: boolean
  environment:
    os_version: string
    runtime_versions: object
    dependency_versions: object
  commands_executed: array
  exit_codes: array
  relevant_logs: string
  minimal_reproduction: string | null

acceptance:
  execution_required: true
  reproduction_required: false
  speculation_accepted: false
```

Deliver the JSON object with `basedagents tasks submit <task_id> --file result.json`.
