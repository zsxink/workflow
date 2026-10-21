# 任务

## TASK-001 — 实现服务端到期判定
- Status: pending
- Requires: REQ-SESSION-001
- Depends-On: none
- Write-Scopes: src/session/**, tests/session/**
- Test-Mode: tdd
- Test-Scopes: tests/session/**
- Test-Commands: app-session-test
- Acceptance: 两个场景对应路径实现，复用认证响应，不删除业务数据

## TASK-002 — 补充场景及边界验证
- Status: pending
- Requires: REQ-SESSION-001
- Depends-On: TASK-001
- Write-Scopes: tests/session/**
- Test-Mode: verification
- Test-Scopes: tests/session/**
- Test-Commands: app-session-test
- Test-Rationale: 独立检查场景和边界覆盖，可补充缺失测试；不得替代 TASK-001 的任务内 TDD。
- Acceptance: 覆盖 SCN-SESSION-001-01、SCN-SESSION-001-02，检查阈值边界、并发更新时间和数据保留
