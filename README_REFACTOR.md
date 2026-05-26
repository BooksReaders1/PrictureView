# 重构后的项目说明

## 项目结构

```
/workspace
├── index.html          # 统一的页面框架
├── framework.js        # 核心框架逻辑（处理 URL 参数、悬浮窗、抽屉等通用功能）
├── source-pixiv.js     # Pixiv 图片源逻辑
├── source-jm.js        # JM (禁漫) 图片源逻辑
└── README.md           # 本说明文件
```

## 使用方法

### 访问 Pixiv 图片
```
index.html?type=pixiv&pid=作品ID
```
或
```
index.html?type=pixiv&id=作品ID
```

### 访问 JM 漫画
```
index.html?type=JM&id=漫画ID
```

## 扩展性说明

要添加新的图片源，请按以下步骤操作：

### 1. 创建新的 source 文件
创建 `source-xxx.js` 文件，实现以下接口：

```javascript
(function() {
    'use strict';
    
    const F = window.Framework;
    
    // 初始化函数
    async function init() {
        // 解析 URL 参数
        // 设置 F.state.id 和 F.state.totalPages
        // 创建页面元素
        // 开始加载图片
    }
    
    // 创建页面元素
    function createPageElement(index) {
        // 返回包含 img 元素的容器
    }
    
    // 加载单页图片
    function loadPage(index, retryCount = 0) {
        // 加载并显示指定索引的图片
    }
    
    // 下载当前可见的图片
    function downloadCurrent() {
        // 下载当前视野中的图片
    }
    
    // 下载所有图片
    async function downloadAll() {
        // 打包下载所有图片为 ZIP
    }
    
    // 注册到 Framework
    F.registerSource('xxx', {
        init,
        createPageElement,
        loadPage,
        downloadCurrent,
        downloadAll
    });
})();
```

### 2. 在 index.html 中引入新的 source 文件
```html
<script src="source-xxx.js"></script>
```

### 3. 使用新的 type 参数访问
```
index.html?type=xxx&id=资源ID
```

## Framework API

框架提供了以下全局 API 供 source 模块使用：

- `Framework.state` - 全局状态对象
  - `type` - 当前图片源类型
  - `id` - 当前资源 ID
  - `totalPages` - 总页数
  - `loadedCount` - 已加载页数
  - `imageUrls` - 图片 URL 数组（pixiv 用）
  
- `Framework.CONFIG` - 配置常量
  - `MAX_PAGES` - 最大页数（默认 100）
  - `CONCURRENT_LOAD` - 并发加载数（默认 8）
  
- `Framework.registerSource(name, impl)` - 注册新的图片源
  
- `Framework.showToast(message, duration)` - 显示提示消息
  
- `Framework.showLoading(container)` - 显示加载状态
  
- `Framework.showError(container, retryCallback)` - 显示错误状态
  
- `Framework.clearLoadingState(container)` - 清除加载状态
  
- `Framework.updatePageInfo()` - 更新页码信息
  
- `Framework.getVisiblePages()` - 获取当前可见的页码列表
  
- `Framework.switchTo(newId)` - 切换到新的资源 ID

## 代码设计原则

1. **分离关注点**：页面框架与图片源逻辑完全分离
2. **统一接口**：所有 source 模块实现相同的接口
3. **易于扩展**：添加新 source 只需创建新文件并注册
4. **复用代码**：通用功能（悬浮窗、抽屉、滚动加载等）在 framework.js 中实现一次

## 与原项目的区别

| 原项目 | 重构后 |
|--------|--------|
| TestPicture: 独立的 HTML 文件 | source-jm.js + framework.js + index.html |
| pictureForP: 独立的 HTML 文件 | source-pixiv.js + framework.js + index.html |
| 代码重复严重 | 通用代码只写一次 |
| 难以维护 | 易于维护和扩展 |
