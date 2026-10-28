# Alpha1 M0 审批与环境就绪清单

本判定器检查入口声明的格式、完整性、一致性与批准记录，不访问 IdP、来源、内部服务、备份或消费者，也不解析密钥。`PASS` 的 `scope=entry-input-validation` 仅表示入口输入符合规则，不证明实际连接、授权、导入、查询或产品验收。

## 批准记录

所有记录引用原合同 `PRD-DGO-HUB-001:v1.0`。平台入口还需 `supplement_ref: PRD-DGO-HUB-001-FIXTURE:v1.0.fixture`，五方批准应确实涵盖两份合同。正式记录须包含 `product`、`architecture`、`data_owner`、`security`、`test` 五个唯一角色，每项为 `APPROVED` 并记录批准人引用和带时区的批准时间。示例为 `REVIEW`，不是批准；两份产品文档的当前状态不由输入声明改变。

## 两级输入

`environment_kind` 仍是 `local_lab` 或 `site`。正式平台入口用 `environment_kind: site` 且明确 `acceptance_level: platform`；正式现场用 `site` 且 `acceptance_level: site` 或省略该字段（旧记录）。`local_lab` 是本地输入，不能当作正式平台验收。正式级别都需实际平台 IdP、租户、时区、身份映射、TLS 主机名、六项内部服务、备份引用，以及不同数据范围的至少两名 sales 和一名 sales_manager 测试身份；身份须不同、属于同一租户并可在实际平台使用。测试账户和业务数据可为合成数据，示例或占位引用不构成实际身份。现场既有 HTTPS、来源、身份和密钥规则继续适用。

平台来源为 `SIMULATED_IMPORT`：填写受控输入、数据合同、版本、字段映射、副本授权与删除合同引用，以及 `INCREMENTAL`、`SOURCE_VERSION`、`tombstone` 和 customer/order 实体集合。不得为导入填写外部 endpoint 或 secret；真实 CRM、订单库和 Hermes 版本不是平台入口要求。现场来源仍需原有只读端点、secret 引用、来源合同和 Hermes 实际版本；数据库需 `read_only: true`。秘密只能使用 `env://`、`secret://` 或 `vault://` 引用，不可放连接密码或 token。

`environment-inputs.example.json` 是旧本地语法示例；`environment-inputs.platform.example.json` 是平台语法示例。它们不提供真实环境、授权或执行证据。实际输入应保存在受控位置。

## 判定

```powershell
npm run check:m0-entry -- --signoffs <批准文件> --environment <环境文件> --expected-kind platform
npm run check:m0-entry -- --signoffs <批准文件> --environment <环境文件> --expected-kind site
```

`platform` 与 `site` 正式判断互不替代；旧现场记录不会自动成为平台记录。正式判断拒绝任一 `example: true`。`--validate-example` 仅检查 schema 语法，不核对期望类型或批准就绪；合法输入退出 0，同时输出 `BLOCKED` 和 `product_ready: false`。无效或不可读输入退出 1；合法但不满足入口条件退出 2。

入口 PASS 不自动通过任何产品验收。平台仍须实际执行模拟导入、授权查询与消费端验证并提供可核验证据；现场真实来源及特定消费者联通另行验收。发布门禁和锁的两级适配属于后续 G2/G3，现有脚本不能证明修正后的平台发布通过。
