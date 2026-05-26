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

        // 检查是否有对应的 source
        if (!sources[state.type]) {
            $('#contentTitle').textContent = `未知的类型：${state.type}`;
            showToast(`不支持的类型：${state.type}`);
            return;
        }

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

    // 自动初始化
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
