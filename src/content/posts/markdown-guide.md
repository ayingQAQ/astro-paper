---
title: "Markdown 使用指南"
author: Wenying
pubDatetime: 2026-10-29T08:35:00Z
description: "Markdown 常用语法速查：标题、段落、列表、链接、图片、引用、代码和表格。"
tags:
  - Markdown
  - 写作
featured: true
draft: false
hideEditPost: true
---

## 标题

`#` 后加一个空格，支持一至六级标题。博客标题由页面显示，正文通常从二级标题开始。

```markdown
# 一级标题

## 二级标题

### 三级标题

#### 四级标题

##### 五级标题

###### 六级标题
```

## 段落与换行

段落之间留一个空行。段内强制换行可以在行末加两个空格，或一个反斜杠。

```markdown
第一段。

第二段。

这一行末尾有反斜杠。\
下一行。
```

## 粗体、斜体、删除线

| 写法           | 效果         |
| -------------- | ------------ |
| `**粗体**`     | **粗体**     |
| `*斜体*`       | _斜体_       |
| `***粗斜体***` | _**粗斜体**_ |
| `~~删除线~~`   | ~~删除线~~   |

## 列表

### 无序列表

```markdown
- 第一项
- 第二项
  - 子项
  - 子项
```

- 第一项
- 第二项
  - 子项
  - 子项

### 有序列表

```markdown
1. 写文章
2. 检查预览
3. 发布
```

1. 写文章
2. 检查预览
3. 发布

### 任务列表

```markdown
- [x] 已完成
- [ ] 未完成
```

- [x] 已完成
- [ ] 未完成

## 链接

```markdown
[博客首页](https://blog.pwbing.com/)
[关于](/about/)
```

[博客首页](https://blog.pwbing.com/) · [关于](/about/)

重复使用同一个地址时，可以用引用式链接：

```markdown
[首页][home]

[home]: https://blog.pwbing.com/
```

## 图片

```markdown
![图片说明](/images/example.webp)
```

将示例地址换成真实图片地址。本站后台支持上传、粘贴和拖入图片，会自动插入对应语法。

## 引用

```markdown
> 一段引用。
>
> 引用中的第二段。
>
> > 嵌套引用。
```

> 一段引用。
>
> 引用中的第二段。
>
> > 嵌套引用。

## 行内代码

用一对英文反引号包住内容：

```markdown
运行 `pnpm dev`，编辑 `example.md`。
```

运行 `pnpm dev`，编辑 `example.md`。

## 代码块

三枚反引号围住多行代码，后面可以标注语言：

````markdown
```javascript
const message = "Hello, Markdown!";
console.log(message);
```
````

效果：

```javascript
const message = "Hello, Markdown!";
console.log(message);
```

常用语言标记：`javascript`、`typescript`、`python`、`bash`、`json`、`html`。展示代码围栏本身时，外层使用四枚反引号。

## 表格

```markdown
| 左对齐 |  居中  | 右对齐 |
| :----- | :----: | -----: |
| 内容 A | 内容 B |    100 |
| 内容 C | 内容 D |    200 |
```

| 左对齐 |  居中  | 右对齐 |
| :----- | :----: | -----: |
| 内容 A | 内容 B |    100 |
| 内容 C | 内容 D |    200 |

单元格里需要显示竖线时，写成 `\|`。

## 分隔线

单独一行写 `---`，前后留空行：

```markdown
上面的内容。

---

下面的内容。
```

---

## 转义符号

在符号前加反斜杠，避免触发格式：

```markdown
\*不是斜体\*
\# 不是标题
```

\*不是斜体\*

\# 不是标题

## 折叠内容

使用 HTML 的 `<details>` 和 `<summary>`。折叠区域里的 Markdown 前后留空行：

````markdown
<details>
<summary>点击展开</summary>

这里可以写 **粗体**、列表和代码块。

- 第一项
- 第二项

```javascript
console.log("Hello!");
```

</details>
````

<details>
<summary>点击展开</summary>

这里可以写 **粗体**、列表和代码块。

- 第一项
- 第二项

```javascript
console.log("Hello!");
```

</details>

默认展开时，写成 `<details open>`。这是 HTML 写法，需要平台允许 HTML；本站文章页支持，后台预览暂不渲染 HTML。

## 文章信息

Markdown 文件顶部的 Frontmatter 用于设置标题、日期和标签：

```yaml
---
title: "文章标题"
author: Wenying
description: "文章摘要"
pubDatetime: 2026-10-29T08:00:00Z
tags:
  - Markdown
draft: false
---
```

`Z` 表示 UTC 时间。使用本站后台时，在标题栏和「文章设置」填写即可，**不要把 Frontmatter 粘进正文**。

## 扩展语法

表格、任务列表和删除线属于常见扩展。数学公式、Mermaid 流程图和脚注需要相应支持，不是所有 Markdown 编辑器都能渲染。
