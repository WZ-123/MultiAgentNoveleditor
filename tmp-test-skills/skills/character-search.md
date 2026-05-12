# 角色网络搜索策略

## 文化圈检测
根据作品名判断文化圈：east-asian-cn / east-asian-jp / east-asian-kr / western-en / global。

## 搜索源优先级
- 中文作品：萌娘百科 > Bing > 百度百科
- 日文作品：Wikipedia(ja) > Pixiv > DuckDuckGo
- 韩文作品：Namu Wiki > DuckDuckGo
- 英文作品：Wikipedia(en) > DuckDuckGo

## 查询构建
角色名 + 作品名 + 作品原名（如果有）。

## 回退策略
主要来源无结果 → 相邻文化圈 → 全局 DuckDuckGo。

## 合并规则
保留小说已有值，网络数据作为参考追加（括号标注原作设定）。