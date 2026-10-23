# W0 工程收口与 M0 交接

日期：2026-10-23。工作目录 E:/git/dgo-hub，分支 feat/alpha1-implementation。

## 结论

W0 各任务与整体评审已执行。最终统一修复通过了大部分复审，**仍有一项 Important：W0-R1（非真实引用的前导空白绕过）**，作为 M0 Task0 的第一前置承接，独立提交并接受 Sol 验证；尚未将 W0 写成全部无遗留批准。

用户已授权先完成本地实现。M0 开始版本化迁移与身份隔离实施；现场 IdP/真实来源/批准/observed lock/Golden Consumer 仍缺失，48 项产品验收保持 NOT_RUN，正式阶段退出保持 BLOCKED。

## 已有证据与边界

| 项目 | 结果 / 身份 |
|---|---|
| 依赖升级 | Vitest/mocker4.1.12；tinypool 已移除；production dependency 图保持原样 |
| 最终 Windows | 6文件/85 tests；typecheck/build/test exit0；代码树对应90f3776605b91ebd9729902c6fac0dd366b08ab2 |
| 最终 Linux | Node24.22.1、Vitest4.1.12；31 passed/1 Windows-only skip；源码摘要在留存证据中 |
| 依赖审计 | full与omit-dev均0，限保存时间点 |
| 复审 | I1/I2/I4/M1/M2 ADDRESSED；I3因W0-R1仍未关闭 |
| 文件身份 | BigInt dev/ino，真实NTFS独立文件/硬链接回归；保留路径安全检查 |
| 运行证据范围 | source suite、编译及专用内存路径探针各自记录；没有声称真实CLI/现场运行已验证 |
| 资源限制 | 容器名称留存、完整ID未留存；临时目录递归删除被policy拒绝，已保留，不伪称完整清理证明 |

Hermes v0.22.1 为用户报告的其他机器安装版本；实际构建、Profile和握手未观察。

## 下一任务的明确前置

1. M0 Task0 先修复 W0-R1：共享scheme判断与schema使用同样trim语义；consumer/source owner/approval带空白、大小写与三种非真实scheme均拒绝，合法引用和synthetic结构helper继续成立。
2. 该修正先单独提交，再完成真实隔离PostgreSQL上的版本化runner、失败回滚、并发与历史迁移完整性验证。
3. GPT-6 Luna实现，GPT-6.1 Sol独立review；用户无需再次批准本地任务。M0正式验收仍由原阶段门禁决定。

## 可审阅文件

- [整体评审](reviews/w0-final-review.md)
- [最终定向复审](reviews/w0-final-fix-review.md)
- [修复与测试报告](w0-final-fix-report.md)
- [安全留存日志与摘要](w0-final-fix-evidence/)
- [全部执行裁定](w0-execution-rulings.md)
- [M0实施细节](../../plans/2026-10-23-alpha1-m0-identity-isolation-implementation-plan.md)
