# 欧美通用层基准测试角色表

轨道：`western-en-general-layer`  
数据文件：`roster-famous-western-acg.json`

每部作品 6 名角色（`latest`×2 + `obscure`×2 + `mid`×2），共 36 人。

## 当前主名单（works）

| 作品 | latest | obscure | mid |
|------|--------|---------|-----|
| 黑袍纠察队 | 祖国人、比利·布彻尔 | 休伊·坎贝尔、星光 | 玄色、梅芙女王 |
| 漫威 | 钢铁侠、蜘蛛侠 | 奇异博士、绯红女巫 | 美国队长、洛基 |
| DC | 蝙蝠侠、超人 | 神奇女侠、闪电侠 | 小丑、哈莉·奎茵 |
| 魔戒 | 弗罗多·巴金斯、甘道夫 | 阿拉贡、莱戈拉斯 | 山姆卫斯·詹吉、咕噜 |
| 哈利波特 | 哈利·波特、赫敏·格兰杰 | 罗恩·韦斯莱、西弗勒斯·斯内普 | 德拉科·马尔福、阿不思·邓布利多 |
| RWBY | Ruby Rose、Weiss Schnee | Blake Belladonna、Yang Xiao Long | Jaune Arc、Pyrrha Nikos |

## 轮换池（pools）

同结构备用角色见 `roster-famous-western-acg.json` 的 `pools` 字段。轮换规则见 [knowledge-base/western-enrichment-benchmark.md](../../knowledge-base/western-enrichment-benchmark.md)。

## 说明

- 本轨测试 **通用层**（Fandom / Wikipedia / Bing），不依赖 BWiki 手游特化。
- 角色名以中文或英文原作常用名为准，与同人小说导入场景一致。
- 改名单后同步更新 `roster-famous-western-acg.json`，并记录 `usedInRun` 避免短期重复。
