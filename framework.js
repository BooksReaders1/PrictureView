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
        BATCH_SIZE: 8,
        INITIAL_LOAD_COUNT: 3,      // 初始加载图片数量
        PROBE_AHEAD_PAGES: 1,       // 探测阶段向前探测的页数
        CONTINUOUS_BATCH_SIZE: 5,   // 连续加载阶段每批加载的图片数量
        MAX_CONSECUTIVE_FAILURES: 3 // 连续失败次数上限
    };

    // ========== 懒加载状态管理 ==========
    const lazyLoadState = {
        phase: 'initial',           // 当前阶段：'initial', 'probing', 'continuous', 'finished'
        nextToLoad: 4,              // 下一张待加载的图片索引（初始阶段后从第 4 张开始）
        probeTarget: null,          // 当前探测目标页码
        probeLoading: false,        // 探测页是否正在加载
        probeLoaded: false,         // 探测页是否已加载完成
        consecutiveFailures: 0,     // 连续失败计数
        continuousLoading: false,   // 是否正在进行连续加载
        loadingQueue: [],           // 加载队列
        loadingSet: new Set()       // 正在加载的图片集合
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
    // ========== 懒加载核心逻辑 ==========
    
    // 重置懒加载状态
    function resetLazyLoadState() {
        lazyLoadState.phase = 'initial';
        lazyLoadState.nextToLoad = 4;
        lazyLoadState.probeTarget = null;
        lazyLoadState.probeLoading = false;
        lazyLoadState.probeLoaded = false;
        lazyLoadState.consecutiveFailures = 0;
        lazyLoadState.continuousLoading = false;
        lazyLoadState.loadingQueue = [];
        lazyLoadState.loadingSet.clear();
    }

    // 标记图片加载成功
    function markImageLoaded(index) {
        lazyLoadState.loadingSet.delete(index);
        lazyLoadState.consecutiveFailures = 0;
        
        // 如果探测页加载完成
        if (lazyLoadState.probeTarget === index) {
            lazyLoadState.probeLoaded = true;
            lazyLoadState.probeLoading = false;
            // 开始连续加载阶段
            startContinuousLoading();
        }
    }

    // 标记图片加载失败
    function markImageFailed(index) {
        lazyLoadState.loadingSet.delete(index);
        
        // 如果探测页加载失败
        if (lazyLoadState.probeTarget === index) {
            lazyLoadState.probeLoading = false;
            lazyLoadState.consecutiveFailures++;
            
            if (lazyLoadState.consecutiveFailures >= CONFIG.MAX_CONSECUTIVE_FAILURES) {
                lazyLoadState.phase = 'finished';
                showToast('已达到连续失败上限，停止加载');
            } else {
                // 继续探测下一页
                lazyLoadState.probeTarget = lazyLoadState.nextToLoad++;
                if (lazyLoadState.probeTarget <= state.totalPages) {
                    triggerProbe();
                }
            }
        }
    }

    // 触发探测阶段
    function triggerProbe() {
        if (lazyLoadState.phase !== 'probing') return;
        if (lazyLoadState.probeLoading) return;
        
        const probeIndex = lazyLoadState.probeTarget;
        if (!probeIndex || probeIndex > state.totalPages) {
            lazyLoadState.phase = 'finished';
            return;
        }
        
        const container = document.getElementById(`page-${probeIndex}`);
        if (!container) return;
        
        const img = container.querySelector('img');
        if (!container.classList.contains('loaded') && !container.querySelector('canvas') && img && img.getAttribute('data-loading') !== 'true') {
            lazyLoadState.probeLoading = true;
            lazyLoadState.loadingSet.add(probeIndex);
            if (state.type && sources[state.type]) {
                sources[state.type].loadPage(probeIndex);
            }
        } else {
            // 如果已经加载过，直接视为探测成功
            lazyLoadState.probeLoaded = true;
            startContinuousLoading();
        }
    }

    // 开始连续加载阶段
    function startContinuousLoading() {
        if (lazyLoadState.continuousLoading || lazyLoadState.phase !== 'probing') return;
        
        lazyLoadState.phase = 'continuous';
        lazyLoadState.continuousLoading = true;
        loadNextBatch();
    }

    // 加载下一批图片
    function loadNextBatch() {
        if (lazyLoadState.phase !== 'continuous') return;
        if (lazyLoadState.consecutiveFailures >= CONFIG.MAX_CONSECUTIVE_FAILURES) {
            lazyLoadState.phase = 'finished';
            return;
        }
        
        const startIndex = lazyLoadState.nextToLoad;
        if (startIndex > state.totalPages) {
            lazyLoadState.phase = 'finished';
            lazyLoadState.continuousLoading = false;
            return;
        }
        
        const endIndex = Math.min(startIndex + CONFIG.CONTINUOUS_BATCH_SIZE - 1, state.totalPages);
        const batch = [];
        
        for (let i = startIndex; i <= endIndex; i++) {
            if (!lazyLoadState.loadingSet.has(i)) {
                batch.push(i);
                lazyLoadState.loadingSet.add(i);
            }
        }
        
        if (batch.length === 0) {
            lazyLoadState.continuousLoading = false;
            return;
        }
        
        lazyLoadState.nextToLoad = endIndex + 1;
        
        // 批量加载
        batch.forEach(index => {
            const container = document.getElementById(`page-${index}`);
            if (container) {
                const img = container.querySelector('img');
                if (!container.classList.contains('loaded') && !container.querySelector('canvas') && img && img.getAttribute('data-loading') !== 'true') {
                    if (state.type && sources[state.type]) {
                        sources[state.type].loadPage(index);
                    }
                }
            }
        });
        
        // 等待当前批次加载完成后继续下一批
        const checkBatchComplete = setInterval(() => {
            const allLoadedOrFailed = batch.every(index => {
                const container = document.getElementById(`page-${index}`);
                return container && (container.classList.contains('loaded') || container.querySelector('.error'));
            });
            
            if (allLoadedOrFailed) {
                clearInterval(checkBatchComplete);
                if (lazyLoadState.phase === 'continuous' && lazyLoadState.nextToLoad <= state.totalPages) {
                    loadNextBatch();
                } else {
                    lazyLoadState.continuousLoading = false;
                    if (lazyLoadState.nextToLoad > state.totalPages) {
                        lazyLoadState.phase = 'finished';
                    }
                }
            }
        }, 100);
    }

    // 处理滚动时的懒加载
    function handleScrollLazyLoad() {
        const visiblePages = getVisiblePages();
        if (visiblePages.length === 0) return;
        
        const currentPage = Math.min(...visiblePages);
        
        // 初始阶段：只加载前 3 张
        if (lazyLoadState.phase === 'initial') {
            const initialEnd = Math.min(CONFIG.INITIAL_LOAD_COUNT, state.totalPages);
            for (let i = 1; i <= initialEnd; i++) {
                const container = document.getElementById(`page-${i}`);
                if (!container) continue;
                const img = container.querySelector('img');
                if (!container.classList.contains('loaded') && !container.querySelector('canvas') && img && img.getAttribute('data-loading') !== 'true') {
                    if (state.type && sources[state.type]) {
                        sources[state.type].loadPage(i);
                    }
                }
            }
            
            // 初始加载完成后进入探测阶段
            if (state.loadedCount >= CONFIG.INITIAL_LOAD_COUNT || state.loadedCount >= state.totalPages) {
                lazyLoadState.phase = 'probing';
                lazyLoadState.probeTarget = lazyLoadState.nextToLoad;
                if (lazyLoadState.probeTarget <= state.totalPages) {
                    triggerProbe();
                } else {
                    lazyLoadState.phase = 'finished';
                }
            }
        }
        // 探测阶段：用户滚动时触发探测
        else if (lazyLoadState.phase === 'probing') {
            // 检查是否需要更新探测目标（用户滚动到接近已加载区域）
            const lastLoadedPage = Array.from(document.querySelectorAll('.page-wrapper.loaded'))
                .map(el => parseInt(el.id.replace('page-', '')))
                .reduce((max, val) => Math.max(max, val), 0);
            
            if (currentPage >= lastLoadedPage - 2 && !lazyLoadState.probeLoading && !lazyLoadState.probeLoaded) {
                triggerProbe();
            }
        }
        // 连续加载阶段：自动批量加载（由 loadNextBatch 自动进行）
        else if (lazyLoadState.phase === 'continuous') {
            // 连续加载是自动进行的，不需要额外触发
            // 但如果因为错误停止了，可以尝试恢复
            if (!lazyLoadState.continuousLoading && lazyLoadState.nextToLoad <= state.totalPages) {
                startContinuousLoading();
            }
        }
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
        
        // 重置懒加载状态
        resetLazyLoadState();

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
        // 使用新的懒加载逻辑
        handleScrollLazyLoad();
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
        init,
        markImageLoaded,
        markImageFailed
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
