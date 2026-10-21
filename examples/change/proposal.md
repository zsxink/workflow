# 空闲会话到期

示例范围授权由运行时记录，本文本不等于真实用户授权。

## Problem
用户离开设备后，原会话长期保持可用。

## Goals
在配置的空闲时长到达后拒绝继续访问受保护资源，并要求重新认证。

## Scope
增加服务端空闲到期判定及重新认证响应，空闲时长由既有配置提供。

## Non-goals
不新增登录方式，不修改用户业务数据，不引入多设备会话管理。

## Acceptance
SCN-SESSION-001-01、SCN-SESSION-001-02 和 SCN-SESSION-001-03 通过。

## Rules
- RULE-001: 认证入口实施到期判定，由三个会话场景及独立审查核对
- RULE-002: 到期不删除业务数据，由 SCN-SESSION-001-01 和 SCN-SESSION-001-03 核对

## Open questions
none
