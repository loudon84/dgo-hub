# Alpha1 M0 审批与环境就绪清单

本清单记录 M0 计划入口所需的合同和批准。此判定器只检查输入格式、字段完整性、相互一致性与批准记录；它不会访问 IdP、CRM、订单源、Hermes、内部服务或备份系统，也不会解析 `secret_ref`。判定器的 `PASS` 只表示入口输入校验通过，不表示网络探测、身份验证、复制授权、删除演练、备份恢复或 Golden Consumer 验收通过。

## 批准记录

合同引用固定为 `PRD-DGO-HUB-001:v1.0`。正式计划记录必须包含以下五种唯一角色，每项记录 `APPROVED`、批准人 `actor_ref` 和带时区的 `approved_at`：

| 角色 | 需确认的范围 | 记录位置 |
|---|---|---|
| `product` | M0 范围、用户流程和验收目标 | `alpha1-signoffs.json` |
| `architecture` | 身份、网络、服务依赖和部署边界 | `alpha1-signoffs.json` |
| `data_owner` | 来源只读授权、字段映射和删除合同 | `alpha1-signoffs.json` |
| `security` | TLS、密钥引用、访问和审计边界 | `alpha1-signoffs.json` |
| `test` | 环境与实际验收输入准备情况 | `alpha1-signoffs.json` |

签署人引用必须指向组织目录中的实际身份。示例文件中的 `REVIEW` 与 `example: true` 不构成批准，不得复制为真实签署记录。

## 环境输入

在环境合同中填写 `environment_kind`、租户、业务时区、IdP、来源列表、身份映射、TLS 主机名、六项内部服务、备份引用和实际 Hermes 版本。来源端点必须只读；PostgreSQL 和 SQL Server 来源必须显式设置 `read_only: true`。秘密只以 `env://`、`secret://` 或 `vault://` 引用表示，合同中不得包含连接密码、令牌或认证查询参数。

`site` 需要 HTTPS IdP 和 REST 来源，以及至少两名不同的 `sales` 测试用户和一名不同的 `sales_manager`。所有测试身份都必须绑定到环境的 `tenant_key`。`local_lab` 可使用明确的合成身份，但不能满足 site readiness。内部服务 URL 的协议按服务类型校验；其 URL 字段不触发网络请求。

使用 `docs/approvals/environment-inputs.example.json` 作为语法示例，并将正式环境输入保存在受控位置。示例值不是实际 IdP、消费者版本、环境地址或批准证据。

## 判定和产品验收

```powershell
npm run check:m0-entry -- --signoffs <批准文件> --environment <环境文件> --expected-kind site
```

正式判定默认拒绝任一 `example: true` 输入。`--validate-example` 仅检查合同语法，命令以 0 表示语法检查操作完成，并输出 `product_ready: false`；它不会给出正式 `PASS`。无效或不可读输入返回 1，合法但不满足入口条件返回 2。

本合同的 `PASS` 不会将产品验收 A-ID 自动标为 `PASS`。真实 CRM/订单输入、Hermes 实际版本、两名销售和一名部门经理的真实用户与已批准证据仍须在现场验收中确认。缺少这些现场材料时，相关产品验收保持 `BLOCKED`。
