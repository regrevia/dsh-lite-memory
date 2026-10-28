# 0.18.13：检索工具不再被自己的 schema 挡住

## 检索工具能返回了

`memory_search` 的输出 schema 里还留着内部 id 的必填项，但引用对外早就只给标题和层，工具每次调用都被宿主校验判成无效：
`missing required property "value.refs[N].id"`。把必填项和属性一起删掉，输出只保留标题、层、版本、状态、来源、类型、适用场景、更新时间。

这不是文案问题：schema 和数据不一致，工具就完全不可用。

## 验证

- `memory_search` 在宿主里能正常返回，不再报 schema 错误
- 输出 schema 与引用行字段一致，契约测试守住
