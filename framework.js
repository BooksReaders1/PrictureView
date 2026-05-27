/**
 * framework.js - 通用页面框架
 * 根据 URL 参数 type 决定使用哪个图片源逻辑
 * 
 * 扩展性说明：
 * 1. 新增图片源时，创建新的 source-xxx.js 文件
 * 2. 在 sources 对象中注册新的 source
 * 3. 在 HTML 中添加对应的 drawer-item 菜单项（可选）
 */

(function() {
    'use strict';

    // ========== 全局状态 ==========
    const state = {
        type: '',           // 图片源类型：'pixiv' 或 'JM'
        id: '',             // 当前作品/漫画 ID
        totalPages: 0,      // 总页数
        loadedCount: 0,     // 已加载页数
        hasShownEndMessage: false,
        hasTriggeredDownload: false,
        imageUrls: [],      // 存储图片 URLs（pixiv 用）
        iosZipBlob: null,
        iosZipUrl: null
    };

    // 配置常量
    const CONFIG = {
        MAX_PAGES: 100,
        CONCURRENT_LOAD: 8,
        BATCH_SIZE: 8
    };

    // ========== Source 注册表 ==========
    // 每个 source 必须实现以下接口：
    // - init(): 初始化，解析 URL 参数，设置 state.id 和 state.totalPages
    // - createPageElement(index): 创建页面元素
    // - loadPage(index, retryCount): 加载指定页面的图片
    // - downloadCurrent(): 下载当前可见的图片
    // - downloadAll(): 下载所有图片
    // - switchTo(newId): 切换到新的 ID
    const sources = {};

    // 注册图片源
    function registerSource(name, sourceImpl) {
        sources[name] = sourceImpl;
    }

    // ========== 工具函数 ==========
    function $(selector) {
        return document.querySelector(selector);
    }

    function showToast(message, duration = 3000) {
        const toast = $('#toast');
        if (!toast) return;
        toast.textContent = message;
        toast.classList.add('show');
        if (window.toastTimeout) clearTimeout(window.toastTimeout);
        window.toastTimeout = setTimeout(() => {
            toast.classList.remove('show');
        }, duration);
    }

    function showLoading(container) {
        if (container.querySelector('.loading') || container.querySelector('.error') || container.querySelector('canvas') || container.querySelector('.display-image:not(.source-image)')) {
            return;
        }
        container.innerHTML = '<div class="loading">加载中</div>';
    }

    function showError(container, retryCallback) {
        const loadingEl = container.querySelector('.loading');
        if (loadingEl) loadingEl.remove();
        
        if (container.querySelector('.error')) return;
        
        const errorEl = document.createElement('div');
        errorEl.className = 'error';
        errorEl.textContent = '加载失败，点击重试';
        container.appendChild(errorEl);
        
        if (retryCallback) {
            errorEl.addEventListener('click', retryCallback);
        }
    }

    function clearLoadingState(container) {
        const loadingEl = container.querySelector('.loading');
        if (loadingEl) loadingEl.remove();
    }

    function getVisiblePages() {
        const pages = [];
        const viewportTop = window.scrollY + window.innerHeight / 2;
        document.querySelectorAll('.page-wrapper').forEach((wrapper, index) => {
            const rect = wrapper.getBoundingClientRect();
            const wrapperTop = rect.top + window.scrollY;
            const wrapperBottom = wrapperTop + rect.height;
            if (wrapperTop <= viewportTop && wrapperBottom >= viewportTop) {
                pages.push(index + 1);
            }
        });
        return pages;
    }

    function updatePageInfo() {
        const pageInfo = $('#pageInfo');
        const visiblePages = getVisiblePages();
        if (visiblePages.length > 0) {
            const firstVisible = Math.min(...visiblePages);
            pageInfo.textContent = `${firstVisible} / ${state.totalPages || '?'}`;
        }
    }

    // ========== 悬浮窗和抽屉功能 ==========
    function initFloatingWindow() {
        const floatingBtn = $('#floatingBtn');
        const drawer = $('#drawer');
        const drawerOverlay = $('#drawerOverlay');
        const downloadItem = $('#downloadItem');
        const downloadAllItem = $('#downloadAllItem');
        const hideFloatingBtnItem = $('#hideFloatingBtnItem');
        const switchContentItem = $('#switchContentItem');
        const switchContentInputContainer = $('#switchContentInputContainer');
        const switchContentInput = $('#switchContentInput');
        const confirmSwitchBtn = $('#confirmSwitchBtn');
        const iosDownloadContainer = $('#iosDownloadContainer');
        const manualDownloadBtn = $('#manualDownloadBtn');

        let isDragging = false;
        let startX, startY, initialLeft, initialTop;

        // 初始化时隐藏手动下载容器
        iosDownloadContainer.classList.remove('show');

        // 打开抽屉
        floatingBtn.addEventListener('click', () => {
            drawer.classList.add('show');
            drawerOverlay.classList.add('show');
        });

        // 关闭抽屉
        function closeDrawer() {
            drawer.classList.remove('show');
            drawerOverlay.classList.remove('show');
            switchContentInputContainer.classList.remove('show');
            if (!state.hasTriggeredDownload) {
                iosDownloadContainer.classList.remove('show');
            }
        }

        // 点击遮罩层关闭抽屉
        drawerOverlay.addEventListener('click', () => {
            if (state.hasTriggeredDownload && iosDownloadContainer.classList.contains('show')) {
                return;
            }
            closeDrawer();
        });

        // 拖拽功能
        floatingBtn.addEventListener('mousedown', (e) => {
            isDragging = false;
            startX = e.clientX;
            startY = e.clientY;
            const rect = floatingBtn.getBoundingClientRect();
            initialLeft = rect.left;
            initialTop = rect.top;

            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', onMouseUp);
        });

        function onMouseMove(e) {
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;

            if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
                isDragging = true;
            }

            floatingBtn.style.left = `${initialLeft + dx}px`;
            floatingBtn.style.top = `${initialTop + dy}px`;
        }

        function onMouseUp() {
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);

            if (isDragging) {
                const clickHandler = (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    floatingBtn.removeEventListener('click', clickHandler);
                };
                floatingBtn.addEventListener('click', clickHandler, { once: true });
            }
        }

        // 下载当前图片
        downloadItem.addEventListener('click', () => {
            if (state.type && sources[state.type]) {
                sources[state.type].downloadCurrent();
            }
        });

        // 下载所有图片
        downloadAllItem.addEventListener('click', async () => {
            if (state.type && sources[state.type]) {
                await sources[state.type].downloadAll();
            }
        });

        // iOS 非 Safari 浏览器手动下载按钮点击事件
        manualDownloadBtn.addEventListener('click', () => {
            if (state.iosZipBlob && state.iosZipUrl) {
                const a = document.createElement('a');
                a.href = state.iosZipUrl;
                const fileName = state.type === 'pixiv' ? `pixiv_${state.id}.zip` : `漫画${state.id}.zip`;
                a.download = fileName;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                showToast('下载已触发，请查看浏览器下载提示');
            } else {
                showToast('ZIP 文件尚未生成，请先点击下载菜单');
            }
        });

        // 隐藏悬浮窗
        hideFloatingBtnItem.addEventListener('click', () => {
            closeDrawer();
            floatingBtn.classList.add('hidden');
        });

        // 切换内容 - 显示输入框
        switchContentItem.addEventListener('click', () => {
            switchContentInputContainer.classList.add('show');
            switchContentInput.focus();
        });

        // 确认切换
        confirmSwitchBtn.addEventListener('click', () => {
            const newId = switchContentInput.value.trim();
            if (newId) {
                switchTo(newId);
                closeDrawer();
            } else {
                showToast('请输入 ID');
            }
        });

        // 回车确认切换
        switchContentInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                const newId = switchContentInput.value.trim();
                if (newId) {
                    switchTo(newId);
                    closeDrawer();
                } else {
                    showToast('请输入 ID');
                }
            }
        });

        // 更新日志功能
        const changelogItem = $('#changelogItem');
        if (changelogItem) {
            changelogItem.addEventListener('click', () => {
                showChangelogModal();
            });
        }
    }

    // ========== 更新日志功能 ==========
    var CHANGELOG_DATA = [
        {
            date: "2026-05-27 14:54:00",
            title: "🎉 新增更新日志悬浮窗功能",
            description: "在左侧抽屉菜单中添加更新日志入口，点击后弹出悬浮窗展示所有历史更新记录，方便用户追踪项目演进历程"
        },
        {
            date: "2026-05-27 14:00:00",
            title: "🏗️ 项目重构完成 - 模块化架构升级",
            description: "完成核心架构重构：将通用页面框架与图片源逻辑完全分离，采用模块化设计，大幅提升代码可维护性和扩展性"
        },
        {
            date: "2026-05-27 13:30:00",
            title: "📦 实现 Source 注册表机制",
            description: "新增图片源注册表系统，支持动态注册新的图片源模块，无需修改核心框架代码即可扩展新功能"
        },
        {
            date: "2026-05-27 13:00:00",
            title: "🔄 统一 URL 参数处理逻辑",
            description: "重构 URL 参数解析机制，通过 type 参数自动路由到对应的图片源模块，支持 pixiv 和 JM 两种图片源"
        },
        {
            date: "2026-05-27 12:30:00",
            title: "🎨 优化悬浮窗和抽屉 UI 交互",
            description: "改进悬浮窗拖拽体验，优化抽屉动画效果，增加遮罩层交互，提升整体用户体验"
        },
        {
            date: "2026-05-27 12:00:00",
            title: "📱 增强移动端适配",
            description: "优化响应式布局，调整头部高度和字体大小，确保在不同屏幕尺寸下都有良好的显示效果"
        },
        {
            date: "2026-05-27 11:30:00",
            title: "⚡ 实现并发加载和滚动懒加载",
            description: "引入并发加载机制（默认 8 个并发），实现滚动触发懒加载，大幅提升大图列表的加载性能"
        },
        {
            date: "2026-05-27 11:00:00",
            title: "💾 添加 ZIP 打包下载功能",
            description: "集成 JSZip 库，实现将所有图片打包为 ZIP 文件下载的功能，支持 iOS 非 Safari 浏览器的手动下载模式"
        },
        {
            date: "2026-05-27 10:30:00",
            title: "🛡️ 增强错误处理和重试机制",
            description: "完善图片加载失败的处理逻辑，提供友好的错误提示和点击重试功能，避免页面卡死"
        },
        {
            date: "2026-05-27 10:00:00",
            title: "🚀 初始重构版本发布",
            description: "基于原有独立 HTML 文件进行重构，拆分为 framework.js 核心框架 + source-pixiv.js + source-jm.js 模块化结构，消除代码重复，建立统一的扩展接口"
        }
    ];

    function showChangelogModal() {
        try {
            const modalOverlay = document.getElementById('changelog-modal-overlay');
            const modalBody = document.getElementById('changelog-modal-body');

            if (!modalOverlay || !modalBody) {
                console.error('更新日志悬浮窗元素未找到');
                return;
            }

            // 生成更新日志 HTML
            let html = '';
            CHANGELOG_DATA.forEach((entry, index) => {
                const isNewTag = index === 0 ? '<span class="changelog-new-tag">NEW</span>' : '';
                html += `
                    <div class="changelog-entry">
                        <div class="changelog-entry-header">
                            <span class="changelog-entry-date">${escapeHtml(entry.date)}${isNewTag}</span>
                        </div>
                        <div class="changelog-entry-title">${escapeHtml(entry.title)}</div>
                        <div class="changelog-entry-description">${escapeHtml(entry.description)}</div>
                    </div>
                `;
            });

            modalBody.innerHTML = html;
            modalOverlay.classList.add('show');
        } catch (error) {
            console.error('显示更新日志失败:', error);
        }

        // 关闭抽屉
        const drawer = document.getElementById('drawer');
        const drawerOverlay = document.getElementById('drawerOverlay');
        if (drawer && drawer.classList.contains('show')) {
            drawer.classList.remove('show');
        }
        if (drawerOverlay && drawerOverlay.classList.contains('show')) {
            drawerOverlay.classList.remove('show');
        }
    }

    function closeChangelogModal(event) {
        if (event.target.id === 'changelog-modal-overlay') {
            const modalOverlay = document.getElementById('changelog-modal-overlay');
            modalOverlay.classList.remove('show');
        }
    }

    function closeChangelogModalBtn() {
        const modalOverlay = document.getElementById('changelog-modal-overlay');
        modalOverlay.classList.remove('show');
    }

    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    // ========== 核心功能 ==========
    function switchTo(newId) {
        const url = new URL(window.location.href);
        if (state.type === 'pixiv') {
            url.searchParams.set('pid', newId);
        } else if (state.type === 'JM') {
            url.searchParams.set('id', newId);
        }
        window.history.pushState({}, '', url);

        state.id = newId;

        // 更新标题
        const titlePrefix = state.type === 'pixiv' ? '作品 ID' : '漫画 ID';
        $('#contentTitle').textContent = `${titlePrefix}: ${state.id}`;

        // 清空容器
        const container = $('#contentContainer');
        container.innerHTML = '';

        // 重置状态
        state.loadedCount = 0;
        state.hasShownEndMessage = false;
        state.imageUrls = [];
        state.hasTriggeredDownload = false;

        if (state.iosZipUrl) {
            URL.revokeObjectURL(state.iosZipUrl);
            state.iosZipUrl = null;
        }
        if (state.iosZipBlob) {
            state.iosZipBlob = null;
        }

        const iosDownloadContainer = $('#iosDownloadContainer');
        if (iosDownloadContainer) {
            iosDownloadContainer.classList.remove('show');
        }

        // 重新初始化
        if (state.type && sources[state.type]) {
            sources[state.type].init();
        }

        window.scrollTo(0, 0);
    }

    function loadPagesAroundCurrentPage() {
        // 如果当前 source 有自己的 loadPagesAroundCurrentPage 实现，则使用它
        if (state.type && sources[state.type] && sources[state.type].loadPagesAroundCurrentPage) {
            sources[state.type].loadPagesAroundCurrentPage();
            return;
        }
        
        // 否则使用默认的懒加载逻辑
        const visiblePages = getVisiblePages();
        if (visiblePages.length === 0) return;
        const currentPage = Math.min(...visiblePages);
        
        for (let i = currentPage; i < currentPage + CONFIG.BATCH_SIZE && i <= state.totalPages; i++) {
            const container = document.getElementById(`page-${i}`);
            if (!container) continue;
            const img = container.querySelector('img');
            if (!container.classList.contains('loaded') && !container.querySelector('canvas') && img && img.getAttribute('data-loading') !== 'true') {
                if (state.type && sources[state.type]) {
                    sources[state.type].loadPage(i);
                }
            }
        }
    }

    function setupScrollListener() {
        let scrollTimeout;
        let toastTimer = null;

        window.addEventListener('scroll', () => {
            updatePageInfo();

            const scrollTop = window.scrollY || window.pageYOffset;
            const windowHeight = window.innerHeight;
            const documentHeight = document.documentElement.scrollHeight;

            if (scrollTop + windowHeight >= documentHeight - 10) {
                if (!state.hasShownEndMessage) {
                    state.hasShownEndMessage = true;
                    showToast('已经到底了');
                    if (toastTimer) clearTimeout(toastTimer);
                    toastTimer = setTimeout(() => {
                        state.hasShownEndMessage = false;
                    }, 3000);
                }
            } else {
                state.hasShownEndMessage = false;
            }

            clearTimeout(scrollTimeout);
            scrollTimeout = setTimeout(() => {
                loadPagesAroundCurrentPage();
            }, 100);
        });
    }

    // ========== 初始化 ==========
    function init() {
        // 解析 URL 参数
        const urlParams = new URLSearchParams(window.location.search);
        state.type = urlParams.get('type') || '';

        if (!state.type) {
            $('#contentTitle').textContent = '请指定 type 参数';
            showToast('请在 URL 中添加 ?type=pixiv 或 ?type=JM 参数');
            return;
        }

        // 规范化 type 参数（支持大小写）
        const normalizedType = state.type.toLowerCase();
        let actualType = '';
        
        // 查找匹配的来源（不区分大小写）
        for (const sourceName of Object.keys(sources)) {
            if (sourceName.toLowerCase() === normalizedType) {
                actualType = sourceName;
                break;
            }
        }

        // 检查是否有对应的 source
        if (!actualType || !sources[actualType]) {
            $('#contentTitle').textContent = `未知的类型：${state.type}`;
            showToast(`不支持的类型：${state.type}。支持的类型：${Object.keys(sources).join(', ')}`);
            return;
        }
        
        // 使用实际的来源名称（保持注册时的大小写）
        state.type = actualType;

        // 初始化悬浮窗和抽屉
        initFloatingWindow();

        // 设置滚动监听
        setupScrollListener();

        // 调用对应 source 的 init 方法
        sources[state.type].init();
    }

    // ========== 导出 API ==========
    window.Framework = {
        state,
        CONFIG,
        registerSource,
        showToast,
        showLoading,
        showError,
        clearLoadingState,
        updatePageInfo,
        getVisiblePages,
        switchTo,
        init
    };

    // 延迟初始化：等待 DOMContentLoaded 并且给 source 脚本时间注册
    function delayedInit() {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', function() {
                // DOM 加载完成后，再等一小段时间确保所有 source 脚本已执行
                setTimeout(init, 10);
            });
        } else {
            // DOM 已就绪，但还需要给 source 脚本一点时间注册
            setTimeout(init, 10);
        }
    }

    // 启动延迟初始化
    delayedInit();
})();
